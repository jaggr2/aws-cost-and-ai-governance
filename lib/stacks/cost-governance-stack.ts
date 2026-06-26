import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy, CfnStackSet, aws_budgets as budgets, aws_organizations as orgs, aws_stepfunctions as sfn, aws_events as events, aws_events_targets as targets } from 'aws-cdk-lib';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Role, ServicePrincipal, PolicyDocument, PolicyStatement, Effect, CompositePrincipal, ArnPrincipal } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays, LogGroup } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { join } from 'path';

export interface CostGovernanceStackProps extends StackProps {
  targetAccountId: string;
  targetOuId?: string;
  stackSetOuIds?: string[];
  monthlyBudgetAmount: number;
  alertThresholdPercent: number;
  notificationEmail: string;
  protectionTagKey: string;
  crossAccountRoleName: string;
}

export class CostGovernanceStack extends Stack {
  constructor(scope: Construct, id: string, props: CostGovernanceStackProps) {
    super(scope, id, props);

    const {
      targetAccountId,
      targetOuId,
      stackSetOuIds,
      monthlyBudgetAmount,
      alertThresholdPercent,
      notificationEmail,
      protectionTagKey,
      crossAccountRoleName,
    } = props;

    const managementAccountId = Stack.of(this).account;
    const region = Stack.of(this).region;

    const scpTargetIds: string[] = [targetAccountId];
    if (targetOuId) scpTargetIds.push(targetOuId);
    const crossAccountTargetIds = [targetAccountId];
    if (targetOuId) crossAccountTargetIds.push(targetOuId);

    // ── Audit Trail Table ──
    const auditTable = new Table(this, 'AuditTrail', {
      partitionKey: { name: 'accountId', type: AttributeType.STRING },
      sortKey: { name: 'stopId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ── SNS Notification Topic ──
    const alertTopic = new Topic(this, 'AlertTopic', {
      displayName: 'CostGovernance-Alerts',
      topicName: 'CostGovernanceAlerts',
    });
    alertTopic.addSubscription(new EmailSubscription(notificationEmail));

    // ── SCP: EmergencyLockdown (reactive, attached at 100% budget) ──
    const emergencyLockdown = new orgs.CfnPolicy(this, 'EmergencyLockdown', {
      name: 'CostGovernance-EmergencyLockdown',
      description: 'Reactive SCP — denies compute, storage, AI/ML, and analytics services when budget is exceeded. Attached automatically by budget action.',
      type: 'SERVICE_CONTROL_POLICY',
      content: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'DenyComputeAndStorage',
          Effect: 'Deny',
          Action: [
            'ec2:RunInstances',
            'rds:*',
            's3:CreateBucket',
            'lambda:*',
            'ecs:*',
            'eks:*',
            'sagemaker:*',
            'elasticmapreduce:*',
            'redshift:*',
          ],
          Resource: '*',
        }],
      },
    });

    // ── SCP: NoExpensiveOps (preventive, always attached) ──
    new orgs.CfnPolicy(this, 'NoExpensiveOpsScp', {
      name: 'CostGovernance-NoExpensiveOps',
      description: 'Preventive SCP — blocks expensive instance types, AI/ML services, NAT gateways, and costly commitments.',
      type: 'SERVICE_CONTROL_POLICY',
      content: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyNonTInstanceTypes',
            Effect: 'Deny',
            Action: 'ec2:RunInstances',
            Resource: 'arn:aws:ec2:*:*:instance/*',
            Condition: { StringNotLike: { 'ec2:InstanceType': 't*' } },
          },
          {
            Sid: 'DenyExpensiveAIMLServices',
            Effect: 'Deny',
            Action: [
              'sagemaker:CreateTrainingJob',
              'sagemaker:CreateHyperParameterTuningJob',
              'sagemaker:CreateNotebookInstance',
              'sagemaker:CreateEndpoint',
              'elasticmapreduce:RunJobFlow',
              'redshift:CreateCluster',
              'redshift-serverless:CreateWorkgroup',
            ],
            Resource: '*',
          },
          {
            Sid: 'DenyExpensiveEC2Instances',
            Effect: 'Deny',
            Action: 'ec2:RunInstances',
            Resource: 'arn:aws:ec2:*:*:instance/*',
            Condition: {
              StringNotLike: {
                'ec2:InstanceType': [
                  't3.*', 't3a.*', 't2.*',
                  'm5.large', 'm5.xlarge',
                  'm6i.large', 'm6i.xlarge',
                ],
              },
            },
          },
          {
            Sid: 'DenyExpensiveRDSInstances',
            Effect: 'Deny',
            Action: 'rds:CreateDBInstance',
            Resource: '*',
            Condition: { StringNotLike: { 'rds:DatabaseClass': ['db.t3.*', 'db.t4g.*'] } },
          },
          {
            Sid: 'DenyHighIOPSVolumes',
            Effect: 'Deny',
            Action: 'ec2:CreateVolume',
            Resource: '*',
            Condition: { StringEquals: { 'ec2:VolumeType': ['io2'] } },
          },
          {
            Sid: 'DenyNATGatewayCreation',
            Effect: 'Deny',
            Action: 'ec2:CreateNatGateway',
            Resource: '*',
          },
          {
            Sid: 'DenyExpensiveCommitments',
            Effect: 'Deny',
            Action: [
              'ec2:PurchaseReservedInstancesOffering',
              'ec2:PurchaseScheduledInstances',
              'savingsplans:CreateSavingsPlan',
              'shield:CreateSubscription',
              'aws-marketplace:Subscribe',
              'route53domains:RegisterDomain',
              'route53domains:TransferDomain',
              'outposts:CreateOutpost',
              'bedrock:CreateProvisionedModelThroughput',
              'dynamodb:PurchaseReservedCapacityOfferings',
              'rds:PurchaseReservedDBInstancesOffering',
              'es:PurchaseReservedElasticsearchInstanceOffering',
            ],
            Resource: '*',
          },
        ],
      },
    });

    // ── Budget Action Execution Role ──
    const budgetActionRole = new Role(this, 'BudgetActionRole', {
      assumedBy: new CompositePrincipal(new ServicePrincipal('budgets.amazonaws.com')),
      description: 'Role for AWS Budgets to execute SCP attachment actions',
    });
    budgetActionRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'organizations:AttachPolicy', 'organizations:DetachPolicy',
        'organizations:ListPolicies', 'organizations:ListTargetsForPolicy',
        'organizations:DescribePolicy',
      ],
      resources: ['*'],
    }));

    // ── Cross-account execution role via StackSet ──
    if (stackSetOuIds && stackSetOuIds.length > 0) {
      const executionRoleTemplate = {
        Resources: {
          ExecutionRole: {
            Type: 'AWS::IAM::Role',
            Properties: {
              RoleName: crossAccountRoleName,
              AssumeRolePolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Principal: { AWS: `arn:aws:iam::${managementAccountId}:root` },
                  Action: 'sts:AssumeRole',
                  Condition: {
                    StringEquals: {
                      'sts:ExternalId': 'CostGovernanceCrossAccount',
                    },
                  },
                }],
              },
              ManagedPolicyArns: [
                { 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/PowerUserAccess' },
              ],
              Policies: [{
                PolicyName: 'CostGovernanceExecutionPolicy',
                PolicyDocument: {
                  Version: '2012-10-17',
                  Statement: [
                    {
                      Effect: 'Allow',
                      Action: [
                        'ec2:DescribeInstances', 'ec2:StopInstances', 'ec2:StartInstances',
                        'rds:DescribeDBInstances', 'rds:StopDBInstance', 'rds:StartDBInstance',
                        'rds:DescribeDBClusters', 'rds:StopDBCluster', 'rds:StartDBCluster',
                        'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'ecs:UpdateService',
                        'cloudfront:ListDistributions', 'cloudfront:GetDistribution',
                        'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution',
                        'lambda:ListFunctions', 'lambda:GetFunctionConcurrency',
                        'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency',
                        'elasticloadbalancing:Describe*',
                      ],
                      Resource: '*',
                    },
                  ],
                },
              }],
            },
          },
        },
      };

      new CfnStackSet(this, 'CostGovernanceExecutionRoleStackSet', {
        stackSetName: 'CostGovernanceExecutionRole',
        permissionModel: 'SERVICE_MANAGED',
        autoDeployment: { enabled: true, retainStacksOnAccountRemoval: false },
        capabilities: ['CAPABILITY_NAMED_IAM'],
        stackInstancesGroup: [{
          deploymentTargets: { organizationalUnitIds: stackSetOuIds },
          regions: [region],
        }],
        templateBody: JSON.stringify(executionRoleTemplate),
      });
    }

    // ── Emergency Stop Lambda ──
    const emergencyStopFn = new NodejsFunction(this, 'EmergencyStopLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'lambdas', 'emergency-stop', 'index.ts'),
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 512,
      logGroup: new LogGroup(this, 'EmergencyStopLogGroup', { retention: RetentionDays.ONE_MONTH }),
      environment: {
        AUDIT_TABLE: auditTable.tableName,
        SCP_POLICY_ID: emergencyLockdown.ref,
        SCP_TARGET_IDS: JSON.stringify(scpTargetIds),
        PROTECTION_TAG_KEY: protectionTagKey,
        CROSS_ACCOUNT_ROLE_NAME: crossAccountRoleName,
        TARGET_ACCOUNT_IDS: JSON.stringify(crossAccountTargetIds),
        MANAGEMENT_ACCOUNT_ID: managementAccountId,
      },
      bundling: { minify: true, sourceMap: true },
    });

    auditTable.grantReadWriteData(emergencyStopFn);

    emergencyStopFn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances', 'ec2:StopInstances', 'ec2:StartInstances',
        'ec2:DescribeInstanceStatus',
        'rds:DescribeDBInstances', 'rds:StopDBInstance', 'rds:StartDBInstance',
        'rds:DescribeDBClusters', 'rds:StopDBCluster', 'rds:StartDBCluster',
        'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'ecs:UpdateService',
        'cloudfront:ListDistributions', 'cloudfront:GetDistribution',
        'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution',
        'lambda:ListFunctions', 'lambda:GetFunctionConcurrency',
        'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency',
        'elasticloadbalancing:Describe*',
        'organizations:AttachPolicy', 'organizations:DetachPolicy',
        'organizations:DescribePolicy', 'organizations:ListTargetsForPolicy',
        'sns:Publish', 'sts:AssumeRole',
      ],
      resources: ['*'],
    }));

    // ── Re-Enable Lambda ──
    const reenableFn = new NodejsFunction(this, 'ReEnableLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'lambdas', 'reenable', 'index.ts'),
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 512,
      logGroup: new LogGroup(this, 'ReEnableLogGroup', { retention: RetentionDays.ONE_MONTH }),
      environment: {
        AUDIT_TABLE: auditTable.tableName,
        SCP_POLICY_ID: emergencyLockdown.ref,
        CROSS_ACCOUNT_ROLE_NAME: crossAccountRoleName,
        MANAGEMENT_ACCOUNT_ID: managementAccountId,
      },
      bundling: { minify: true, sourceMap: true },
    });

    auditTable.grantReadWriteData(reenableFn);
    reenableFn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances', 'ec2:StartInstances',
        'rds:DescribeDBInstances', 'rds:StartDBInstance',
        'rds:DescribeDBClusters', 'rds:StartDBCluster',
        'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'ecs:UpdateService',
        'cloudfront:ListDistributions', 'cloudfront:GetDistribution',
        'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution',
        'lambda:ListFunctions', 'lambda:GetFunctionConcurrency',
        'lambda:DeleteFunctionConcurrency',
        'elasticloadbalancing:Describe*',
        'organizations:DetachPolicy', 'organizations:ListTargetsForPolicy',
        'organizations:DescribePolicy',
        'sns:Publish', 'sts:AssumeRole',
      ],
      resources: ['*'],
    }));

    // ── Step Function Callback Lambda ──
    const callbackFn = new NodejsFunction(this, 'StepFunctionCallbackLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'lambdas', 'callback', 'index.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup: new LogGroup(this, 'CallbackLogGroup', { retention: RetentionDays.ONE_MONTH }),
      bundling: { minify: true, sourceMap: true },
    });

    const callbackUrl = callbackFn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    callbackFn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'states:SendTaskSuccess',
        'states:SendTaskFailure',
        'states:SendTaskHeartbeat',
      ],
      resources: ['*'],
    }));

    // ── Step Function: Emergency Flow Orchestrator ──

    const stateMachineAsl = {
      StartAt: 'ThresholdCheck',
      States: {
        ThresholdCheck: {
          Type: 'Choice',
          Choices: [
            {
              Variable: '$.threshold',
              NumericGreaterThan: 99,
              Next: 'ExecuteEmergencyStop',
            },
            {
              Variable: '$.threshold',
              NumericGreaterThan: alertThresholdPercent - 1,
              Next: 'RequestEarlyStopApproval',
            },
          ],
          Default: 'NoAction',
        },
        RequestEarlyStopApproval: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
          Parameters: {
            FunctionName: callbackFn.functionArn,
            Payload: {
              'action': 'request_approval',
              'taskToken.$': '$$.Task.Token',
              'callbackUrl': callbackUrl.url,
              'alertTopicArn': alertTopic.topicArn,
              'notificationEmail': notificationEmail,
              'approvalType': 'early_stop',
            },
          },
          Next: 'EarlyApprovalChoice',
          ResultPath: '$.approvalResult',
        },
        EarlyApprovalChoice: {
          Type: 'Choice',
          Choices: [{
            Variable: '$.approvalResult.status',
            StringEquals: 'approved',
            Next: 'ExecuteEmergencyStop',
          }],
          Default: 'EarlyStopDeclined',
        },
        ExecuteEmergencyStop: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Parameters: {
            FunctionName: emergencyStopFn.functionArn,
            Payload: {
              'threshold.$': '$.threshold',
              'notificationType.$': '$.notificationType',
              'budgetName.$': '$.budgetName',
              'accountId.$': '$.accountId',
              'timestamp.$': '$.timestamp',
            },
          },
          Next: 'RequestReEnableApproval',
          ResultPath: '$.stopResult',
          Retry: [{
            ErrorEquals: ['States.ALL'],
            MaxAttempts: 2,
            BackoffRate: 2,
          }],
        },
        RequestReEnableApproval: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
          Parameters: {
            FunctionName: callbackFn.functionArn,
            Payload: {
              'action': 'request_approval',
              'taskToken.$': '$$.Task.Token',
              'callbackUrl': callbackUrl.url,
              'alertTopicArn': alertTopic.topicArn,
              'notificationEmail': notificationEmail,
              'approvalType': 'reenable',
            },
          },
          Next: 'ReEnableChoice',
          ResultPath: '$.approvalResult',
        },
        ReEnableChoice: {
          Type: 'Choice',
          Choices: [{
            Variable: '$.approvalResult.status',
            StringEquals: 'approved',
            Next: 'ExecuteReEnable',
          }],
          Default: 'StoppedNoReenable',
        },
        ExecuteReEnable: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Parameters: {
            FunctionName: reenableFn.functionArn,
            Payload: {
              'accountId.$': '$.accountId',
            },
          },
          End: true,
          Retry: [{
            ErrorEquals: ['States.ALL'],
            MaxAttempts: 2,
            BackoffRate: 2,
          }],
        },
        NoAction: { Type: 'Succeed' },
        EarlyStopDeclined: { Type: 'Succeed' },
        StoppedNoReenable: { Type: 'Succeed' },
      },
    };

    const stateMachine = new sfn.StateMachine(this, 'EmergencyFlowStateMachine', {
      stateMachineName: 'CostGovernance-EmergencyFlow',
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(stateMachineAsl)),
      timeout: Duration.hours(24),
      logs: {
        destination: new LogGroup(this, 'StateMachineLogGroup', {
          retention: RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    alertTopic.grantPublish(callbackFn);

    // ── EventBridge Rule: Budget alert -> Step Function ──
    const budgetEventRule = new events.Rule(this, 'BudgetAlertRule', {
      eventPattern: {
        source: ['aws.budgets'],
        detailType: ['Budget Alert State Change'],
        detail: {
          budgetName: [{ prefix: 'MonthlyCostBudget' }],
        },
      },
    });

    budgetEventRule.addTarget(new targets.SfnStateMachine(stateMachine, {
      input: events.RuleTargetInput.fromObject({
        threshold: events.EventField.fromPath('$.detail.threshold'),
        notificationType: events.EventField.fromPath('$.detail.notificationType'),
        budgetName: events.EventField.fromPath('$.detail.budgetName'),
        accountId: events.EventField.fromPath('$.account'),
        timestamp: events.EventField.fromPath('$.time'),
      }),
    }));

    // Also subscribe the state machine to SNS as a backup (budget alerts via SNS -> EventBridge rule)
    const snsToEventBridgeRole = new Role(this, 'SnsToEventBridgeRole', {
      assumedBy: new ServicePrincipal('sns.amazonaws.com'),
    });
    snsToEventBridgeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['events:PutEvents'],
      resources: [budgetEventRule.ruleArn],
    }));

    // ── Budget ──
    const budget = new budgets.CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: 'MonthlyCostBudget',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: monthlyBudgetAmount, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: alertThresholdPercent,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { address: alertTopic.topicArn, subscriptionType: 'SNS' },
          ],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { address: alertTopic.topicArn, subscriptionType: 'SNS' },
          ],
        },
      ],
    });

    // ── Budget Action: auto-apply SCP at 100% ──
    new budgets.CfnBudgetsAction(this, 'ApplyScpBudgetAction', {
      actionType: 'APPLY_SCP_POLICY',
      actionThreshold: { value: 100, type: 'PERCENTAGE' },
      approvalModel: 'AUTOMATIC',
      budgetName: budget.ref,
      executionRoleArn: budgetActionRole.roleArn,
      notificationType: 'ACTUAL',
      definition: {
        scpActionDefinition: {
          policyId: emergencyLockdown.ref,
          targetIds: scpTargetIds,
        },
      },
      subscribers: [
        { address: alertTopic.topicArn, type: 'SNS' },
      ],
    });

    // ── Outputs ──
    new CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
    new CfnOutput(this, 'AlertTopicArn', { value: alertTopic.topicArn });
    new CfnOutput(this, 'EmergencyStopLambdaArn', { value: emergencyStopFn.functionArn });
    new CfnOutput(this, 'ReEnableLambdaArn', { value: reenableFn.functionArn });
    new CfnOutput(this, 'CallbackUrl', { value: callbackUrl.url, description: 'Step Function approval callback URL' });
    new CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn, description: 'Emergency Flow Step Function ARN' });
  }
}
