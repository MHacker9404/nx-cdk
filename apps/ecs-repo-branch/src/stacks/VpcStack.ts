import { Construct, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import {
    Vpc,
    SubnetConfiguration,
    SubnetType,
    VpcProps,
    SecurityGroup,
    Peer,
    Port,
    ISecurityGroup,
    ISubnet,
    InterfaceVpcEndpointAwsService,
    InterfaceVpcEndpoint,
    GatewayVpcEndpointAwsService,
} from '@aws-cdk/aws-ec2';
import { ISecret, Secret } from '@aws-cdk/aws-secretsmanager';
import { Cluster, ClusterProps, ICluster } from '@aws-cdk/aws-ecs';
import { Effect, IRole, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { StringParameter } from '@aws-cdk/aws-ssm';

export class VpcStack extends Stack {
    public readonly cluster: ICluster;
    public readonly vpcSG: ISecurityGroup;
    public readonly sqlSG: ISecurityGroup;
    public readonly subnets: ISubnet[];
    public readonly adminSecret: ISecret;
    public readonly taskDefinitionExecutionRole: IRole;
    public readonly taskDefinitionTaskRole: IRole;

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        //  build the permissions, policies, roles
        const taskDefinitionExecutionPolicy: ManagedPolicy = new ManagedPolicy(this, 'Task Execution Policy', {
            managedPolicyName: `TaskExecutionPolicy`,
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
                    resources: ['arn:aws:ecr:us-east-1:ACCOUNT-ID:repository/ECR-REPO-NAME'],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['ssm:*'],
                    resources: ['*'],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['ecr:GetAuthorizationToken', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                    resources: ['*'],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'secretsmanager:GetSecretValue',
                        'secretsmanager:DescribeSecret',
                        'secretsmanager:GetResourcePolicy',
                        'secretsmanager:ListSecretVersionIds',
                        'secretsmanager:ListSecrets',
                    ],
                    resources: ['arn:aws:secretsmanager:us-east-1:ACCOUNT-ID:secret:*'],
                }),
            ],
        });
        this.taskDefinitionExecutionRole = new Role(this, 'Task Execution Role', {
            roleName: 'TaskExecutionRole',
            assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                ManagedPolicy.fromManagedPolicyArn(
                    this,
                    'AmazonECSTaskExecutionRolePolicy',
                    'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
                ),
            ],
        });
        taskDefinitionExecutionPolicy.attachToRole(this.taskDefinitionExecutionRole);

        const taskDefinitionTaskPolicy: ManagedPolicy = new ManagedPolicy(this, 'Task Definition Policy', {
            managedPolicyName: `TaskDefinitionPolicy`,
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'secretsmanager:GetSecretValue',
                        'secretsmanager:DescribeSecret',
                        'secretsmanager:GetResourcePolicy',
                        'secretsmanager:ListSecretVersionIds',
                        'secretsmanager:ListSecrets',
                    ],
                    resources: ['arn:aws:secretsmanager:us-east-1:ACCOUNT-ID:secret:*'],
                }),
            ],
        });
        this.taskDefinitionTaskRole = new Role(this, 'Task Definition Role', {
            roleName: 'TaskDefinitionRole',
            assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        taskDefinitionTaskPolicy.attachToRole(this.taskDefinitionTaskRole);

        // build the VPC
        const subnetConfiguration: SubnetConfiguration[] = [
            {
                name: 'public',
                cidrMask: 24,
                subnetType: SubnetType.PUBLIC,
            },
        ];
        const vpcProps: VpcProps = {
            cidr: '10.0.0.0/16',
            subnetConfiguration,
            maxAzs: 99,
        };
        const vpc = new Vpc(this, 'VPC', vpcProps);
        this.subnets = vpc.publicSubnets;

        this.vpcSG = SecurityGroup.fromSecurityGroupId(this, 'webSG', vpc.vpcDefaultSecurityGroup);
        this.vpcSG.addIngressRule(Peer.ipv4('999.999.999.999/32'), Port.tcp(80), 'Specific IP address', false);
        this.vpcSG.addIngressRule(Peer.ipv4('34.228.4.208/28'), Port.tcpRange(0, 65535), 'CodeBuild - us-east-1', false);

        this.sqlSG = new SecurityGroup(this, 'SQL-SG', {
            securityGroupName: 'SQL-SG',
            vpc,
            description: 'SQL Security Group',
            allowAllOutbound: true,
        });
        this.sqlSG.addIngressRule(this.vpcSG, Port.tcp(1433), 'Web SG', false);
        this.vpcSG.addIngressRule(Peer.ipv4('999.999.999.999/32'), Port.tcp(1433), 'Specific IP address', false);
        this.sqlSG.addIngressRule(Peer.ipv4('34.228.4.208/28'), Port.tcpRange(0, 65535), 'CodeBuild - us-east-1', false);

        // RDS credentials
        this.adminSecret =
            Secret.fromSecretNameV2(this, 'db-admin', 'dev/db-admin') ||
            new Secret(this, 'db-admin', {
                secretName: 'dev/db-admin',
                removalPolicy: RemovalPolicy.RETAIN,
                generateSecretString: {
                    secretStringTemplate: JSON.stringify({ username: 'userid_sa' }),
                    generateStringKey: 'password',
                },
            });

        // build Fargate cluster
        const clusterProps: ClusterProps = {
            capacityProviders: ['FARGATE'],
            clusterName: 'cluster-name',
            vpc: vpc,
            containerInsights: false,
        };
        this.cluster = new Cluster(this, 'Fargate', clusterProps);

        //  interface endpoinsts required for ECS
        const ecrDockerEndpoint = new InterfaceVpcEndpoint(this, 'ECR Docker Endpoint', {
            service: InterfaceVpcEndpointAwsService.ECR_DOCKER,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const ecrApiEndpoint = new InterfaceVpcEndpoint(this, 'ECR API Endpoint', {
            service: InterfaceVpcEndpointAwsService.ECR,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        vpc.addGatewayEndpoint('S3 Gateway Endpoint', {
            service: GatewayVpcEndpointAwsService.S3,
            subnets: [{ subnets: vpc.publicSubnets }],
        });
        const ecsAgentEndpoint = new InterfaceVpcEndpoint(this, 'ECS Agent Endpoint', {
            service: InterfaceVpcEndpointAwsService.ECS_AGENT,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const ecsTelemetryEndpoint = new InterfaceVpcEndpoint(this, 'ECS Telemetry Endpoint', {
            service: InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const ecsEndpoint = new InterfaceVpcEndpoint(this, 'ECS Endpoint', {
            service: InterfaceVpcEndpointAwsService.ECS,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const secretsEndpoint = new InterfaceVpcEndpoint(this, 'Secrets Endpoint', {
            service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const ssmEndpoint = new InterfaceVpcEndpoint(this, 'SSM Endpoint', {
            service: InterfaceVpcEndpointAwsService.SSM,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const ssmMessagesEndpoint = new InterfaceVpcEndpoint(this, 'SSM Messages Endpoint', {
            service: InterfaceVpcEndpointAwsService.SSM_MESSAGES,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const ec2MessagesEndpoint = new InterfaceVpcEndpoint(this, 'EC2 Messages Endpoint', {
            service: InterfaceVpcEndpointAwsService.EC2_MESSAGES,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const cloudwatchEndpoint = new InterfaceVpcEndpoint(this, 'CloudWatch Endpoint', {
            service: InterfaceVpcEndpointAwsService.CLOUDWATCH,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });
        const cloudwatchLogsEndpoint = new InterfaceVpcEndpoint(this, 'CloudWatch Logs Endpoint', {
            service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            vpc: vpc,
            subnets: { subnets: vpc.publicSubnets },
        });

        // need the ids for the other stack
        new StringParameter(this, `VpcId`, { parameterName: `vpcid`, stringValue: vpc.vpcId });
    }
}
