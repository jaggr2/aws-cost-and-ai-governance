import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

type EventHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

function getClients() {
  return {
    sfn: new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' }),
    sns: new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' }),
  };
}

async function sendApprovalEmail(
  sns: SNSClient,
  topicArn: string,
  callbackUrl: string,
  taskToken: string,
  approvalType: string,
): Promise<void> {
  const approveUrl = `${callbackUrl}?taskToken=${encodeURIComponent(taskToken)}&action=approve`;
  const rejectUrl = `${callbackUrl}?taskToken=${encodeURIComponent(taskToken)}&action=reject`;

  const label = approvalType === 'early_stop' ? 'Early Stop' : 'Re-Enable Resources';

  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: `Cost Governance — ${label} Approval Required`,
    Message: [
      `${label} Approval Required`,
      '',
      `Approve: ${approveUrl}`,
      `Reject: ${rejectUrl}`,
      '',
      'Click the appropriate link to approve or reject.',
    ].join('\n'),
  }));
}

const handleCallback: EventHandler = async (event) => {
  const params = event.queryStringParameters || {};
  const { taskToken, action } = params;

  if (!taskToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing taskToken parameter' }) };
  }
  if (!action || !['approve', 'reject'].includes(action)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid action parameter (use approve or reject)' }) };
  }

  const { sfn } = getClients();

  try {
    if (action === 'approve') {
      await sfn.send(new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ status: 'approved', action }),
      }));
      return { statusCode: 200, body: JSON.stringify({ message: 'Task approved successfully' }) };
    } else {
      await sfn.send(new SendTaskFailureCommand({
        taskToken,
        error: 'UserRejected',
        cause: 'The approval was rejected by the user',
      }));
      return { statusCode: 200, body: JSON.stringify({ message: 'Task rejected' }) };
    }
  } catch (err: any) {
    console.error('Failed to send task result:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

const handleRequestApproval: EventHandler = async (event) => {
  const { sfn, sns } = getClients();
  let body: any = {};

  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
  }

  const {
    action,
    taskToken,
    callbackUrl,
    alertTopicArn,
    approvalType: explicitType,
  } = body;

  if (action !== 'request_approval' || !taskToken || !callbackUrl || !alertTopicArn) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: action=request_approval, taskToken, callbackUrl, alertTopicArn' }) };
  }

  const approvalType = explicitType || 'early_stop';

  try {
    await sendApprovalEmail(sns, alertTopicArn, callbackUrl, taskToken, approvalType);
    return {
      statusCode: 202,
      body: JSON.stringify({ message: 'Approval request sent', taskToken: taskToken.substring(0, 8) + '...' }),
    };
  } catch (err: any) {
    console.error('Failed to send approval request:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

export const handler: EventHandler = async (event) => {
  const params = event.queryStringParameters || {};

  if (params.taskToken) {
    return handleCallback(event);
  }

  if (event.body) {
    try {
      const body = JSON.parse(event.body);
      if (body.action === 'request_approval') {
        return handleRequestApproval(event);
      }
    } catch { /* fall through to error */ }
  }

  return {
    statusCode: 400,
    body: JSON.stringify({
      error: 'Invalid request. Use query params taskToken+action for callback, or POST with action=request_approval to send notification.',
    }),
  };
};
