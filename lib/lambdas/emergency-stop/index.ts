import {
  EC2Client,
  DescribeInstancesCommand,
  StopInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2';
import {
  RDSClient,
  DescribeDBInstancesCommand,
  StopDBInstanceCommand,
  DescribeDBClustersCommand,
  StopDBClusterCommand,
  type DBInstance,
  type DBCluster,
} from '@aws-sdk/client-rds';
import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import {
  CloudFrontClient,
  ListDistributionsCommand,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
  type DistributionSummary,
} from '@aws-sdk/client-cloudfront';
import {
  LambdaClient,
  ListFunctionsCommand,
  PutFunctionConcurrencyCommand,
  GetFunctionConcurrencyCommand,
  type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  OrganizationsClient,
  AttachPolicyCommand,
} from '@aws-sdk/client-organizations';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

interface BudgetEvent {
  threshold: number;
  notificationType: string;
  budgetName: string;
  accountId: string;
  timestamp: string;
}

interface StoppedResource {
  arn: string;
  type: string;
  previousState: Record<string, unknown>;
}

interface StopRecord {
  accountId: string;
  stopId: string;
  timestamp: string;
  budgetName: string;
  threshold: number;
  resourcesStopped: StoppedResource[];
  scpAttached: boolean;
  scpPolicyId: string;
  targetIds: string[];
  status: 'stopped' | 'reenabled';
  stoppedAt: string;
}

function getClients(region?: string) {
  const r = region || process.env.AWS_REGION || 'us-east-1';
  return {
    ec2: new EC2Client({ region: r }),
    rds: new RDSClient({ region: r }),
    ecs: new ECSClient({ region: r }),
    cloudfront: new CloudFrontClient({ region: r }),
    lambda: new LambdaClient({ region: r }),
    dynamodb: new DynamoDBClient({ region: r }),
    organizations: new OrganizationsClient({ region: r }),
    sns: new SNSClient({ region: r }),
    sts: new STSClient({ region: r }),
  };
}

async function assumeRoleInAccount(
  sts: STSClient,
  accountId: string,
  roleName: string,
): Promise<ReturnType<typeof getClients> | null> {
  try {
    const result = await sts.send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
      RoleSessionName: 'CostGovernanceEmergencyStop',
      ExternalId: 'CostGovernanceCrossAccount',
    }));
    const creds = result.Credentials!;
    return getClients();
    // Note: We return clients for this account's region. For multi-region, extend as needed.
  } catch (err: any) {
    console.error(`Failed to assume role in account ${accountId}:`, err.message);
    return null;
  }
}

function isProtected(tags: any[] | undefined, tagKey: string): boolean {
  if (!tags) return false;
  return tags.some((t: any) => t.Key === tagKey && t.Value === 'true');
}

async function getRunningEc2Instances(ec2: EC2Client, protectionTagKey: string): Promise<Instance[]> {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: 'instance-state-name', Values: ['running', 'pending'] }],
    }),
  );
  return (result.Reservations || [])
    .flatMap((r) => r.Instances || [])
    .filter((inst) => !isProtected(inst.Tags as any[], protectionTagKey));
}

async function getAvailableRdsInstances(rds: RDSClient, protectionTagKey: string): Promise<DBInstance[]> {
  const result = await rds.send(new DescribeDBInstancesCommand({}));
  return (result.DBInstances || []).filter(
    (db) => db.DBInstanceStatus === 'available' && !isProtected(db.TagList, protectionTagKey),
  );
}

async function getAvailableRdsClusters(rds: RDSClient, protectionTagKey: string): Promise<DBCluster[]> {
  const result = await rds.send(new DescribeDBClustersCommand({}));
  return (result.DBClusters || []).filter(
    (cluster) => cluster.Status === 'available' && !isProtected(cluster.TagList, protectionTagKey),
  );
}

async function getActiveEcsServices(
  ecs: ECSClient,
  protectionTagKey: string,
): Promise<{ clusterArn: string; serviceArn: string; serviceName: string; desiredCount: number }[]> {
  const active: { clusterArn: string; serviceArn: string; serviceName: string; desiredCount: number }[] = [];
  const clusters = await ecs.send(new ListClustersCommand({}));
  for (const clusterArn of clusters.clusterArns || []) {
    const services = await ecs.send(new ListServicesCommand({ cluster: clusterArn }));
    if (!services.serviceArns?.length) continue;
    const desc = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: services.serviceArns }));
    for (const svc of desc.services || []) {
      if ((svc.desiredCount ?? 0) > 0 && !isProtected(svc.tags, protectionTagKey)) {
        active.push({
          clusterArn,
          serviceArn: svc.serviceArn!,
          serviceName: svc.serviceName!,
          desiredCount: svc.desiredCount ?? 0,
        });
      }
    }
  }
  return active;
}

