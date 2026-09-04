# AWS reference topology

The CDK stack synthesizes a private, multi-AZ control plane from executable TypeScript. Assertions in `tests/infra.test.ts` inspect the generated CloudFormation so core security and availability properties cannot drift silently.

## Topology

- Private ECS/Fargate API and worker services, two tasks each, deployment circuit breakers, and independent autoscaling.
- An internal Application Load Balancer with TLS, health checks, deletion protection, and an AWS managed WAF rule group.
- Aurora PostgreSQL 17 Serverless v2 in isolated subnets with encryption, point-in-time backups, deletion protection, IAM database authentication enabled, and a TLS-only RDS Proxy.
- Separate KMS keys for operational data and audit evidence, both with rotation.
- A versioned, blocked-public-access S3 evidence bucket with governance-mode Object Lock.
- Enhanced Container Insights, encrypted retained logs, rejected-traffic VPC flow logs, CloudWatch alarms, and an encrypted SNS incident topic.
- Interface endpoints for ECR, CloudWatch Logs, and Secrets Manager, plus an S3 gateway endpoint.

The load balancer is intentionally private. An organization-owned identity-aware edge, DNS zone, and reviewer identity provider are deployment inputs rather than resources this repository should pretend to own.

## Verify and deploy

```bash
npm run infra:synth
docker build -f deploy/Dockerfile -t synode:0.1.0 .

# After pushing an immutable image to ECR and bootstrapping the target account:
npx cdk deploy \
  --parameters ContainerImage='<account>.dkr.ecr.<region>.amazonaws.com/synode@sha256:<digest>' \
  --parameters CertificateArn='arn:aws:acm:<region>:<account>:certificate/<id>' \
  --parameters TenantShard='research' \
  --parameters ToolHandlerEndpoint='https://tools.internal.example/'
```

Deployment should occur through a reviewed delivery role, not developer admin credentials. Add account-specific budgets, Route 53 records, the identity-aware edge, log archive destination, security-service integrations, and notification subscriptions in the platform layer.

No AWS environment is claimed by this repository. The public evidence is the synthesized topology, its assertions, and the explicit production boundary.
