"""Tagged temporary AWS compute, with an independent termination deadline."""
import argparse,base64,datetime as dt,json,pathlib,subprocess,time,os
REGION='eu-west-2';ROOT=pathlib.Path(os.environ.get('RESEARCH_RUN_ROOT','data/research/20260914-cloud-grid-v1'));RUN_ID=json.loads((ROOT/'input-manifest.json').read_text())['runId'] if os.environ.get('RESEARCH_RUN_ROOT') else 'general-purpose-compute-20260914-0000'
def save(name,value):
 ROOT.mkdir(parents=True,exist_ok=True);p=ROOT/name;t=p.with_suffix(p.suffix+'.tmp');t.write_text(json.dumps(value,indent=2));t.replace(p)
def aws(service,op,region=REGION,**kwargs):
 args=['aws',service,op,'--region',region,'--output','json','--no-cli-pager']
 for k,v in kwargs.items():
  args.append('--'+k.replace('_','-'))
  if v is not None:args.append(json.dumps(v) if isinstance(v,(dict,list)) else str(v))
 p=subprocess.run(args,capture_output=True,text=True)
 if p.returncode:raise RuntimeError(f'{service} {op}: '+p.stderr[-2000:])
 return json.loads(p.stdout) if p.stdout.strip() else {}
def provision():
 if os.environ.get('RESEARCH_RUN_ROOT'):
  price=json.loads((ROOT/'aws-price-proof.json').read_text())
  if price['instanceType']!='m7g.8xlarge' or price['region']!=REGION or time.time()-price['checkedAt']>3600 or price['hourlyUsd']*8+price['otherCostReserveUsd']>20:raise RuntimeError('Current price/budget proof required')
 if (ROOT/'aws-resources.json').exists():raise RuntimeError('Existing resource record requires inspection')
 account=aws('sts','get-caller-identity')['Account'];state={'runId':RUN_ID,'account':account,'region':REGION,'budgetUsd':20,'hourlyUsd':price['hourlyUsd'] if os.environ.get('RESEARCH_RUN_ROOT') else 1.5098};save('aws-resources.json',state)
 def record(**kw):state.update(kw);save('aws-resources.json',state)
 tags=[{'Key':'Name','Value':'general-purpose-compute'},{'Key':'RunId','Value':RUN_ID}]
 bucket=RUN_ID+'-'+account;aws('s3api','create-bucket',bucket=bucket,create_bucket_configuration={'LocationConstraint':REGION});record(bucket=bucket)
 aws('s3api','put-public-access-block',bucket=bucket,public_access_block_configuration={k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']})
 aws('s3api','put-bucket-encryption',bucket=bucket,server_side_encryption_configuration={'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]})
 aws('s3api','put-bucket-tagging',bucket=bucket,tagging={'TagSet':tags})
 role=RUN_ID+'-worker';deadline_role=RUN_ID+'-deadline'
 def trust(service):return {'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':service},'Action':'sts:AssumeRole'}]}
 wr=aws('iam','create-role',role_name=role,assume_role_policy_document=trust('ec2.amazonaws.com'),tags=tags)['Role'];record(workerRole=role,workerRoleArn=wr['Arn'])
 aws('iam','attach-role-policy',role_name=role,policy_arn='arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore')
 aws('iam','put-role-policy',role_name=role,policy_name='run-artifacts',policy_document={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':['s3:ListBucket'],'Resource':'arn:aws:s3:::'+bucket},{'Effect':'Allow','Action':['s3:GetObject','s3:PutObject'],'Resource':'arn:aws:s3:::'+bucket+'/*'}]})
 aws('iam','create-instance-profile',instance_profile_name=role);record(instanceProfile=role)
 aws('iam','add-role-to-instance-profile',instance_profile_name=role,role_name=role)
 dr=aws('iam','create-role',role_name=deadline_role,assume_role_policy_document=trust('scheduler.amazonaws.com'),tags=tags)['Role'];record(schedulerRole=deadline_role,schedulerRoleArn=dr['Arn'])
 aws('iam','put-role-policy',role_name=deadline_role,policy_name='terminate-only-this-run',policy_document={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':'ec2:TerminateInstances','Resource':f'arn:aws:ec2:{REGION}:{account}:instance/*','Condition':{'StringEquals':{'ec2:ResourceTag/RunId':RUN_ID}}}]})
 sg=aws('ec2','create-security-group',group_name=RUN_ID,description='Temporary offline compute; SSM access only',vpc_id='vpc-01ad8b570e026778a')['GroupId'];record(securityGroup=sg);aws('ec2','create-tags',resources=[sg],tags=tags)
 ami=aws('ssm','get-parameter',name='/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id')['Parameter']['Value'];record(ami=ami)
 bootstrap='''#!/bin/bash
set -euxo pipefail
systemd-run --unit=compute-hard-deadline --on-active=8h /usr/sbin/poweroff
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3-venv python3-dev build-essential sqlite3 jq unzip curl xz-utils
cd /tmp
curl -fsSLO https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-arm64.tar.xz
curl -fsSLO https://nodejs.org/dist/v22.22.0/SHASUMS256.txt
grep ' node-v22.22.0-linux-arm64.tar.xz$' SHASUMS256.txt | sha256sum -c -
tar -xJf node-v22.22.0-linux-arm64.tar.xz --strip-components=1 -C /usr/local
curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o awscliv2.zip
unzip -q awscliv2.zip
./aws/install
install -d -o ubuntu -g ubuntu /work
python3 -m venv /work/venv
/work/venv/bin/pip install numpy matplotlib requests boto3
chown -R ubuntu:ubuntu /work
systemctl start snap.amazon-ssm-agent.amazon-ssm-agent.service || true
date -u > /work/bootstrap-complete
'''
 (ROOT/'bootstrap.sh').write_text(bootstrap);time.sleep(12)
 return launch(state,bootstrap)
def launch(state,bootstrap):
 def record(**kw):state.update(kw);save('aws-resources.json',state)
 role=state['workerRole'];ami=state['ami'];sg=state['securityGroup'];bucket=state['bucket']
 dr={'Arn':state['schedulerRoleArn']}
 tags=[{'Key':'Name','Value':'general-purpose-compute'},{'Key':'RunId','Value':RUN_ID}]
 began=dt.datetime.now(dt.timezone.utc);deadline=began+dt.timedelta(hours=8);record(deadlineUtc=deadline.isoformat(),launchRequestedAt=began.isoformat())
 response=aws('ec2','run-instances',image_id=ami,instance_type='m7g.8xlarge',count=1,client_token=RUN_ID,iam_instance_profile={'Name':role},network_interfaces=[{'DeviceIndex':0,'SubnetId':'subnet-0bbe584e09f92ca1e','Groups':[sg],'AssociatePublicIpAddress':True}],block_device_mappings=[{'DeviceName':'/dev/sda1','Ebs':{'VolumeSize':200,'VolumeType':'gp3','Encrypted':True,'DeleteOnTermination':True}}],metadata_options={'HttpTokens':'required','HttpEndpoint':'enabled'},instance_initiated_shutdown_behavior='terminate',tag_specifications=[{'ResourceType':kind,'Tags':tags} for kind in ['instance','volume']],user_data=bootstrap)
 instance=response['Instances'][0]['InstanceId'];record(instanceId=instance)
 try:
  aws('scheduler','create-schedule',name=RUN_ID,schedule_expression='at('+deadline.strftime('%Y-%m-%dT%H:%M:%S')+')',schedule_expression_timezone='UTC',flexible_time_window={'Mode':'OFF'},action_after_completion='DELETE',target={'Arn':'arn:aws:scheduler:::aws-sdk:ec2:terminateInstances','RoleArn':dr['Arn'],'Input':json.dumps({'InstanceIds':[instance]}),'RetryPolicy':{'MaximumEventAgeInSeconds':3600,'MaximumRetryAttempts':10}});record(schedule=RUN_ID)
  proof=aws('scheduler','get-schedule',name=RUN_ID)
  if json.loads(proof['Target']['Input'])!={'InstanceIds':[instance]}:raise RuntimeError('deadline target mismatch')
  save('deadline-proof.json',proof)
 except BaseException:
  aws('ec2','terminate-instances',instance_ids=[instance]);record(terminatedOnDeadlineSetupFailure=True);raise
 print(json.dumps({'instanceId':instance,'name':'general-purpose-compute','deadlineUtc':state['deadlineUtc'],'bucket':bucket}))
def command(commands):
 state=json.loads((ROOT/'aws-resources.json').read_text());r=aws('ssm','send-command',instance_ids=[state['instanceId']],document_name='AWS-RunShellScript',parameters={'commands':commands,'executionTimeout':['28800']},timeout_seconds=600);print(json.dumps({'commandId':r['Command']['CommandId']}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['provision','launch','command','status']);p.add_argument('--commands');a=p.parse_args()
 if a.action=='provision':provision()
 elif a.action=='launch':launch(json.loads((ROOT/'aws-resources.json').read_text()),(ROOT/'bootstrap.sh').read_text())
 elif a.action=='command':command(json.loads(pathlib.Path(a.commands).read_text()))
 else:
  s=json.loads((ROOT/'aws-resources.json').read_text());print(json.dumps(aws('ec2','describe-instances',instance_ids=[s['instanceId']])['Reservations'][0]['Instances'][0]['State']))
