# AGENTS.md — Project Instructions for AI Agents

## Project overview

This is an AWS CDK v2 TypeScript project deploying cost and AI governance infrastructure into an AWS management account. Two stacks: `AiGovernanceStack` (IAM permission boundaries) and `CostGovernanceStack` (budgets, SCPs, Step Functions, emergency Lambdas).

## Technology stack

- **Runtime**: Node.js 22, TypeScript 5.8, CDK v2 (`aws-cdk-lib` + `aws-cdk` CLI)
- **Bundler**: `tsx` for CDK app execution; esbuild (via `NodejsFunction`) for Lambda bundling
- **Lambda runtime**: Node.js 22.x
- **Compliance**: `cdk-nag` with `AwsSolutionsChecks`
- **SDK**: AWS SDK v3 (`@aws-sdk/client-*`) — bundled into Lambda functions by esbuild

## Architecture decisions

### 1. Two-stack design
- **AiGovernanceStack**: Stateless IAM managed policies. Deploy rarely, update when adding new permission boundaries.
- **CostGovernanceStack**: Stateful resources (DynamoDB audit table, SCPs, budgets). Lambdas, Step Function, EventBridge rule.

### 2. Raw ASL for Step Functions
The Step Function definition uses `DefinitionBody.fromString()` with raw Amazon States Language JSON, not the chainable L2 API. Reason: The emergency flow reuses states (`ExecuteEmergencyStop`, `RequestReEnableApproval`) across two branches (≥80% optional early stop and ≥100% mandatory stop). The CDK chain API prohibits reusing the same `LambdaInvoke` in multiple chains. Raw ASL avoids this limitation.

### 3. Single callback Lambda for Step Function approval
The `callbackFn` Lambda serves two roles:
- **SNS notification**: When invoked by the Step Function via `lambda:invoke.waitForTaskToken`, it publishes an SNS email with clickable approve/reject URLs
- **HTTP callback**: When the user clicks a link (GET request with `taskToken` + `action` params), it calls `SendTaskSuccess`/`SendTaskFailure` to resume the state machine

### 4. Cross-account via StackSet
The StackSet deploys a `CostGovernanceExecutionRole` to member OUs. The EmergencyStop/ReEnable Lambdas use `sts:AssumeRole` with `ExternalId` to assume this role per target account. The StackSet uses `SERVICE_MANAGED` permission model with `autoDeployment` — new accounts in the OU automatically get the role.

### 5. SCP two-tier strategy
- **NoExpensiveOps** (preventive): Always attached. Denies costly instance types, AI/ML services, NAT gateways, commitments.
- **EmergencyLockdown** (reactive): Auto-attached by AWS Budgets action at 100% spend. Denies entire service namespaces (`rds:*`, `lambda:*`, `ecs:*`, `eks:*`, `sagemaker:*`, `elasticmapreduce:*`, `redshift:*` plus `ec2:RunInstances` and `s3:CreateBucket`).

### 6. Protection tags
Resources tagged with `CostGovernance:Protected=true` are skipped during emergency stops. EC2 and RDS tag filtering is active. Lambda and CloudFront tag filtering is limited (ListFunctions and ListDistributions don't return tags in the API response).

### 7. Budget alert routing
- AWS Budgets sends alerts to both SNS (email subscribers) and EventBridge (native integration)
- EventBridge rule matches `aws.budgets` source with `Budget Alert State Change` detail-type, filters on `MonthlyCostBudget` prefix, triggers the Step Function
- SNS provides human-readable email notifications alongside EventBridge machine routing

## Configuration

All user-configurable values are in `cdk.context.json` with environment variable fallbacks. See `bin/app.ts` lines 7-16 for the extraction logic. Available keys:

`targetAccountId`, `targetOuId`, `stackSetOuIds`, `monthlyBudgetAmount`, `alertThresholdPercent`, `notificationEmail`, `protectionTagKey`, `crossAccountRoleName`

## Key patterns

### IAM permission boundaries
Use `PolicyDocument.fromJson()` with raw JSON to bypass CDK's IAM action validation. The CDK validator rejects wildcard service namespaces (`*:Describe*`), but permission boundaries inherently need broad patterns. Raw JSON via `fromJson()` skips validation while producing valid CloudFormation.

### cdk-nag suppressions
Suppressions are applied at the stack level in `bin/app.ts`. Key suppressions:
- **IAM5**: Wildcard resources/actions are inherent to governance Lambdas that must operate on arbitrary resources
- **IAM4**: `AWSLambdaBasicExecutionRole` is required for Lambda CloudWatch Logs
- **SNS2/SNS3**: Budget alert topics don't carry sensitive data
- **SF1/SF2**: Step Function operational visibility; no sensitive data in state machine
- **DDB3**: Audit table has point-in-time recovery enabled
- **L1**: Lambda Node.js 22.x is the current latest runtime

### DynamoDB audit schema
- **PK**: `accountId` (String) — AWS account ID where resources were stopped
- **SK**: `stopId` (String) — unique identifier `stop-{timestamp}`
- **Attributes**: `timestamp`, `budgetName`, `threshold`, `resourcesStopped` (JSON array), `scpAttached` (BOOL), `scpPolicyId`, `targetIds` (JSON array), `status` ("stopped" | "reenabled"), `stoppedAt`, `reenabledAt`

## Common tasks

### Adding a new permission boundary
1. Add a new `ManagedPolicy` in `lib/stacks/ai-governance-stack.ts`
2. Use `PolicyDocument.fromJson()` with the raw IAM policy document
3. Add a `CfnOutput` for the policy ARN
4. Run `npm run synth` to verify

### Adding a new service to emergency stop
1. Add SDK client imports to `lib/lambdas/emergency-stop/index.ts`
2. Add a new `try/catch` block in `stopResourcesInAccount()` with the stop logic
3. Add a corresponding case in `reenableResource()` in `lib/lambdas/reenable/index.ts`
4. Add required IAM permissions to both Lambda roles in `cost-governance-stack.ts`
5. If cross-account, add permissions to the StackSet execution role template
6. Update cdk-nag suppressions in `bin/app.ts` if new wildcard permissions

### Adding a new preventive SCP
1. Add a new `orgs.CfnPolicy` in `lib/stacks/cost-governance-stack.ts`
2. Follow the existing `NoExpensiveOpsScp` pattern
3. Attach the SCP to target OUs/accounts via AWS Organizations console or API

## Testing

```bash
npm run build          # TypeScript compilation
npm run synth          # CDK synthesis with strict mode + cdk-nag
npm run diff           # CloudFormation change set diff
```

No unit tests are configured. The synth step (TypeScript + CDK + cdk-nag) serves as the primary correctness check.

## Deployment workflow

```bash
npm install
npm run synth          # verify template
npm run diff           # review changes
npm run deploy         # deploy all stacks
```

After deployment:
1. Attach `NoExpensiveOps` SCP to your root OU or target OUs (not automated)
2. Attach permission boundaries to AI agent roles via IAM console or CLI
3. Verify the SNS email subscription (check inbox for confirmation email)
4. Test the callback URL by opening the `CallbackUrl` output in a browser
