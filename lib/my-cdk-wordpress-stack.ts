import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
export class MyCdkWordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 🔹 VPC
    const vpc = new ec2.Vpc(this, 'MyVpc', { maxAzs: 2 });

    // 🔹 ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyCluster', { vpc });

    // 🔹 ECR repo
    const ecrRepo = new ecr.Repository(this, 'MyEcrRepo', {
      repositoryName: 'my-wordpress-app',
    });

    // 🔹 ECS Service
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'MyFargateService', {
      cluster,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
        containerPort: 80,
      },
      desiredCount: 1,
      publicLoadBalancer: true,
    });

    // 🔹 Output Load Balancer DNS
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
      description: 'Public URL of WordPress site',
    });

    // 🔹 Secrets Manager GitHub token
    const githubTokenSecret = secretsmanager.Secret.fromSecretNameV2(this, 'GithubToken', 'github-token');

    // 🔹 Pipeline Artifacts
    const infraSourceOutput = new codepipeline.Artifact('InfraSourceOutput');
    const appSourceOutput = new codepipeline.Artifact('AppSourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    // 🔹 Docker Build Project
    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
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
              'aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 739275466771.dkr.ecr.ap-south-1.amazonaws.com'
            ],
          },
          build: {
            commands: [
              'docker build -t my-wordpress-app .',
              'docker tag my-wordpress-app:latest 739275466771.dkr.ecr.ap-south-1.amazonaws.com/my-wordpress-app:latest',
              'docker push 739275466771.dkr.ecr.ap-south-1.amazonaws.com/my-wordpress-app:latest'
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
        },
      }),
    });

    // 🔹 Infra Deploy Project (CDK deploy)
    const infraDeployProject = new codebuild.PipelineProject(this, 'InfraDeployProject', {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'npm install -g aws-cdk',
              'npm ci'
            ],
          },
          build: {
            commands: [
              'cdk bootstrap',
              'cdk deploy --require-approval never'
            ],
          },
        },
      }),
    });

    // 🔹 Pipeline
    const pipeline = new codepipeline.Pipeline(this, 'MyWordpressPipeline', {
      pipelineName: 'WordpressPipeline',
    });

    // 🔹 Source Stage (Infra + App repo)
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

    // 🔹 Build Container Image Stage
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

    // 🔹 Deploy Stage (CDK deploy)
    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'CDK_Deploy',
          project: infraDeployProject,
          input: infraSourceOutput,
        }),
      ],
    });
  }
}
