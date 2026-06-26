import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  RDSClient,
  DescribeDBInstancesCommand,
  StartDBInstanceCommand,
  DescribeDBClustersCommand,
  StartDBClusterCommand,
} from '@aws-sdk/client-rds';
import {
  ECSClient,
  DescribeServicesCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  LambdaClient,
  DeleteFunctionConcurrencyCommand,
} from '@aws-sdk/client-lambda';
import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  OrganizationsClient,
  DetachPolicyCommand,
  ListTargetsForPolicyCommand,
} from '@aws-sdk/client-organizations';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

interface StoppedResource {
  arn: string;
  type: string;
  previousState: Record<string, unknown>;
}

interface StopRecord {
  accountId: string;
  stopId: string;
  scpAttached: boolean;
  scpPolicyId: string;
  targetIds: string[];
  resourcesStopped: StoppedResource[];
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

function parseResourceArn(arn: string): { service: string; region: string; accountId: string; resource: string } {
  const parts = arn.split(':');
  return {
    service: parts[2],
    region: parts[3],
    accountId: parts[4],
    resource: parts.slice(5).join(':'),
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
      RoleSessionName: 'CostGovernanceReEnable',
      ExternalId: 'CostGovernanceCrossAccount',
    }));
    return getClients();
  } catch (err: any) {
    console.error(`Failed to assume role in account ${accountId}:`, err.message);
    return null;
  }
}

async function queryStopRecords(
  dynamodb: DynamoDBClient,
  accountId?: string,
  status?: string,
): Promise<StopRecord[]> {
  const records: StopRecord[] = [];
  const tableName = process.env.AUDIT_TABLE!;
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const expressionValues: Record<string, AttributeValue> = {};
    const filterParts: string[] = [];
    if (accountId) { expressionValues[':accountId'] = { S: accountId }; filterParts.push('accountId = :accountId'); }
    if (status) { expressionValues[':status'] = { S: status }; filterParts.push('#status = :status'); }

    const result = await dynamodb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: accountId ? 'accountId = :accountId' : undefined,
      FilterExpression: filterParts.length > 0 ? filterParts.join(' AND ') : undefined,
      ExpressionAttributeValues: Object.keys(expressionValues).length > 0 ? expressionValues : undefined,
      ExpressionAttributeNames: status ? { '#status': 'status' } : undefined,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of result.Items || []) {
      records.push({
        accountId: item.accountId?.S || '',
        stopId: item.stopId?.S || '',
        scpAttached: item.scpAttached?.BOOL || false,
        scpPolicyId: item.scpPolicyId?.S || '',
        targetIds: item.targetIds?.S ? JSON.parse(item.targetIds.S) : [],
        resourcesStopped: item.resourcesStopped?.S ? JSON.parse(item.resourcesStopped.S) : [],
      });
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return records;
}

async function updateRecordStatus(dynamodb: DynamoDBClient, accountId: string, stopId: string): Promise<void> {
  await dynamodb.send(new UpdateItemCommand({
    TableName: process.env.AUDIT_TABLE!,
    Key: { accountId: { S: accountId }, stopId: { S: stopId } },
    UpdateExpression: 'SET #status = :status, reenabledAt = :reenabledAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': { S: 'reenabled' }, ':reenabledAt': { S: new Date().toISOString() } },
  }));
}

