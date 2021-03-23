import * as cdk from '@aws-cdk/core';
import {
    Cluster,
    ContainerImage,
    DeploymentControllerType,
    FargatePlatformVersion,
    FargateService,
    FargateTaskDefinition,
    LogDriver,
    Protocol,
    Secret as EcsSecret,
} from '@aws-cdk/aws-ecs';
import { Repository } from '@aws-cdk/aws-ecr';
import { InstanceClass, InstanceSize, InstanceType, SecurityGroup, Subnet, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import {
    DatabaseInstanceEngine,
    DatabaseInstanceFromSnapshot,
    DatabaseInstanceFromSnapshotProps,
    LicenseModel,
    SnapshotCredentials,
    SqlServerEngineVersion,
    SqlServerExInstanceEngineProps,
    StorageType,
} from '@aws-cdk/aws-rds';
import { Duration, RemovalPolicy } from '@aws-cdk/core';
import { Secret } from '@aws-cdk/aws-secretsmanager';
import { StringParameter } from '@aws-cdk/aws-ssm';
import { Role } from '@aws-cdk/aws-iam';
import {
    ApplicationListener,
    ApplicationLoadBalancer,
    ApplicationProtocol,
    ApplicationTargetGroup,
    IpAddressType,
    TargetType,
} from '@aws-cdk/aws-elasticloadbalancingv2';

export interface ServiceStackProps extends cdk.StackProps {
    branch: string;
    version: string;
    clusterArn: string;
    clusterName: string;
    vpcSGId: string;
    sqlSGId: string;
    subnets: string[];
    adminSecretArn: string;
    taskDefinitionExecutionRoleArn: string;
    taskDefinitionTaskRoleArn: string;
}

export class ServiceStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props: ServiceStackProps) {
        super(scope, id, props);

        const vpcId = StringParameter.valueFromLookup(this, 'vpcid');
        const vpc = Vpc.fromLookup(this, `VPC`, { vpcId: vpcId });

        // build the application load balancer
        const vpcSG = SecurityGroup.fromSecurityGroupId(this, 'VPC-SG', props.vpcSGId);
        const targetGroup = new ApplicationTargetGroup(this, 'Target Group', {
            targetGroupName: `${props.branch}`,
            targetType: TargetType.IP,
            protocol: ApplicationProtocol.HTTP,
            port: 5000,
            vpc: vpc,
        });
        const alb = new ApplicationLoadBalancer(this, 'Load Balancer', {
            vpc: vpc,
            internetFacing: true,
            ipAddressType: IpAddressType.IPV4,
            loadBalancerName: `${props.branch}`,
            securityGroup: vpcSG,
            vpcSubnets: { subnets: vpc.publicSubnets },
        });
        new ApplicationListener(this, 'Listener 80', {
            loadBalancer: alb,
            defaultTargetGroups: [targetGroup],
            open: false,
            port: 80,
            protocol: ApplicationProtocol.HTTP,
        });
        new ApplicationListener(this, 'Listener 5000', {
            loadBalancer: alb,
            defaultTargetGroups: [targetGroup],
            open: false,
            port: 5000,
            protocol: ApplicationProtocol.HTTP,
        });

        const repoArn = 'arn:aws:ecr:us-east-1:ACCOUNT-ID:repository/ECR-REPO-NAME';
        const repo = Repository.fromRepositoryArn(this, 'Repository', repoArn);

        // build the RDS
        const adminSecret = Secret.fromSecretCompleteArn(this, 'Admin-Secret', props.adminSecretArn);

        const instanceProps: SqlServerExInstanceEngineProps = {
            version: SqlServerEngineVersion.of('14.00.3356.20.v1', '14.00'),
        };

