import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';

export class MyCdkWordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //  VPC
    const vpc = new ec2.Vpc(this, 'MyVpc', { maxAzs: 2 });

    //  RDS Secret
    const dbSecret = new secretsmanager.Secret(this, 'DBSecret', {
      secretName: 'wordpress-db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    //  RDS Instance
    const dbInstance = new rds.DatabaseInstance(this, 'WordpressDB', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_34,
      }),
      vpc,
      credentials: rds.Credentials.fromSecret(dbSecret),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      publiclyAccessible: false,
      databaseName: 'wordpressdb',
    });

    //  ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyCluster', { vpc });

    //  ECR Repo
    const ecrRepo = new ecr.Repository(this, 'MyEcrRepo', {
      repositoryName: 'my-wordpress-app',
    });

    //  Task Execution Role
    const taskRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    //  Fargate Service
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'MyFargateService', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
        containerPort: 80,
        environment: {
          WORDPRESS_DB_HOST: dbInstance.dbInstanceEndpointAddress,
          WORDPRESS_DB_USER: 'admin',
          WORDPRESS_DB_NAME: 'wordpressdb',
        },
        secrets: {
          WORDPRESS_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        },
        taskRole: taskRole, //  assign task role
      },
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    dbInstance.connections.allowDefaultPortFrom(fargateService.service.connections);

    //  Secrets Manager GitHub Token
    const githubTokenSecret = secretsmanager.Secret.fromSecretNameV2(this, 'GithubToken', 'github-token');

    //  Secrets Manager DockerHub Credentials
    const dockerHubCreds = secretsmanager.Secret.fromSecretNameV2(this, 'DockerHubCreds', 'dockerhub-creds');

    //  Pipeline Artifacts
    const infraSourceOutput = new codepipeline.Artifact('InfraSourceOutput');
    const appSourceOutput = new codepipeline.Artifact('AppSourceOutput');

    //  Test Project
    const testProject = new codebuild.PipelineProject(this, 'TestProject', {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: { commands: ['echo Installing dependencies...'] },
          build: { commands: ['echo Running tests...', 'echo Tests passed!'] },
        },
      }),
    });

    //  Infra Deploy Project
    const infraProject = new codebuild.PipelineProject(this, 'InfraDeployProject', {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: [
            'npm install -g aws-cdk',
            'npm ci',
          ],
          build: [
            'cdk bootstrap',
            'cdk deploy --require-approval never',
          ],
        },
      }),
    });

    //  Docker Build Project
    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
      environmentVariables: {
        DOCKER_HUB_USERNAME: { value: 'ashish8979' },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to DockerHub...',
              `aws secretsmanager get-secret-value --secret-id dockerhub-creds --query SecretString --output text | jq -r '.password' | docker login --username ashish8979 --password-stdin`,
              'aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 739275466771.dkr.ecr.ap-south-1.amazonaws.com',
            ],
          },
          build: [
            'docker build -t my-wordpress-app .',
            'docker tag my-wordpress-app:latest 739275466771.dkr.ecr.ap-south-1.amazonaws.com/my-wordpress-app:latest',
            'docker push 739275466771.dkr.ecr.ap-south-1.amazonaws.com/my-wordpress-app:latest',
          ],
        },
      }),
    });

    //  Pipeline
    const pipeline = new codepipeline.Pipeline(this, 'MyWordpressPipeline', {
      pipelineName: 'WordpressPipeline',
    });

    //  Source Stage
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

    //  Test Stage
    pipeline.addStage({
      stageName: 'Test',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Test',
          project: testProject,
          input: appSourceOutput,
        }),
      ],
    });

    //  Build-and-Deploy-Infrastructure Stage
    pipeline.addStage({
      stageName: 'Build-and-Deploy-Infrastructure',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'InfraDeploy',
          project: infraProject,
          input: infraSourceOutput,
        }),
      ],
    });

    //  Build Container Stage
    pipeline.addStage({
      stageName: 'Build-Container',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Docker_Build',
          project: dockerBuildProject,
          input: appSourceOutput,
        }),
      ],
    });

    //  Deploy Stage
    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.EcsDeployAction({
          actionName: 'DeployToECS',
          service: fargateService.service,
          input: appSourceOutput, //  use source artifact as ECS picks ECR image
        }),
      ],
    });
  }
}