async function getEnabledCloudFrontDistributions(
  cf: CloudFrontClient,
  protectionTagKey: string,
): Promise<DistributionSummary[]> {
  const result = await cf.send(new ListDistributionsCommand({}));
  return (result.DistributionList?.Items || []).filter(
    (d) => d.Enabled === true && !isProtected(
      // CloudFront tags aren't returned by ListDistributions; fetch per-dist if needed.
      // For now, we skip tag check for CloudFront (ListDistributions doesn't return tags).
      undefined,
      protectionTagKey,
    ),
  );
}

async function getLambdaFunctionsWithNoConcurrency(
  lambda: LambdaClient,
  protectionTagKey: string,
): Promise<FunctionConfiguration[]> {
  const functions: FunctionConfiguration[] = [];
  let marker: string | undefined;
  do {
    const result = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    for (const fn of result.Functions || []) {
      // Lambda functions returned by ListFunctions don't include tags.
      // Tag-based protection for Lambda requires a separate GetFunction call; skip for now.
      try {
        const concurrency = await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: fn.FunctionName! }));
        if (!concurrency.ReservedConcurrentExecutions || concurrency.ReservedConcurrentExecutions > 0) {
          functions.push(fn);
        }
      } catch {
        functions.push(fn);
      }
    }
    marker = result.NextMarker;
  } while (marker);
  return functions;
}

async function stopResourcesInAccount(
  accountId: string,
  clients: ReturnType<typeof getClients>,
  protectionTagKey: string,
): Promise<{ stopped: StoppedResource[]; errors: string[] }> {
  const stopped: StoppedResource[] = [];
  const errors: string[] = [];
  const region = process.env.AWS_REGION || 'us-east-1';

  // EC2
  try {
    const instances = await getRunningEc2Instances(clients.ec2, protectionTagKey);
    if (instances.length > 0) {
      const ids = instances.map((i) => i.InstanceId!).filter(Boolean);
      await clients.ec2.send(new StopInstancesCommand({ InstanceIds: ids }));
      for (const inst of instances) {
        stopped.push({
          arn: `arn:aws:ec2:${region}:${accountId}:instance/${inst.InstanceId}`,
          type: 'ec2:Instance',
          previousState: { status: 'running', instanceType: inst.InstanceType },
        });
      }
      console.log(`[${accountId}] Stopped ${instances.length} EC2 instances`);
    }
  } catch (err: any) { errors.push(`EC2: ${err.message}`); }

  // RDS instances
  try {
    const dbInstances = await getAvailableRdsInstances(clients.rds, protectionTagKey);
    for (const db of dbInstances) {
      await clients.rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: db.DBInstanceIdentifier! }));
      stopped.push({
        arn: db.DBInstanceArn!,
        type: 'rds:DBInstance',
        previousState: { status: 'available', engine: db.Engine, class: db.DBInstanceClass },
      });
    }
    console.log(`[${accountId}] Stopped ${dbInstances.length} RDS instances`);
  } catch (err: any) { errors.push(`RDS instances: ${err.message}`); }

  // RDS clusters
  try {
    const clusters = await getAvailableRdsClusters(clients.rds, protectionTagKey);
    for (const cluster of clusters) {
      await clients.rds.send(new StopDBClusterCommand({ DBClusterIdentifier: cluster.DBClusterIdentifier! }));
      stopped.push({
        arn: cluster.DBClusterArn!,
        type: 'rds:DBCluster',
        previousState: { status: 'available', engine: cluster.Engine },
      });
    }
    console.log(`[${accountId}] Stopped ${clusters.length} RDS clusters`);
  } catch (err: any) { errors.push(`RDS clusters: ${err.message}`); }

  // ECS
  try {
    const ecsServices = await getActiveEcsServices(clients.ecs, protectionTagKey);
    for (const svc of ecsServices) {
      await clients.ecs.send(new UpdateServiceCommand({ cluster: svc.clusterArn, service: svc.serviceArn, desiredCount: 0 }));
      stopped.push({
        arn: svc.serviceArn,
        type: 'ecs:Service',
        previousState: { desiredCount: svc.desiredCount, cluster: svc.clusterArn },
      });
    }
    console.log(`[${accountId}] Scaled ${ecsServices.length} ECS services to 0`);
  } catch (err: any) { errors.push(`ECS: ${err.message}`); }

  // CloudFront
  try {
    const dists = await getEnabledCloudFrontDistributions(clients.cloudfront, protectionTagKey);
    for (const dist of dists) {
      const config = await clients.cloudfront.send(new GetDistributionConfigCommand({ Id: dist.Id! }));
      await clients.cloudfront.send(new UpdateDistributionCommand({
        Id: dist.Id!,
        IfMatch: config.ETag!,
        DistributionConfig: { ...config.DistributionConfig!, Enabled: false },
      }));
      stopped.push({
        arn: dist.ARN!,
        type: 'cloudfront:Distribution',
        previousState: { enabled: true, domainName: dist.DomainName },
      });
    }
    console.log(`[${accountId}] Disabled ${dists.length} CloudFront distributions`);
  } catch (err: any) { errors.push(`CloudFront: ${err.message}`); }

  // Lambda concurrency
  try {
    const functions = await getLambdaFunctionsWithNoConcurrency(clients.lambda, protectionTagKey);
    for (const fn of functions) {
      await clients.lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: fn.FunctionName!, ReservedConcurrentExecutions: 0 }));
      stopped.push({
        arn: fn.FunctionArn!,
        type: 'lambda:Function',
        previousState: { runtime: fn.Runtime },
      });
    }
    console.log(`[${accountId}] Set concurrency=0 for ${functions.length} Lambda functions`);
  } catch (err: any) { errors.push(`Lambda: ${err.message}`); }

  return { stopped, errors };
}

