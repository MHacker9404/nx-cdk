import * as cdk from '@aws-cdk/core';
import { Tags } from '@aws-cdk/core';
import { ServiceStack } from './stacks/ServiceStack';
import { VpcStack } from './stacks/VpcStack';

// https://docs.aws.amazon.com/cdk/latest/guide/environments.html
const env = {
    account: process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION,
};
const app = new cdk.App({ context: env });
const branch = app.node.tryGetContext('branch') || null;
const version = app.node.tryGetContext('version') || null;

const vpc = new VpcStack(app, 'VpcStack', { env, description: 'VPC Infrastructure' });
if (branch) {
    const service = new ServiceStack(app, `Service-${branch}-Stack`, {
        env,
        branch,
        version,
        clusterArn: vpc.cluster.clusterArn,
        clusterName: vpc.cluster.clusterName,
        vpcSGId: vpc.vpcSG.securityGroupId,
        sqlSGId: vpc.sqlSG.securityGroupId,
        subnets: vpc.subnets.map((s) => s.subnetId),
        adminSecretArn: vpc.adminSecret.secretArn,
        taskDefinitionExecutionRoleArn: vpc.taskDefinitionExecutionRole.roleArn,
        taskDefinitionTaskRoleArn: vpc.taskDefinitionTaskRole.roleArn,
    });
    Tags.of(service).add('branch', `${branch}`);
    Tags.of(service).add('version', `${version}`);
}

Tags.of(app).add('App', 'ecs-repo-branch');
