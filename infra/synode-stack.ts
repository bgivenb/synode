import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elasticloadbalancing from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as waf from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";

/** A deployable reference topology; account-specific identity and DNS stay outside this stack. */
export class SynodeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const containerImage = new CfnParameter(this, "ContainerImage", {
      description: "Immutable ECR image URI for the Synode container, including a digest",
      type: "String",
    });
    const certificateArn = new CfnParameter(this, "CertificateArn", {
      description: "ACM certificate ARN for the private HTTPS listener",
      type: "String",
    });
    const tenantShard = new CfnParameter(this, "TenantShard", {
      default: "research",
      description: "Tenant or shard assigned to this worker service",
      type: "String",
    });
    const toolHandlerEndpoint = new CfnParameter(this, "ToolHandlerEndpoint", {
      description: "Private HTTPS endpoint implementing approved tool adapters",
      type: "String",
    });

    const dataKey = new kms.Key(this, "DataKey", {
      alias: "alias/synode-data",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const auditKey = new kms.Key(this, "AuditKey", {
      alias: "alias/synode-audit",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 2,
      natGateways: 1,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { cidrMask: 24, name: "ingress", subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: "application", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { cidrMask: 24, name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    for (const [name, service] of [
      ["EcrApi", ec2.InterfaceVpcEndpointAwsService.ECR],
      ["EcrDocker", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ["CloudWatchLogs", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ["SecretsManager", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
    ] as const) {
      vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        privateDnsEnabled: true,
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    const flowLogGroup = new logs.LogGroup(this, "VpcFlowLogs", {
      encryptionKey: auditKey,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    vpc.addFlowLog("RejectedTraffic", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    const auditBucket = new s3.Bucket(this, "AuditEvidence", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: auditKey,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(Duration.days(30)),
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
    });
    const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      allowAllOutbound: false,
      description: "Aurora accepts PostgreSQL only from the RDS proxy",
      vpc,
    });
    const proxySecurityGroup = new ec2.SecurityGroup(this, "ProxySecurityGroup", {
      allowAllOutbound: false,
      description: "RDS Proxy accepts TLS only from Synode tasks",
      vpc,
    });
    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      allowAllOutbound: true,
      description: "Synode API and worker tasks",
      vpc,
    });

    databaseSecurityGroup.addIngressRule(
      proxySecurityGroup,
      ec2.Port.tcp(5432),
      "PostgreSQL from RDS Proxy",
    );
    proxySecurityGroup.addEgressRule(
      databaseSecurityGroup,
      ec2.Port.tcp(5432),
      "PostgreSQL to Aurora",
    );
    proxySecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(5432), "TLS from tasks");

    const database = new rds.DatabaseCluster(this, "Database", {
      backup: {
        preferredWindow: "03:00-04:00",
        retention: Duration.days(14),
      },
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      credentials: rds.Credentials.fromGeneratedSecret("synode_admin"),
      defaultDatabaseName: "synode",
      deletionProtection: true,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_9,
      }),
      iamAuthentication: true,
      parameterGroup: new rds.ParameterGroup(this, "DatabaseParameters", {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_17_9,
        }),
        parameters: { "rds.force_ssl": "1" },
      }),
      readers: [rds.ClusterInstance.serverlessV2("reader", { scaleWithWriter: true })],
      removalPolicy: RemovalPolicy.RETAIN,
      securityGroups: [databaseSecurityGroup],
      serverlessV2MaxCapacity: 8,
      serverlessV2MinCapacity: 0.5,
      storageEncrypted: true,
      storageEncryptionKey: dataKey,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      writer: rds.ClusterInstance.serverlessV2("writer"),
    });
    const databaseSecret = database.secret;
    if (!databaseSecret) throw new Error("Generated database secret is required");

    const databaseProxy = database.addProxy("DatabaseProxy", {
      borrowTimeout: Duration.seconds(30),
      iamAuth: false,
      maxConnectionsPercent: 80,
      maxIdleConnectionsPercent: 40,
      requireTLS: true,
      secrets: [databaseSecret],
      securityGroups: [proxySecurityGroup],
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      vpc,
    });
    const apiLogs = new logs.LogGroup(this, "ApiLogs", {
      encryptionKey: auditKey,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const workerLogs = new logs.LogGroup(this, "WorkerLogs", {
      encryptionKey: auditKey,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const databaseEnvironment = {
      PGDATABASE: "synode",
      PGHOST: databaseProxy.endpoint,
      PGPORT: "5432",
      PGSSLMODE: "require",
    };
    const databaseSecrets = {
      PGPASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, "password"),
      PGUSER: ecs.Secret.fromSecretsManager(databaseSecret, "username"),
    };

    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: 512,
      ephemeralStorageGiB: 30,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const apiContainer = apiTask.addContainer("Api", {
      command: ["node", "dist/server.js"],
      environment: { ...databaseEnvironment, HOST: "0.0.0.0", PORT: "4173" },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:4173/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"",
        ],
        interval: Duration.seconds(15),
        retries: 3,
        startPeriod: Duration.seconds(20),
        timeout: Duration.seconds(5),
      },
      image: ecs.ContainerImage.fromRegistry(containerImage.valueAsString),
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: "api" }),
      readonlyRootFilesystem: true,
      secrets: databaseSecrets,
    });
    apiContainer.addPortMappings({ containerPort: 4173, protocol: ecs.Protocol.TCP });

    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 512,
      ephemeralStorageGiB: 30,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    workerTask.addContainer("Worker", {
      command: ["node", "dist/worker.js"],
      environment: {
        ...databaseEnvironment,
        TENANT_SHARD: tenantShard.valueAsString,
        TOOL_HANDLER_ENDPOINT: toolHandlerEndpoint.valueAsString,
      },
      image: ecs.ContainerImage.fromRegistry(containerImage.valueAsString),
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogs, streamPrefix: "worker" }),
      readonlyRootFilesystem: true,
      secrets: databaseSecrets,
    });
    databaseSecret.grantRead(apiTask.taskRole);
    databaseSecret.grantRead(workerTask.taskRole);
    auditBucket.grantPut(apiTask.taskRole, "run-evidence/*");
    auditBucket.grantPut(workerTask.taskRole, "run-evidence/*");

    const apiService = new ecs.FargateService(this, "ApiService", {
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
      cluster,
      desiredCount: 2,
      enableExecuteCommand: false,
      healthCheckGracePeriod: Duration.seconds(45),
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      securityGroups: [taskSecurityGroup],
      taskDefinition: apiTask,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    const workerService = new ecs.FargateService(this, "WorkerService", {
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
      cluster,
      desiredCount: 2,
      enableExecuteCommand: false,
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      securityGroups: [taskSecurityGroup],
      taskDefinition: workerTask,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    apiService
      .autoScaleTaskCount({ maxCapacity: 12, minCapacity: 2 })
      .scaleOnCpuUtilization("ApiCpuScaling", { targetUtilizationPercent: 55 });
    workerService
      .autoScaleTaskCount({ maxCapacity: 24, minCapacity: 2 })
      .scaleOnCpuUtilization("WorkerCpuScaling", { targetUtilizationPercent: 60 });

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, "LoadBalancerSecurityGroup", {
      allowAllOutbound: false,
      description: "Private ingress from an account-owned identity-aware edge",
      vpc,
    });
    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "HTTPS from the VPC",
    );
    loadBalancerSecurityGroup.addEgressRule(taskSecurityGroup, ec2.Port.tcp(4173), "API targets");
    taskSecurityGroup.addIngressRule(
      loadBalancerSecurityGroup,
      ec2.Port.tcp(4173),
      "Application traffic from the load balancer",
    );

    const loadBalancer = new elasticloadbalancing.ApplicationLoadBalancer(this, "LoadBalancer", {
      internetFacing: false,
      securityGroup: loadBalancerSecurityGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    loadBalancer.setAttribute("deletion_protection.enabled", "true");
    const listener = loadBalancer.addListener("Https", {
      certificates: [
        acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn.valueAsString),
      ],
      port: 443,
      protocol: elasticloadbalancing.ApplicationProtocol.HTTPS,
      sslPolicy: elasticloadbalancing.SslPolicy.RECOMMENDED_TLS,
    });
    listener.addTargets("ApiTargets", {
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        healthyHttpCodes: "200",
        interval: Duration.seconds(15),
        path: "/healthz",
        timeout: Duration.seconds(5),
      },
      port: 4173,
      protocol: elasticloadbalancing.ApplicationProtocol.HTTP,
      targets: [apiService],
    });

    const webAcl = new waf.CfnWebACL(this, "WebAcl", {
      defaultAction: { allow: {} },
      rules: [
        {
          name: "AWSManagedCommonRules",
          overrideAction: { none: {} },
          priority: 0,
          statement: {
            managedRuleGroupStatement: { name: "AWSManagedRulesCommonRuleSet", vendorName: "AWS" },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "synode-common-rules",
            sampledRequestsEnabled: true,
          },
        },
      ],
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "synode-web-acl",
        sampledRequestsEnabled: true,
      },
    });
    new waf.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    const incidentTopic = new sns.Topic(this, "IncidentTopic", {
      displayName: "Synode control-plane alarms",
      masterKey: auditKey,
    });
    const apiTaskAlarm = new cloudwatch.Alarm(this, "ApiTaskAlarm", {
      alarmDescription: "API service has fewer than its two-task availability floor",
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      metric: apiService.metric("RunningTaskCount", {
        period: Duration.minutes(1),
        statistic: "Minimum",
      }),
      threshold: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    const databaseCpuAlarm = new cloudwatch.Alarm(this, "DatabaseCpuAlarm", {
      alarmDescription: "Aurora CPU has exceeded the operating threshold",
      evaluationPeriods: 3,
      metric: database.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const targetErrorAlarm = new cloudwatch.Alarm(this, "TargetErrorAlarm", {
      alarmDescription: "The API target group is returning sustained 5xx responses",
      evaluationPeriods: 2,
      metric: loadBalancer.metrics.httpCodeTarget(
        elasticloadbalancing.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: Duration.minutes(1), statistic: "Sum" },
      ),
      threshold: 5,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const alarm of [apiTaskAlarm, databaseCpuAlarm, targetErrorAlarm]) {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(incidentTopic));
    }

    Tags.of(this).add("Project", "synode");
    Tags.of(this).add("DataClassification", "confidential");
    Tags.of(this).add("ManagedBy", "aws-cdk");

    new CfnOutput(this, "PrivateControlPlaneUrl", {
      value: `https://${loadBalancer.loadBalancerDnsName}`,
    });
    new CfnOutput(this, "AuditBucketName", { value: auditBucket.bucketName });
    new CfnOutput(this, "IncidentTopicArn", { value: incidentTopic.topicArn });
  }
}