        const sqlSG = SecurityGroup.fromSecurityGroupId(this, 'SQL-SG', props.sqlSGId);
        const dbInstanceProps: DatabaseInstanceFromSnapshotProps = {
            snapshotIdentifier: 'snapshot',
            credentials: SnapshotCredentials.fromPassword(adminSecret.secretValueFromJson('password')),
            engine: DatabaseInstanceEngine.sqlServerEx(instanceProps),
            instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.MICRO),
            licenseModel: LicenseModel.LICENSE_INCLUDED,
            allowMajorVersionUpgrade: false,
            timezone: 'Eastern Standard Time',
            allocatedStorage: 20,
            vpc: vpc,
            instanceIdentifier: `db-${props.branch}`,
            storageType: StorageType.GP2,
            vpcSubnets: { subnetType: SubnetType.PUBLIC },
            securityGroups: [sqlSG],
            cloudwatchLogsExports: ['error'],
            autoMinorVersionUpgrade: false,
            backupRetention: Duration.days(0),
            deleteAutomatedBackups: true,
            publiclyAccessible: true,
            deletionProtection: false,
            removalPolicy: RemovalPolicy.DESTROY,
        };
        const rds = new DatabaseInstanceFromSnapshot(this, 'MS-SQL', dbInstanceProps);

        const executionRole = Role.fromRoleArn(
            this,
            `Execution Role - ${props.branch}`,
            props.taskDefinitionExecutionRoleArn
        );
        const definitionRole = Role.fromRoleArn(this, `Definition Role - ${props.branch}`, props.taskDefinitionTaskRoleArn);
        const fargateTask = new FargateTaskDefinition(this, 'TaskDefinition', {
            family: `${props.branch}`,
            cpu: 256,
            memoryLimitMiB: 512,
            executionRole: executionRole,
            taskRole: definitionRole,
        });
        const containerImage: ContainerImage = ContainerImage.fromEcrRepository(repo, props.version);
        const containerDefinition = fargateTask.addContainer(`container-${props.branch}`, {
            image: containerImage,
            environment: {
                DB_Host: rds.dbInstanceEndpointAddress,
                DB_Database: DB - NAME,
                DB_User: DB - ADMIN,
                NO_COLOR: 'true' /** stop NestJS color logging */,
            },
            secrets: {
                DB_Password: EcsSecret.fromSecretsManager(adminSecret, 'password'),
            },
            logging: LogDriver.awsLogs({
                streamPrefix: `${props.branch}`,
            }),
        });
        containerDefinition.addPortMappings({ containerPort: 5000, hostPort: 5000, protocol: Protocol.TCP });

        const cluster = Cluster.fromClusterAttributes(this, `Cluster - ${props.branch}`, {
            vpc,
            clusterArn: props.clusterArn,
            clusterName: props.clusterName,
            securityGroups: [vpcSG, sqlSG],
        });
        const service = new FargateService(this, 'Fargate', {
            taskDefinition: fargateTask,
            assignPublicIp: false,
            vpcSubnets: { subnets: props.subnets.map((s, i) => Subnet.fromSubnetId(this, `Subnet-${i}`, s)) },
            securityGroups: [vpcSG, sqlSG],
            platformVersion: FargatePlatformVersion.LATEST,
            cluster: cluster,
            deploymentController: { type: DeploymentControllerType.ECS },
            desiredCount: 1,
            serviceName: `service-${props.branch}`,
            maxHealthyPercent: 200,
            minHealthyPercent: 100,
            circuitBreaker: { rollback: false },
        });
        service.attachToApplicationTargetGroup(targetGroup);

        new StringParameter(this, `${props.branch}-db-host`, {
            parameterName: `${props.branch}-db-host`,
            stringValue: rds.dbInstanceEndpointAddress,
        });
        new StringParameter(this, `${props.branch}-service-arn`, {
            parameterName: `${props.branch}-service-arn`,
            stringValue: service.serviceArn,
        });
        new StringParameter(this, `${props.branch}-alb-dns-name`, {
            parameterName: `${props.branch}-alb-dns-name`,
            stringValue: alb.loadBalancerDnsName,
        });
    }
}
