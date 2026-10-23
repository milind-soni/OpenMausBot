import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runControlOmb, launchVerificationServer } from '../control-omb.ts';
import { afterAll, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const evidenceDir=join(tmpdir(),'openmausbot-verification-evidence');
mkdirSync(evidenceDir,{recursive:true});
const OUT=join(evidenceDir,`inherited-auto-${Date.now()}.json`);
const mcp=`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
let result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:
r.method==='tools/list'?{tools:[{name:'read_status',description:'Harmless approval-boundary probe; returns synthetic status only.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:{};
if(r.method==='tools/call'){appendFileSync(process.env.PROBE_RECEIPTS,'read_status\\n');result={content:[{type:'text',text:'synthetic status: ready'}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`;
async function poll(fn,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,40));}throw Error('Probe condition timed out');}
function rows(dataDir){const db=new DatabaseSync(join(dataDir,'runtime.db'),{readOnly:true});try{return db.prepare('SELECT json FROM assignments').all().map(x=>JSON.parse(x.json));}finally{db.close();}}
const evidence=[];
it.each([
  {name:'direct-inherited-auto',room:false,chief:true,sourceMode:'auto',own:'ask',decision:'allow'},
  {name:'room-inherited-auto-allow',room:true,chief:true,sourceMode:'auto',own:'ask',decision:'allow'},
  {name:'room-inherited-auto-deny',room:true,chief:true,sourceMode:'auto',own:'ask',decision:'deny'},
  {name:'room-ask-control',room:true,chief:true,sourceMode:'ask',own:'ask',decision:'allow'},
  {name:'room-own-auto-control',room:true,chief:false,sourceMode:'ask',own:'auto',decision:'allow'},
  {name:'room-inherited-auto-malformed',room:true,chief:true,sourceMode:'auto',own:'ask',decision:'malformed'},
  {name:'room-inherited-auto-revoked',room:true,chief:true,sourceMode:'auto',own:'ask',decision:'allow',revoke:true},

  {name:'room-inherited-auto-unavailable',room:true,chief:true,sourceMode:'auto',own:'ask',decision:'unavailable'},
])('$name agrees on record, envelope and execution boundaries', async (test)=>{
 let reviews=0, mainRequests=0, fixture, releaseReview;
 const bodies=[];
 const model=createServer(async(req,res)=>{
   if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:['probe-main','probe-review'].map(id=>({id,context_length:131072}))}));return;}
   let text='';for await(const c of req)text+=c;const b=JSON.parse(text);bodies.push(b);
   const review=b.messages.some(m=>typeof m.content==='string'&&m.content.includes('independent execution reviewer'));
   if(review){reviews++;if(test.decision==='unavailable'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic reviewer unavailable'}}));return;}assert.equal(b.model,'probe-review');assert(!b.tools?.length);if(test.revoke)await new Promise(r=>{releaseReview=r;});const content=test.decision==='malformed'?'not a JSON verdict':JSON.stringify({decision:test.decision,reason:'Synthetic bounded probe verdict'});if(b.stream){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}else{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}));}return;}
   mainRequests++;
   const last=b.messages.findLastIndex(m=>m.role==='user');const hasResult=b.messages.slice(last+1).some(m=>m.role==='tool');
   const tool=b.tools?.find(t=>t.function.description?.includes('Harmless approval-boundary probe'))?.function.name;
   const delta=hasResult?{content:'PROBE_COMPLETED'}:{tool_calls:[{index:0,id:'probe-call',type:'function',function:{name:tool??'probe_read_status',arguments:'{}'}}]};
   res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:hasResult?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise(r=>model.listen(0,'127.0.0.1',r));
 try{
  fixture=await launchVerificationServer({},undefined,undefined,undefined,undefined,{scripted:true});
  const {url,dataDir,logPath}=fixture.info;
  const api=async(method,path,body,status=200)=>{const r=await fetch(url+path,{method,headers:{origin:url,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  const cli=(...args)=>runControlOmb([...args,'--url',url]);
  const lead=(await cli('new-bot','--name','Probe Chief','--section','Engineering')).bot;
  const worker=(await cli('new-bot','--name','Probe Worker','--section','Engineering')).bot;
  await api('PATCH',`/api/bots/${worker.id}`,{approvalMode:'ask'});
  await api('PATCH',`/api/bots/${lead.id}`,{chiefOfStaff:test.chief,approvalMode:test.sourceMode,acknowledgeLocalAuto:test.sourceMode==='auto'});
  await api('PUT','/api/config',{openaiCompat:{key:'synthetic-probe-key',url:`http://127.0.0.1:${model.address().port}/v1`,model:'probe-main'}});
  await api('POST','/api/instances/openaiCompat/refresh-models',{});
  await api('PUT','/api/config',{approvalReview:{model:{instanceId:'openaiCompat',model:'probe-review'},instructions:'Read only the synthetic status. No external actions.'}});
  const script=join(dataDir,'probe-mcp.mjs'),receipts=join(dataDir,'probe-receipts.txt');writeFileSync(script,mcp);
  await api('POST','/api/mcp/servers',{name:'probe',command:process.execPath,args:[script],env:{PROBE_RECEIPTS:receipts},enabled:true},201);
  await api('PATCH','/api/mcp/servers/probe',{enabled:true});
  await cli('set-model','--bot',worker.id,'--instance','openaiCompat','--model','probe-main');
  await api('PATCH',`/api/bots/${worker.id}`,{mcpServers:['probe'],toolScope:{allow:['mcp:probe:read_status']},approvalMode:test.own,acknowledgeLocalAuto:test.own==='auto'});
  const group=test.room?(await api('POST','/api/groups',{name:'Probe Room',memberIds:[worker.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:worker.id}}},201)).group:undefined;
  const planPath=join(dataDir,'room-plan.json');
  writeFileSync(planPath,JSON.stringify({[lead.id]:{script:[
    {key:'send',match:['PROBE_REQUEST'],steps:[{arguments:{bot_ids:[worker.id],...(group?{group_id:group.id}:{}),message:'Read the harmless synthetic status, then report PROBE_COMPLETED.'}}],reply:'Probe assigned'},
    {key:'resume',match:['Your downstream room requests have settled.'],reply:'Probe results received'},
  ]}}));
  await cli('send','--bot',lead.id,'--task',lead.activeTaskId,'--text','PROBE_REQUEST: have Probe Worker read the harmless synthetic status. No external actions.');
  const child=await poll(()=>existsSync(join(dataDir,'runtime.db'))&&rows(dataDir).find(r=>r.parentId&&r.assignee.botId===worker.id));
  if(test.revoke){await poll(()=>reviews>0&&releaseReview);await api('PATCH',`/api/bots/${lead.id}/tasks/${lead.activeTaskId}`,{approvalMode:'ask'});releaseReview();}
  await poll(async()=>{const msgs=(await api('GET',`/api/threads/${child.assignee.destination.threadId}/messages?limit=100`)).messages;return rows(dataDir).some(r=>r.id===child.id&&['completed','failed','cancelled'].includes(r.status))||msgs.some(m=>m.card?.requestId&&!m.card.answered);});
  const before=(await api('GET',`/api/threads/${child.assignee.destination.threadId}/messages?limit=100`)).messages;
  const card=before.find(m=>m.card?.requestId&&!m.card.answered);
  if(card)await api('POST',`/api/threads/${child.assignee.destination.threadId}/respond`,{requestId:card.card.requestId,behavior:'deny'});
  await poll(()=>rows(dataDir).some(r=>r.id===child.id&&['completed','failed','cancelled'].includes(r.status)));
  const final=rows(dataDir).find(r=>r.id===child.id);
  const eventDB=new DatabaseSync(join(dataDir,'runtime.db'),{readOnly:true});const events=eventDB.prepare('SELECT kind,detail FROM assignment_events WHERE assignment_id=?').all(child.id);eventDB.close();
  const executions=existsSync(receipts)?readFileSync(receipts,'utf8').trim().split('\n').length:0;
  const expectedMode=test.name==='room-ask-control'?'ask':'auto';
  assert.equal(final.level,expectedMode);
  const envelopeLevel=(JSON.stringify(bodies.filter(b=>b.model==='probe-main').map(b=>b.messages)).match(/Your level for this is ([^:]+):/)??[])[1];
  assert(envelopeLevel.startsWith(expectedMode==='auto'?'Auto':'Ask'));
  const allowed=test.decision==='allow'&&!test.revoke&&test.sourceMode!=='ask'||test.name==='room-own-auto-control';
  assert.equal(executions,allowed?1:0);
  assert.equal(Boolean(card),test.name==='room-ask-control'||['malformed','unavailable'].includes(test.decision)||Boolean(test.revoke));
  assert.equal(reviews,test.name==='room-ask-control'?0:1);
  evidence.push({case:test.name,fixtureLog:logPath,recordedLevel:final.level,levelSource:final.levelSource,envelopeLevel:(JSON.stringify(bodies.filter(b=>b.model==='probe-main').map(b=>b.messages)).match(/Your level for this is ([^:]+):/)??[])[1],reviews,reviewerModel:reviews?'probe-review':null,pendingHumanCard:Boolean(card),executions,status:final.status,events,mainRequests,result:final.result});
 }catch(error){evidence.push({case:test.name,error:String(error),fixtureLog:fixture?.info.logPath});throw error;}
 finally{releaseReview?.();await fixture?.close();model.closeAllConnections();await new Promise(r=>model.close(r));}
},60000);
afterAll(()=>{writeFileSync(OUT,JSON.stringify({evidence},null,2)+'\n');console.info(JSON.stringify({evidence:OUT}));});
