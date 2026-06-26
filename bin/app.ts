import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { AiGovernanceStack } from '../lib/stacks/ai-governance-stack';
import { CostGovernanceStack } from '../lib/stacks/cost-governance-stack';

const app = new App();

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

const targetAccountId = app.node.tryGetContext('targetAccountId') || process.env.TARGET_ACCOUNT_ID || '123456789012';
const targetOuId = app.node.tryGetContext('targetOuId') || process.env.TARGET_OU_ID || '';
const stackSetOuIds: string[] = app.node.tryGetContext('stackSetOuIds') || (process.env.STACK_SET_OU_IDS ? process.env.STACK_SET_OU_IDS.split(',') : []);
const monthlyBudgetAmount = Number(app.node.tryGetContext('monthlyBudgetAmount') || process.env.MONTHLY_BUDGET_AMOUNT || 1000);
const alertThresholdPercent = Number(app.node.tryGetContext('alertThresholdPercent') || process.env.ALERT_THRESHOLD_PERCENT || 80);
const notificationEmail = app.node.tryGetContext('notificationEmail') || process.env.NOTIFICATION_EMAIL || 'admin@example.com';
const protectionTagKey = app.node.tryGetContext('protectionTagKey') || process.env.PROTECTION_TAG_KEY || 'CostGovernance:Protected';
const crossAccountRoleName = app.node.tryGetContext('crossAccountRoleName') || process.env.CROSS_ACCOUNT_ROLE_NAME || 'CostGovernanceExecutionRole';

const aiStack = new AiGovernanceStack(app, 'AiGovernanceStack', {
  description: 'AI governance permission boundaries for read-only and serverless-deploy scopes',
});

const costStack = new CostGovernanceStack(app, 'CostGovernanceStack', {
  description: 'Cost governance with budgets, SCP automation, Step Function emergency flow, and re-enable capabilities',
  targetAccountId,
  targetOuId: targetOuId || undefined,
  stackSetOuIds: stackSetOuIds.length > 0 ? stackSetOuIds : undefined,
  monthlyBudgetAmount,
  alertThresholdPercent,
  notificationEmail,
  protectionTagKey,
  crossAccountRoleName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});

NagSuppressions.addResourceSuppressions(
  aiStack,
  [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Permission boundaries intentionally use wildcard resources to cover all services; these are boundary policies, not identity policies',
    },
  ],
  true,
);

NagSuppressions.addResourceSuppressions(
  costStack,
  [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Emergency-stop and re-enable Lambdas require broad resource access to stop/re-enable arbitrary resources across services',
      appliesTo: [
        'Resource::*',
        'Action::ec2:Describe*',
        'Action::ec2:StopInstances',
        'Action::ec2:StartInstances',
        'Action::rds:Describe*',
        'Action::rds:StopDB*',
        'Action::rds:StartDB*',
        'Action::ecs:List*',
        'Action::ecs:Describe*',
        'Action::ecs:UpdateService',
        'Action::cloudfront:List*',
        'Action::cloudfront:Get*',
        'Action::cloudfront:UpdateDistribution',
        'Action::lambda:List*',
        'Action::lambda:Get*',
        'Action::lambda:Put*',
        'Action::lambda:DeleteFunctionConcurrency',
        'Action::elasticloadbalancing:Describe*',
        'Action::organizations:*',
        'Action::sns:Publish',
      ],
    },
    {
      id: 'AwsSolutions-IAM4',
      reason: 'Lambda service roles use AWSLambdaBasicExecutionRole for CloudWatch Logs; this is required by the Lambda runtime',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ],
    },
    {
      id: 'AwsSolutions-SNS2',
      reason: 'Budget alerts do not support server-side encryption via SNS; the topic carries no sensitive data',
    },
    {
      id: 'AwsSolutions-SNS3',
      reason: 'Budget alert topic does not require encrypted subscriptions; alert content is not sensitive',
    },
    {
      id: 'AwsSolutions-SF1',
      reason: 'Step Function does not process sensitive data; logging level is sufficient for operational visibility',
    },
    {
      id: 'AwsSolutions-SF2',
      reason: 'X-Ray tracing not needed for this governance workflow',
    },
    {
      id: 'AwsSolutions-DDB3',
      reason: 'Audit table holds operational metadata, not sensitive user data; point-in-time recovery is enabled',
    },
    {
      id: 'AwsSolutions-L1',
      reason: 'Lambda runtime 22.x is the latest available; no newer runtime exists',
    },
  ],
  true,
);