async function reenableResource(
  resource: StoppedResource,
  clients: ReturnType<typeof getClients>,
): Promise<boolean> {
  try {
    switch (resource.type) {
      case 'ec2:Instance': {
        const instanceId = parseResourceArn(resource.arn).resource.split('/').pop()!;
        await clients.ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
        return true;
      }
      case 'rds:DBInstance': {
        const dbId = parseResourceArn(resource.arn).resource.split(':').pop()!;
        await clients.rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbId }));
        return true;
      }
      case 'rds:DBCluster': {
        const clusterId = parseResourceArn(resource.arn).resource.split(':').pop()!;
        await clients.rds.send(new StartDBClusterCommand({ DBClusterIdentifier: clusterId }));
        return true;
      }
      case 'ecs:Service': {
        const arn = resource.arn;
        const clusterArn = arn.substring(0, arn.indexOf('/service/'));
        const desiredCount = (resource.previousState as any).desiredCount || 1;
        await clients.ecs.send(new UpdateServiceCommand({ cluster: clusterArn, service: arn, desiredCount }));
        return true;
      }
      case 'cloudfront:Distribution': {
        const distId = parseResourceArn(resource.arn).resource.split('/').pop()!;
        const config = await clients.cloudfront.send(new GetDistributionConfigCommand({ Id: distId }));
        await clients.cloudfront.send(new UpdateDistributionCommand({
          Id: distId,
          IfMatch: config.ETag!,
          DistributionConfig: { ...config.DistributionConfig!, Enabled: true },
        }));
        return true;
      }
      case 'lambda:Function': {
        const funcName = parseResourceArn(resource.arn).resource.split(':').pop()!;
        await clients.lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: funcName }));
        return true;
      }
      default:
        console.warn(`Unknown resource type: ${resource.type}`);
        return false;
    }
  } catch (err: any) {
    console.error(`Failed to re-enable ${resource.type} ${resource.arn}:`, err.message);
    return false;
  }
}

interface ReenableInput {
  accountId?: string;
  stopId?: string;
}

export async function handler(event: ReenableInput): Promise<{
  totalReenabled: number;
  totalFailed: number;
  recordsProcessed: number;
  details: any[];
}> {
  console.log('Re-enable invoked', JSON.stringify(event));

  const managementClients = getClients();
  const scpPolicyId = process.env.SCP_POLICY_ID!;
  const crossAccountRoleName = process.env.CROSS_ACCOUNT_ROLE_NAME || 'CostGovernanceExecutionRole';
  const managementAccountId = process.env.MANAGEMENT_ACCOUNT_ID || '';

  const requestAccountId = event.accountId || managementAccountId;
  const requestStopId = event.stopId;

  const records = await queryStopRecords(managementClients.dynamodb, requestAccountId, 'stopped');
  if (records.length === 0) {
    return { totalReenabled: 0, totalFailed: 0, recordsProcessed: 0, details: [] };
  }

  const results: { stopId: string; reenabled: number; failed: number; errors: string[] }[] = [];
  let totalReenabled = 0;
  let totalFailed = 0;

  // Build map of account -> records for cross-account reenable
  const accountRecords = new Map<string, StopRecord[]>();
  for (const record of records) {
    if (requestStopId && record.stopId !== requestStopId) continue;
    const acct = record.accountId;
    if (!accountRecords.has(acct)) accountRecords.set(acct, []);
    accountRecords.get(acct)!.push(record);
  }

  for (const [accountId, recs] of accountRecords) {
    const clients = accountId === managementAccountId
      ? managementClients
      : await assumeRoleInAccount(managementClients.sts, accountId, crossAccountRoleName);

    if (!clients) {
      for (const rec of recs) {
        results.push({ stopId: rec.stopId, reenabled: 0, failed: rec.resourcesStopped.length, errors: ['Failed to assume cross-account role'] });
        totalFailed += rec.resourcesStopped.length;
      }
      continue;
    }

    for (const record of recs) {
      let reenabled = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const resource of record.resourcesStopped) {
        if (await reenableResource(resource, clients)) reenabled++;
        else failed++;
      }

      // Detach SCP
      if (record.scpAttached && scpPolicyId) {
        for (const targetId of record.targetIds) {
          try {
            const targets = await managementClients.organizations.send(
              new ListTargetsForPolicyCommand({ PolicyId: scpPolicyId }),
            );
            if ((targets.Targets || []).some((t) => t.TargetId === targetId)) {
              await managementClients.organizations.send(
                new DetachPolicyCommand({ PolicyId: scpPolicyId, TargetId: targetId }),
              );
            }
          } catch (err: any) {
            errors.push(`SCP detach from ${targetId}: ${err.message}`);
          }
        }
      }

      try {
        await updateRecordStatus(managementClients.dynamodb, record.accountId, record.stopId);
      } catch (err: any) {
        errors.push(`DynamoDB: ${err.message}`);
      }

      results.push({ stopId: record.stopId, reenabled, failed, errors });
      totalReenabled += reenabled;
      totalFailed += failed;
    }
  }

  return { totalReenabled, totalFailed, recordsProcessed: results.length, details: results };
}
