import test from 'node:test';
import assert from 'node:assert/strict';
import {PROVIDERS,defaults,validateConfig,publicConfig,mergePublicConfig,pcmToWav,transcribeCloud,createRequestRegistry} from './stt-core.mjs';
const pcm=new Int16Array(16000).buffer;
test('Retired Windows recognizers disappear; migration preserves cloud credentials and chosen OpenRouter',()=>{
 for(const provider of ['windows-sapi','windows-speech']){
  assert(!PROVIDERS.some(p=>p.id===provider));
  const cfg=validateConfig({...defaults('win32'),provider,profiles:{openrouter:{key:'synthetic-key'}}},'win32');
  assert.equal(cfg.provider,'windows-typing');assert.equal(cfg.profiles.openrouter.key,'synthetic-key');
 }
 const cfg=validateConfig({...defaults('win32'),provider:'openrouter',profiles:{openrouter:{key:'synthetic-key'}}},'win32');
 assert.equal(cfg.provider,'openrouter');assert.equal(cfg.profiles.openrouter.key,'synthetic-key');
 assert(PROVIDERS.some(p=>p.id==='windows-typing'));assert(PROVIDERS.some(p=>p.id==='apple-speech'));
});
test('Platform defaults, provider filtering, bounded settings and HTTPS validation',()=>{
 for(const [platform,provider] of [['win32','windows-typing'],['darwin','apple-speech'],['linux','whisper-local']])assert.equal(validateConfig(defaults(platform),platform).provider,provider);
 assert.equal(validateConfig(defaults('win32'),'win32').profiles.openrouter.model,'openai/whisper-large-v3');
 assert.throws(()=>validateConfig({...defaults(),provider:'apple-speech'},'win32'));
 for(const threads of [0,17,2.5])assert.throws(()=>validateConfig({...defaults(),threads}));
 for(const endpoint of ['http://example.com','https://user:pass@example.com','https://example.com/?key=secret','file:///etc/passwd'])assert.throws(()=>validateConfig({...defaults(),profiles:{compatible:{endpoint}}}));
 assert.doesNotThrow(()=>validateConfig({...defaults(),profiles:{compatible:{endpoint:'http://127.0.0.1:8080/v1'}}}));
});
test('Secrets are redacted, preserved on ordinary saves, and explicitly removable',()=>{
 const cfg=validateConfig({...defaults(),profiles:{openai:{key:'test-secret'}}});const pub=publicConfig(cfg);
 assert(!JSON.stringify(pub).includes('test-secret'));assert.equal(pub.profiles.openai.hasKey,true);
 assert.equal(mergePublicConfig(cfg,pub).profiles.openai.key,'test-secret');
 assert.equal(mergePublicConfig(cfg,{profiles:{openai:{clearKey:true}}}).profiles.openai.key,'');
});
test('16kHz mono WAV headers and audio-size bounds',()=>{
 const wav=pcmToWav(pcm);assert.equal(wav.length,32044);assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(40),32000);
 assert.throws(()=>pcmToWav(new ArrayBuffer(3)));assert.throws(()=>pcmToWav(new ArrayBuffer(16000*2*36)));
});
for(const provider of ['openrouter','openai','groq','deepgram','azure','compatible'])test(`${provider}: actual request construction and response parsing`,async()=>{
 const cfg=validateConfig({...defaults(),provider,language:'de-DE',profiles:{[provider]:{key:'test-key',endpoint:provider==='azure'?'https://unit.cognitiveservices.azure.com':'http://127.0.0.1:18990/v1'}}});
 let seen=false;
 const text=await transcribeCloud(cfg,pcm,new AbortController().signal,async(url,options)=>{
  seen=true;assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  if(provider==='azure'){assert.equal(url.searchParams.get('language'),'de-DE');assert.equal(options.headers['Ocp-Apim-Subscription-Key'],'test-key');assert(url.pathname.startsWith('/stt/'));assert.equal(options.body.toString('ascii',0,4),'RIFF');return Response.json({RecognitionStatus:'Success',DisplayText:'Hallo Welt.'});}
  if(provider==='deepgram'){assert.equal(options.headers.Authorization,'Token test-key');assert.equal(url.searchParams.get('language'),'de');return Response.json({results:{channels:[{alternatives:[{transcript:'Hallo Welt.'}]}]}});}
  assert.equal(options.headers.Authorization,'Bearer test-key');assert.equal(options.body.get('language'),'de');assert.equal(options.body.get('file').type,'audio/wav');assert(url.pathname.endsWith('/audio/transcriptions'));
  if(provider==='openrouter'){assert.equal(url.href,'https://openrouter.ai/api/v1/audio/transcriptions');assert.equal(options.body.get('model'),'openai/whisper-large-v3');}
  if(provider==='openai')assert.equal(url.hostname,'api.openai.com');if(provider==='groq')assert.equal(url.hostname,'api.groq.com');return Response.json({text:'Hallo Welt.'});
 });assert(seen);assert.equal(text,'Hallo Welt.');
});
test('Missing credentials fail before uploading; error bodies cannot leak secrets',async()=>{
 const cfg=validateConfig({...defaults(),provider:'openai'});await assert.rejects(transcribeCloud(cfg,pcm,null,()=>{throw Error('Should not fetch')}),/API key/);
 cfg.profiles.openai.key='secret';for(const status of [401,403,429,500])await assert.rejects(transcribeCloud(cfg,pcm,null,async()=>new Response('secret server message',{status})),e=>!e.message.includes('secret'));
 await assert.rejects(transcribeCloud(cfg,pcm,null,async()=>Response.json({garbage:1})),/transcript field/);
});
test('Sessions are isolated by window and stale sessions are invalidated',()=>{
 const r=createRequestRegistry(),a=r.begin(1,{}),s=r.get(1,a),b=r.begin(2,{});r.begin(1,{});assert(s.controller.signal.aborted);assert.throws(()=>r.get(1,a));assert.doesNotThrow(()=>r.get(2,b));r.cancel(2,'wrong-id');assert.doesNotThrow(()=>r.get(2,b));r.cancel(2,b);assert.throws(()=>r.get(2,b));
});
