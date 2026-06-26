# aws-cost-and-ai-governance

CDK-based cost and AI governance framework for AWS management accounts. Deploy once, govern all member accounts.

## Overview

Two stacks deploy into your management account:

| Stack | Purpose |
|---|---|
| **AiGovernanceStack** | IAM permission boundaries to restrict AI agent capabilities |
| **CostGovernanceStack** | Budget-triggered emergency lockdowns, preventive cost SCPs, and Step Function orchestration |

## Architecture

```
Management Account
├─ AiGovernanceStack
│   ├─ ReadOnlyPermissionBoundary        (managed IAM policy)
│   └─ ServerlessDeployPermissionBoundary (managed IAM policy)
│
├─ CostGovernanceStack
│   ├─ NoExpensiveOps SCP               (preventive, always-on)
│   ├─ EmergencyLockdown SCP            (reactive, auto-attached at 100% budget)
│   ├─ Monthly Budget + auto SCP action
│   ├─ EmergencyFlow Step Function
│   │   ├─ Budget alert → EventBridge → State Machine
│   │   ├─ ≥100%: auto emergency stop → approval to re-enable
│   │   └─ ≥80%:  optional early stop (approval required)
│   ├─ EmergencyStop Lambda             (stops EC2, RDS, ECS, CloudFront, Lambda)
│   ├─ ReEnable Lambda                  (reverses emergency stop)
│   ├─ Callback Lambda                  (Step Function approval callbacks)
│   ├─ DynamoDB Audit Table             (tracks every stop/reenable)
│   └─ SNS Alert Topic                  (email notifications)
│
└─ StackSet (optional)
    └─ CostGovernanceExecutionRole      (deployed to member OUs for cross-account control)
```

### Step Function flow

```
Budget reaches 80% → RequestEarlyStopApproval (email with approve/reject links)
  ├─ Approved → ExecuteEmergencyStop → RequestReEnableApproval → ReEnable?
  └─ Declined → End

Budget reaches 100% → ExecuteEmergencyStop (automatic)
  └─ RequestReEnableApproval (email with approve/reject links)
      ├─ Approved → ExecuteReEnable
      └─ Declined → End
```

## Prerequisites

- Node.js 22+ and npm
- AWS CDK bootstrapped in your management account (`cdk bootstrap`)
- AWS Organizations enabled (for SCPs and cross-account StackSets)

## Configuration

Edit `cdk.context.json` before deploying:

| Key | Description | Default |
|---|---|---|
| `targetAccountId` | Account where SCPs attach and resources are stopped | `123456789012` |
| `targetOuId` | OU for SCP attachment (optional) | `""` |
| `stackSetOuIds` | OU IDs where cross-account execution role is deployed | `[]` |
| `monthlyBudgetAmount` | Monthly budget in USD | `1000` |
| `alertThresholdPercent` | Alert threshold percentage | `80` |
| `notificationEmail` | Email for budget alerts and approval requests | `admin@example.com` |
| `protectionTagKey` | Tag key to exclude resources from emergency stops | `CostGovernance:Protected` |
| `crossAccountRoleName` | Role name deployed by StackSet into member accounts | `CostGovernanceExecutionRole` |

All values can also be set via environment variables (e.g. `TARGET_ACCOUNT_ID`, `MONTHLY_BUDGET_AMOUNT`, etc.).

## Deployment

```bash
npm install
npm run cdk bootstrap        # if not already bootstrapped
npm run diff                 # review changes
npm run deploy               # deploy both stacks
```

## Usage

### Permission Boundaries

After deployment, attach the permission boundaries to any IAM role used by AI agents:

```bash
# Read-only AI agent
aws iam put-role-permissions-boundary \
  --role-name MyAgentRole \
  --permissions-boundary arn:aws:iam::<account>:policy/ReadOnlyPermissionBoundary

# Serverless-deploy AI agent
aws iam put-role-permissions-boundary \
  --role-name MyAgentRole \
  --permissions-boundary arn:aws:iam::<account>:policy/ServerlessDeployPermissionBoundary
```

The boundary caps the maximum permissions -- the role's own policies cannot exceed it.

### SCP Management

**NoExpensiveOps** — Attach this SCP to your root OU or specific OUs to prevent costly operations proactively:

```bash
aws organizations attach-policy \
  --policy-id <NoExpensiveOps policy-id> \
  --target-id <ou-id or account-id>
```

**EmergencyLockdown** — This SCP is attached automatically by the budget action at 100% spend. Detach it manually or use the ReEnable Lambda.

### Emergency Stop Flow

1. When the monthly budget hits 80%, all subscribers receive an email with **Approve** / **Reject** links for an early lockdown
2. At 100%, the emergency stop executes automatically: EC2 instances stop, RDS instances stop, ECS services scale to 0, CloudFront distributions disable, Lambda concurrency is set to 0
3. After the stop, another email offers the option to **Re-Enable** everything
4. Every action is recorded in the DynamoDB audit table

### Protection Tags

Tag any resource to exclude it from emergency stops:

```
Key:   CostGovernance:Protected
Value: true
```

### Cross-Account Resource Control

To stop resources across member accounts, configure `stackSetOuIds` with the OU IDs where member accounts live. The StackSet deploys a `CostGovernanceExecutionRole` into those accounts. The EmergencyStop and ReEnable Lambdas automatically assume this role during their operations.

### Manual Re-Enable

Invoke the ReEnable Lambda directly to reverse the last emergency stop:

```bash
aws lambda invoke \
  --function-name <ReEnableLambdaArn> \
  --payload '{"accountId":"123456789012"}' \
  response.json
```

Or invoke the Function URL (IAM-auth) at the URL shown in `ReEnableLambdaUrl` stack output.

## Project Structure

```
├── bin/
│   └── app.ts                         CDK entry point, cdk-nag config
├── lib/
│   ├── stacks/
│   │   ├── ai-governance-stack.ts     Permission boundary managed policies
│   │   └── cost-governance-stack.ts   Budgets, SCPs, Step Function, Lambdas
│   └── lambdas/
│       ├── emergency-stop/index.ts    Stops resources across accounts
│       ├── reenable/index.ts          Reverses emergency stops
│       └── callback/index.ts          Step Function approval callbacks
├── cdk.json
├── cdk.context.json                   User configuration
├── tsconfig.json
└── package.json
```

## Cleanup

```bash
npm run destroy
```

> Note: The DynamoDB audit table uses `RemovalPolicy.RETAIN`. Delete it manually if no longer needed. The SCP policies in AWS Organizations must be detached from all targets before CloudFormation can delete them.
