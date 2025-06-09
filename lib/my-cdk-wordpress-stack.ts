import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

export class MyCdkWordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 🔹 VPC
    const vpc = new ec2.Vpc(this, 'MyVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // 🔹 ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyCluster', { vpc });

    // 🔹 ECR repo
    const ecrRepo = new ecr.Repository(this, 'MyEcrRepo', {
      repositoryName: 'my-wordpress-app',
    });

    // 🔹 ECS Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'MyTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDef.addContainer('WordpressContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'wordpress' }),
    });

    // 🔹 Security group
    const sg = new ec2.SecurityGroup(this, 'WordpressSG', { vpc });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');

    // 🔹 ECS Service
    new ecs.FargateService(this, 'MyFargateService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [sg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    new cdk.CfnOutput(this, 'ServicePublicIP', {
      value: 'Dynamic public IP assigned by ECS task (check in ECS console).',
    });

    // 🔹 GitHub token
    const githubTokenSecret = secretsmanager.Secret.fromSecretNameV2(this, 'GithubToken', 'github-token');

    // 🔹 Artifacts
    const infraSourceOutput = new codepipeline.Artifact('InfraSourceOutput');
    const appSourceOutput = new codepipeline.Artifact('AppSourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    // 🔹 Docker Build Project (for WordPress repo)
    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, privileged: true },
      environmentVariables: {
        DOCKER_HUB_USERNAME: { value: 'ashish8979' },
        DOCKER_HUB_PASSWORD: { value: 'ashishchaudhary-12345' },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to DockerHub...',
              'echo $DOCKER_HUB_PASSWORD | docker login --username $DOCKER_HUB_USERNAME --password-stdin',
              'aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 975826764450.dkr.ecr.ap-south-1.amazonaws.com',
            ],
          },
          build: {
            commands: [
              'docker build -t my-wordpress-app .',
              'docker tag my-wordpress-app:latest 975826764450.dkr.ecr.ap-south-1.amazonaws.com/my-wordpress-app:latest',
              'docker push 975826764450.dkr.ecr.ap-south-1.amazonaws.com/my-wordpress-app:latest',
            ],
          },
        },
        artifacts: { files: ['imagedefinitions.json'] },
      }),
    });

    // 🔹 Infra Deploy Project (for CDK repo)
    const infraDeployProject = new codebuild.PipelineProject(this, 'InfraDeployProject', {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: { commands: ['npm install -g aws-cdk', 'npm ci'] },
          build: { commands: ['cdk bootstrap', 'cdk deploy --require-approval never'] },
        },
      }),
    });

    // 🔹 IAM permissions
    [dockerBuildProject, infraDeployProject].forEach(project => {
      project.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ecr:*', 'ecs:*', 'ec2:*', 'iam:PassRole', 'logs:*', 'cloudformation:*', 'ssm:*'],
        resources: ['*'],
      }));
    });

    // 🔹 Pipeline
    const pipeline = new codepipeline.Pipeline(this, 'MyWordpressPipeline', {
      pipelineName: 'WordpressPipeline',
    });

    // 🔹 Source Stage
    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'Infra_Source',
          owner: 'Harish123540',
          repo: 'wordpress-infra',
          branch: 'master',
          oauthToken: githubTokenSecret.secretValue,
          output: infraSourceOutput,
        }),
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'App_Source',
          owner: 'Harish123540',
          repo: 'wordpress',
          branch: 'master',
          oauthToken: githubTokenSecret.secretValue,
          output: appSourceOutput,
        }),
      ],
    });

    // 🔹 Build (Docker) Stage for App
    pipeline.addStage({
      stageName: 'Build-Container',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Docker_Build',
          project: dockerBuildProject,
          input: appSourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    // 🔹 Infra Deploy Stage
    pipeline.addStage({
      stageName: 'Build-and-Deploy-Infrastructure',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Infra_Deploy',
          project: infraDeployProject,
          input: infraSourceOutput,
        }),
      ],
    });
  }
}
