"""Verify downloaded artifacts before removing only this run's temporary AWS resources."""
import argparse,json,pathlib,subprocess,time,tarfile,hashlib,shutil
from .cloud_control import aws,ROOT,save
from .data import digest
from research.bounded_io import compact_metadata

def verify_bundle(folder,report_payloads=False):
 folder=pathlib.Path(folder)
 proof=json.loads((folder/'artifact-manifest.json').read_text());bundleproof=json.loads((folder/'bundle-proof.json').read_text());errors=[];seen=set()
 if digest(folder/'results-bundle.tar.gz')!=bundleproof['sha256'] or digest(folder/'artifact-manifest.json')!=bundleproof['manifestHash']:raise RuntimeError('Bundle or manifest hash mismatch')
 with tarfile.open(folder/'results-bundle.tar.gz','r|gz') as tar:
  for member in tar:
   if not member.isfile():continue
   name=member.name.removeprefix('./')
   if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts:raise RuntimeError('Unsafe archive path')
   if name=='artifact-manifest.json':
    if hashlib.file_digest(tar.extractfile(member),'sha256').hexdigest()!=bundleproof['manifestHash']:raise RuntimeError('Archived manifest mismatch')
    continue
   if name not in proof['files']:raise RuntimeError('Unexpected archived file '+name)
   stream=tar.extractfile(member);h=hashlib.sha256()
   keep=compact_metadata(name)
   parts=pathlib.PurePosixPath(name).parts
   if report_payloads and len(parts)>=4 and parts[:2]==('optimized-v2','scenarios'):
    selected={'pool-d0-h0-pub0','pool-d0-h0-pub60000','pool-d0-h0-pub180000','pool-d5000-h2500-pub0','pool-d5000-h2500-pub180000'}
    if parts[2] in selected:
     keep=keep or len(parts)==4 or parts[3]=='scores'
     if parts[2] in {'pool-d0-h0-pub0','pool-d5000-h2500-pub180000'} and parts[3]=='accounts':keep=True
   destination=folder/name
   if keep:destination.parent.mkdir(parents=True,exist_ok=True)
   output=destination.open('wb') if keep else None
   for block in iter(lambda:stream.read(1048576),b''):
    h.update(block)
    if output:output.write(block)
   if output:output.close()
   if h.hexdigest()!=proof['files'][name]:errors.append(name)
   seen.add(name)
 errors.extend(set(proof['files'])-seen)
 if errors:raise RuntimeError('Downloaded artifact verification failed: '+str(errors[:10]))
 return proof

def cleanup(download,report_payloads=False):
 state=json.loads((ROOT/'aws-resources.json').read_text());instance=state['instanceId'];bucket=state['bucket'];folder=pathlib.Path(download);folder.mkdir(parents=True,exist_ok=True)
 # Terminate compute first once the caller has completed the remote result archive.
 aws('s3api','head-object',bucket=bucket,key='archive/bundle-proof.json')
 for key in ['archive/results-bundle.tar.gz','archive/bundle-proof.json','results/artifact-manifest.json']:
  subprocess.run(['aws','s3','cp','s3://'+bucket+'/'+key,str(folder/key.split('/')[-1]),'--only-show-errors'],check=True)
 proof=verify_bundle(folder,report_payloads)
 save('download-verification.json',{'files':len(proof['files']),'manifestHash':digest(folder/'artifact-manifest.json'),'verified':True,'at':int(time.time()*1000)})
 aws('ec2','terminate-instances',instance_ids=[instance])
 subprocess.run(['aws','ec2','wait','instance-terminated','--region',state['region'],'--instance-ids',instance],check=True)
 def optional(service,op,**kw):
  try:return aws(service,op,**kw)
  except RuntimeError as e:
   if any(x in str(e) for x in ['NotFound','NoSuchEntity','does not exist']):return
   raise
 optional('scheduler','delete-schedule',name=state['schedule'])
 for attempt in range(20):
  try:optional('ec2','delete-security-group',group_id=state['securityGroup']);break
  except RuntimeError as e:
   if 'DependencyViolation' not in str(e) or attempt==19:raise
   time.sleep(10)
 optional('iam','remove-role-from-instance-profile',instance_profile_name=state['instanceProfile'],role_name=state['workerRole'])
 optional('iam','delete-instance-profile',instance_profile_name=state['instanceProfile'])
 optional('iam','detach-role-policy',role_name=state['workerRole'],policy_arn='arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore')
 optional('iam','delete-role-policy',role_name=state['workerRole'],policy_name='run-artifacts');optional('iam','delete-role',role_name=state['workerRole'])
 optional('iam','delete-role-policy',role_name=state['schedulerRole'],policy_name='terminate-only-this-run');optional('iam','delete-role',role_name=state['schedulerRole'])
 subprocess.run(['aws','s3','rm','s3://'+bucket,'--recursive','--only-show-errors'],check=True)
 # Abort only unfinished transfers in this temporary bucket.
 for u in aws('s3api','list-multipart-uploads',bucket=bucket).get('Uploads',[]):aws('s3api','abort-multipart-upload',bucket=bucket,key=u['Key'],upload_id=u['UploadId'])
 aws('s3api','delete-bucket',bucket=bucket)
 volumes=aws('ec2','describe-volumes',filters=[{'Name':'tag:RunId','Values':[state['runId']]}])['Volumes']
 if volumes:raise RuntimeError('Tagged volumes still exist; inspect before declaring cleanup complete')
 save('cleanup.json',{'complete':True,'instance':instance,'verifiedFiles':len(proof['files']),'at':int(time.time()*1000),'bucketRemoved':True,'temporaryRolesRemoved':True,'taggedVolumesRemaining':0})
 print('Verified results downloaded; temporary AWS resources removed')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--download',required=True);p.add_argument('--report-payloads',action='store_true');a=p.parse_args();cleanup(a.download,a.report_payloads)