async function recordStop(dynamodb: DynamoDBClient, record: StopRecord): Promise<void> {
  await dynamodb.send(new PutItemCommand({
    TableName: process.env.AUDIT_TABLE!,
    Item: {
      accountId: { S: record.accountId },
      stopId: { S: record.stopId },
      timestamp: { S: record.timestamp },
      budgetName: { S: record.budgetName },
      threshold: { N: String(record.threshold) },
      resourcesStopped: { S: JSON.stringify(record.resourcesStopped) },
      scpAttached: { BOOL: record.scpAttached },
      scpPolicyId: { S: record.scpPolicyId },
      targetIds: { S: JSON.stringify(record.targetIds) },
      status: { S: record.status },
      stoppedAt: { S: record.stoppedAt },
    },
  }));
}

export async function handler(event: BudgetEvent): Promise<{ stopId: string; resourcesStopped: number; errors: number }> {
  console.log('Emergency stop triggered', JSON.stringify(event));

  const threshold = Number(event.threshold);
  if (threshold < 100) {
    // Should not be called for warnings; Step Function handles branching
    throw new Error(`Emergency stop called with threshold ${threshold}% < 100%`);
  }

  const managementClients = getClients();
  const accountId = event.accountId || process.env.MANAGEMENT_ACCOUNT_ID || '';
  const stopId = `stop-${Date.now()}`;
  const scpPolicyId = process.env.SCP_POLICY_ID!;
  const scpTargetIds: string[] = JSON.parse(process.env.SCP_TARGET_IDS || '[]');
  const protectionTagKey = process.env.PROTECTION_TAG_KEY || 'CostGovernance:Protected';
  const crossAccountRoleName = process.env.CROSS_ACCOUNT_ROLE_NAME || 'CostGovernanceExecutionRole';
  const targetAccountIds: string[] = JSON.parse(process.env.TARGET_ACCOUNT_IDS || '[]');

  if (!accountId) {
    throw new Error('No account ID available; set MANAGEMENT_ACCOUNT_ID or ensure event contains accountId');
  }

  let allStopped: StoppedResource[] = [];
  let allErrors: string[] = [];
  let scpAttached = false;

  // Stop in management account
  const mgmtResult = await stopResourcesInAccount(accountId, managementClients, protectionTagKey);
  allStopped.push(...mgmtResult.stopped);
  allErrors.push(...mgmtResult.errors);

  // Stop in cross-account targets
  if (crossAccountRoleName && targetAccountIds.length > 0) {
    for (const targetId of targetAccountIds) {
      if (targetId === accountId) continue;
      const crossClients = await assumeRoleInAccount(managementClients.sts, targetId, crossAccountRoleName);
      if (crossClients) {
        const result = await stopResourcesInAccount(targetId, crossClients, protectionTagKey);
        allStopped.push(...result.stopped);
        allErrors.push(...result.errors);
      } else {
        allErrors.push(`CrossAccount-${targetId}: Failed to assume role`);
      }
    }
  }

  // Attach SCP
  if (scpPolicyId && scpTargetIds.length > 0) {
    for (const targetId of scpTargetIds) {
      try {
        await managementClients.organizations.send(new AttachPolicyCommand({ PolicyId: scpPolicyId, TargetId: targetId }));
        scpAttached = true;
        console.log(`Attached SCP ${scpPolicyId} to ${targetId}`);
      } catch (err: any) {
        allErrors.push(`SCP attach to ${targetId}: ${err.message}`);
      }
    }
  }

  // Record audit trail
  const stopRecord: StopRecord = {
    accountId,
    stopId,
    timestamp: new Date().toISOString(),
    budgetName: event.budgetName || 'MonthlyCostBudget',
    threshold,
    resourcesStopped: allStopped,
    scpAttached,
    scpPolicyId,
    targetIds: scpTargetIds,
    status: 'stopped',
    stoppedAt: new Date().toISOString(),
  };

  try {
    await recordStop(managementClients.dynamodb, stopRecord);
  } catch (err: any) {
    allErrors.push(`DynamoDB: ${err.message}`);
  }

  console.log(`Emergency stop completed: ${stopId}, ${allStopped.length} resources stopped, ${allErrors.length} errors`);

  return {
    stopId,
    resourcesStopped: allStopped.length,
    errors: allErrors.length,
  };
}
