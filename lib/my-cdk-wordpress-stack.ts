import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
// Removed ALB import for simple development setup

export class MyCdkWordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // VPC
    const vpc = new ec2.Vpc(this, 'MyVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // RDS MySQL
    const dbInstance = new rds.DatabaseInstance(this, 'WordpressDB', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_36 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
      vpc,
      allocatedStorage: 20,
      multiAz: false,
      publiclyAccessible: false,
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      databaseName: 'wordpressdb',
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      deletionProtection: false,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyCluster', { vpc });

    // ECR repo
    const ecrRepo = new ecr.Repository(this, 'MyEcrRepo', {
      repositoryName: 'my-wordpress-app',
      lifecycleRules: [{
        maxImageCount: 10,
      }],
    });

    // ECS Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'MyTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    // ECS Container
    const container = taskDef.addContainer('WordpressContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDriver.awsLogs({ 
        streamPrefix: 'wordpress',
        logRetention: 7,
      }),
      environment: {
        WORDPRESS_DB_HOST: dbInstance.dbInstanceEndpointAddress,
        WORDPRESS_DB_USER: 'admin',
        WORDPRESS_DB_NAME: 'wordpressdb',
      },
      secrets: {
        WORDPRESS_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbInstance.secret!, 'password'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    // Security group for ECS (simple setup)
    const ecsSg = new ec2.SecurityGroup(this, 'ECSSecurityGroup', { 
      vpc,
      description: 'Security group for ECS',
    });
    ecsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');

    // Allow ECS tasks to access RDS
    dbInstance.connections.allowDefaultPortFrom(ecsSg, 'Allow ECS access to RDS');

    // ECS Service (simple public setup)
    const fargateService = new ecs.FargateService(this, 'MyFargateService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Outputs
    new cdk.CfnOutput(this, 'RDS_Endpoint', {
      value: dbInstance.dbInstanceEndpointAddress,
    });

    new cdk.CfnOutput(this, 'ECR_Repository_URI', {
      value: ecrRepo.repositoryUri,
    });

    // GitHub token
    const githubTokenSecret = secretsmanager.Secret.fromSecretNameV2(this, 'GithubToken', 'github-token');

    // Artifacts
    const infraSourceOutput = new codepipeline.Artifact('InfraSourceOutput');
    const appSourceOutput = new codepipeline.Artifact('AppSourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    // Docker Build Project (for WordPress repo)
    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      environment: { 
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, 
        privileged: true,
      },
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: region },
        AWS_ACCOUNT_ID: { value: accountId },
        IMAGE_REPO_NAME: { value: ecrRepo.repositoryName },
        IMAGE_TAG: { value: 'latest' },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              `AWS_DEFAULT_REGION=${region}`,
              `AWS_ACCOUNT_ID=${accountId}`,
              `IMAGE_REPO_NAME=${ecrRepo.repositoryName}`,
              'IMAGE_TAG=latest',
              `aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com`,
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building the Docker image...',
              'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
              'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
            ],
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker image...',
              'docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
              'echo Writing image definitions file...',
              `echo '[{"name":"WordpressContainer","imageUri":"'$AWS_ACCOUNT_ID'.dkr.ecr.'$AWS_DEFAULT_REGION'.amazonaws.com/'$IMAGE_REPO_NAME':'$IMAGE_TAG'"}]' > imagedefinitions.json`,
            ],
          },
        },
        artifacts: { 
          files: ['imagedefinitions.json'],
        },
      }),
    });

    // Infra Deploy Project (for CDK repo)
    const infraDeployProject = new codebuild.PipelineProject(this, 'InfraDeployProject', {
      environment: { 
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: { 
            commands: [
              'npm install -g aws-cdk@latest',
              'npm ci',
            ],
          },
          pre_build: {
            commands: [
              'echo CDK version:',
              'cdk --version',
            ],
          },
          build: { 
            commands: [
              'echo Deploy started on `date`',
              'cdk bootstrap --require-approval never',
              'cdk deploy --require-approval never --outputs-file outputs.json',
            ],
          },
        },
        artifacts: {
          files: ['outputs.json'],
        },
      }),
    });

    // IAM permissions
    [dockerBuildProject, infraDeployProject].forEach(project => {
      project.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'ecr:*',
          'ecs:*',
          'ec2:*',
          'iam:PassRole',
          'logs:*',
          'cloudformation:*',
          'ssm:*',
          'rds:*',
          'secretsmanager:*',
          'elasticloadbalancing:*',
          'application-autoscaling:*',
        ],
        resources: ['*'],
      }));
    });

    // Grant ECR permissions to CodeBuild
    ecrRepo.grantPullPush(dockerBuildProject);

    // Pipeline
    const pipeline = new codepipeline.Pipeline(this, 'MyWordpressPipeline', {
      pipelineName: 'WordpressPipeline',
      restartExecutionOnUpdate: true,
    });

    // Source Stage
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
          runOrder: 1,
        }),
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'App_Source',
          owner: 'Harish123540',
          repo: 'wordpress',
          branch: 'master',
          oauthToken: githubTokenSecret.secretValue,
          output: appSourceOutput,
          runOrder: 1,
        }),
      ],
    });

    // Build Stage (Docker Build)
    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Docker_Build',
          project: dockerBuildProject,
          input: appSourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    // Deploy Infrastructure Stage
    pipeline.addStage({
      stageName: 'Deploy-Infrastructure',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Deploy_Infrastructure',
          project: infraDeployProject,
          input: infraSourceOutput,
        }),
      ],
    });

    // Deploy Application Stage
    pipeline.addStage({
      stageName: 'Deploy-Application',
      actions: [
        new codepipeline_actions.EcsDeployAction({
          actionName: 'Deploy_to_ECS',
          service: fargateService,
          input: buildOutput,
          deploymentTimeout: cdk.Duration.minutes(20),
        }),
      ],
    });
  }
}
