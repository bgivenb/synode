import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { SynodeStack } from "../infra/synode-stack.js";

function template(): Template {
  const app = new App();
  return Template.fromStack(
    new SynodeStack(app, "TestStack", {
      env: { account: "111111111111", region: "us-west-2" },
    }),
  );
}

describe("AWS reference stack", () => {
  it("keeps API, workers, and Aurora private with rollback-safe services", () => {
    const rendered = template();
    rendered.resourceCountIs("AWS::ECS::Service", 2);
    rendered.allResourcesProperties("AWS::ECS::Service", {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      DesiredCount: 2,
      EnableExecuteCommand: false,
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
      }),
    });
    rendered.hasResourceProperties("AWS::RDS::DBCluster", {
      DatabaseName: "synode",
      DeletionProtection: true,
      EnableIAMDatabaseAuthentication: true,
      Engine: "aurora-postgresql",
      ServerlessV2ScalingConfiguration: { MaxCapacity: 8, MinCapacity: 0.5 },
      StorageEncrypted: true,
    });
    rendered.hasResourceProperties("AWS::RDS::DBProxy", {
      RequireTLS: true,
    });
  });

  it("retains encrypted audit evidence and requires private TLS ingress", () => {
    const rendered = template();
    rendered.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: "aws:kms" }),
          }),
        ]),
      }),
      ObjectLockEnabled: true,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
    rendered.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internal",
    });
    rendered.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
    });
    rendered.resourceCountIs("AWS::WAFv2::WebACL", 1);
  });

  it("makes observability and failure notification part of the stack", () => {
    const rendered = template();
    const alarms = rendered.findResources("AWS::CloudWatch::Alarm");
    expect(Object.keys(alarms).length).toBeGreaterThanOrEqual(3);
    rendered.resourceCountIs("AWS::SNS::Topic", 1);
    rendered.hasResourceProperties("AWS::EC2::FlowLog", { TrafficType: "REJECT" });
  });
});
