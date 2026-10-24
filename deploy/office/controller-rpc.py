#!/usr/bin/python3 -I
"""One fixed SSH RPC: commit an eligible HEL1 native attempt, with no model or job execution."""
import fcntl,json,os,pathlib,re,signal,socket,stat,subprocess,sys,time,urllib.request,uuid

ROOT=pathlib.Path('/var/lib/orca/.local/share/openmaus-controller')
URL='http://127.0.0.1:28799'
WORKER='c7fbfb41-e544-4c72-b741-fa12536a290a'
POLICY='office-control-v1'

def refuse():
 print(json.dumps({'ok':False,'error':'Office controller refused this attempt'}),flush=True)
 raise SystemExit(1)

def private_json(path):
 s=path.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077:raise ValueError('private file required')
 return json.loads(path.read_text())

def listening():
 with socket.socket() as s:
  s.settimeout(.2)
  return s.connect_ex(('127.0.0.1',28799))==0

def tunnel():
 deadline=time.monotonic()+9
 fd=os.open(ROOT/'run/tunnel.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'r+') as lock:
  while True:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    if time.monotonic()>=deadline:raise TimeoutError()
    time.sleep(.025)
  if listening():return
  with (ROOT/'logs/worker-tunnel.log').open('ab') as log:
   child=subprocess.Popen([str(ROOT/'bin/worker-tunnel')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True,env={'HOME':'/var/lib/orca','USER':'orca','LOGNAME':'orca','PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
  (ROOT/'run/worker-tunnel.pid').write_text(str(child.pid)+'\n')
  try:
   while not listening():
    if child.poll() is not None or time.monotonic()>=deadline:raise TimeoutError()
    time.sleep(.025)
  except BaseException:
   child.terminate()
   try:child.wait(timeout=1)
   except subprocess.TimeoutExpired:child.kill();child.wait(timeout=1)
   raise

def eligible(attempt,policy,now):
 p=policy['profiles'].get(attempt.get('profileId'))
 return bool(p and attempt.get('workerId')==WORKER and attempt.get('version')==1
  and attempt.get('driverKind')=='codex' and attempt.get('instanceId')==p['instanceId']
  and attempt.get('botId')==attempt.get('profileId')
  and (attempt.get('cwd')==p['cwd'] or attempt.get('cwd') in policy.get('sharedProjectCwds',[]))
  and attempt.get('kind')=='work' and now<attempt.get('startBefore',0)<=attempt.get('rootDeadline',0)
  and attempt.get('rootDeadline',0)-now<=30*60*1000+1000
  and re.fullmatch('[a-f0-9]{64}',attempt.get('digest',''))
  and re.fullmatch('[a-f0-9]{64}',attempt.get('profileDigest','')))

def main():
 os.umask(0o077)
 signal.alarm(24)
 if os.uname().nodename!='orch-hel1' or os.environ.get('SSH_ORIGINAL_COMMAND'):refuse()
 line=sys.stdin.buffer.readline(4097)
 if len(line)>4096 or not line.endswith(b'\n'):refuse()
 request=json.loads(line)
 if set(request)!={'version','attemptId','capability','workerId'} or request['version']!=1 or request['workerId']!=WORKER:refuse()
 attempt_id=str(uuid.UUID(request['attemptId']))
 if attempt_id!=request['attemptId'] or not re.fullmatch('[A-Za-z0-9_-]{43}',request['capability']):refuse()
 policy=private_json(ROOT/'office-policy.json')
 if policy['version']!=POLICY or policy['workerId']!=WORKER:refuse()
 tunnel()
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def read(path,body=None,cap=True):
  headers={'Authorization':'Bearer '+request['capability']} if cap else {}
  if body is not None:headers['Content-Type']='application/json'
  req=urllib.request.Request(URL+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
  with opener.open(req,timeout=4) as r:
   raw=r.read(65537)
   if len(raw)>65536:raise ValueError()
   return json.loads(raw)
 identity=read('/.well-known/openmausbot/environment',cap=False)
 if identity.get('environmentId')!=WORKER or identity.get('version')!=policy['workerVersion']:refuse()
 path='/api/office-control/attempts/'+attempt_id
 attempt=read(path)['attempt']
 if attempt.get('attemptId')!=attempt_id:refuse()
 if attempt.get('state')=='issued' and eligible(attempt,policy,time.time()*1000):
  d=attempt.get('controllerDecision',{})
  if d.get('controllerHost')=='orch-hel1' and d.get('policyVersion')==POLICY and d.get('decision')=='allow':
   print(json.dumps({'ok':True,'attemptId':attempt_id,'controllerDecisionId':d['controllerDecisionId']}),flush=True);return
 decision='allow' if attempt.get('state')=='prepared' and eligible(attempt,policy,time.time()*1000) else 'deny'
 directive={k:attempt[k] for k in ['version','attemptId','generation','digest','workerId','profileDigest','cwd','rootDeadline','startBefore','kind']}
 directive.update(decision=decision,controllerHost='orch-hel1',controllerDecisionId=str(uuid.uuid4()),policyVersion=POLICY)
 committed=read(path+'/directive',directive)
 if not committed.get('ok') or committed.get('attempt',{}).get('controllerDecision',{}).get('controllerDecisionId')!=directive['controllerDecisionId']:refuse()
 with (ROOT/'logs/office-decisions.jsonl').open('a') as log:
  log.write(json.dumps({'at':time.time(),'controllerHost':'orch-hel1','attemptId':attempt_id,'assignmentId':attempt['assignmentId'],'rootId':attempt['rootId'],'workerId':WORKER,'decisionId':directive['controllerDecisionId'],'policyVersion':POLICY,'decision':decision})+'\n')
 if decision!='allow':refuse()
 print(json.dumps({'ok':True,'attemptId':attempt_id,'controllerDecisionId':directive['controllerDecisionId']}),flush=True)

if __name__=='__main__':
 try:main()
 except (Exception,KeyboardInterrupt):refuse()
