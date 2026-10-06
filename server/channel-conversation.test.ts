import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelConversation, type ChannelSnapshot } from "./channel-conversation.ts";
import type { OptionCardData } from "../shared/wire.ts";
import { channelQuestions, formatChannelQuestion } from "../shared/channel-replies.ts";
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const question:OptionCardData={title:"Question",subtitle:"Which destination?",options:["Pune","Mumbai"],requestId:"question-1",requestType:"question"};
const approval:OptionCardData={title:"Approval",subtitle:"echo fixture",options:["Allow once","Deny"],requestId:"approval-1",requestType:"permission",tool:"Bash"};
function fixture(card=question){
 const root=mkdtempSync(join(tmpdir(),"omb-channel-conversation-"));roots.push(root);const file=join(root,"state.json");
 let now=100;let settled=false;let current=structuredClone(card);let thread="thread";let request="send";
 const send=vi.fn(async(t:string,s:string)=>{thread=t;request=s;});const createAskTask=vi.fn(()=>thread);
 const respond=vi.fn(async()=>{settled=true;return {};});
 const snapshot=():ChannelSnapshot=>({messageId:"source",activeLeafId:settled?"final":"card",activeTurnId:settled?null:"turn",executionId:"execution",phase:settled?"settled":"waiting",messages:[
  {id:"source",role:"user",kind:"text",text:"Work",at:1,sendId:request},
  ...(settled?[{id:"final",role:"bot" as const,kind:"text" as const,text:"done",at:3,turnTerminal:true,turnSucceeded:true,requestMessageId:"source",turnId:"turn"}]:[{id:"card",role:"bot" as const,kind:"options" as const,card:current,at:2,requestMessageId:"source",turnId:"turn"}])
 ]});
 const make=()=>new ChannelConversation({file,binding:"owner-binding",createAskTask,send,snapshot,respond,now:()=>now,sleep:async()=>{now+=120000;}});
 return {file,make,send,respond,createAskTask,set settled(v:boolean){settled=v},set card(v:OptionCardData){current=v},set now(v:number){now=v}};
}
it("sends options and resumes the original task from a numbered answer",async()=>{
 const f=fixture(),c=f.make();const prompt=await c.handle("first","Find a trip");expect(prompt).toContain("1. Pune");expect(prompt).toContain("2. Mumbai");
 expect(await c.handle("answer","2")).toContain("done");expect(f.createAskTask).toHaveBeenCalledTimes(1);expect(f.send).toHaveBeenCalledTimes(1);
 expect(f.respond).toHaveBeenCalledWith(expect.objectContaining({threadId:"thread",requestId:"question-1"}),"answer",expect.stringContaining("Mumbai"));
});
it("keeps free-text questions answerable and preserves pending state on restart",async()=>{
 const f=fixture({...question,options:[]}),c=f.make();expect(await c.handle("first","hello")).toContain("Which destination?");
 const restored=f.make();expect(await restored.handle("answer","Somewhere quiet")).toContain("done");expect(f.createAskTask).toHaveBeenCalledTimes(1);
 expect(f.respond).toHaveBeenCalledWith(expect.anything(),"answer",expect.stringContaining("Somewhere quiet"));
});
it("accepts a plain yes only for the currently presented approval",async()=>{
 const f=fixture(approval),c=f.make();const prompt=await c.handle("first","Run fixture");
 expect(prompt).toMatch(/yes.*approve/i);expect(prompt).not.toMatch(/APPROVE [A-F0-9]{8}/);
 await c.handle("wrong","APPROVE WRONG123");expect(f.respond).not.toHaveBeenCalled();
 expect(await c.handle("yes","YES")).toContain("done");expect(f.respond).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId:"approval-1"}),"allow",undefined);
 await c.handle("duplicate-command","YES");expect(f.respond).toHaveBeenCalledTimes(1);expect(f.send).toHaveBeenCalledTimes(1);
});
it.each(["no","deny"])("declines only the matching pending approval with %s",async(text)=>{
 const f=fixture(approval),c=f.make();await c.handle("first","Run fixture");
 await c.handle("deny",text);expect(f.respond).toHaveBeenCalledExactlyOnceWith(expect.anything(),"deny",undefined);
});
it("refuses expired or changed approval cards without executing",async()=>{
 const f=fixture(approval),c=f.make();await c.handle("first","Run fixture");
 f.card={...approval,subtitle:"different command"};expect(await c.handle("stale","yes")).toMatch(/changed|no longer|again/i);expect(f.respond).not.toHaveBeenCalled();
 await c.handle("refresh","STATUS");f.now=24*60*60*1000;
 expect(await c.handle("expired","yes")).toMatch(/expired/i);expect(f.respond).not.toHaveBeenCalled();
});
it("never lets two queued yes replies approve consecutive cards",async()=>{
 const f=fixture(approval),c=f.make();await c.handle("first","Run");
 f.respond.mockImplementation(async()=>{f.card={...approval,requestId:"approval-2",subtitle:"second command"};return {};});
 const one=c.handle("one","yes"),two=c.handle("two","yes");await one;
 expect(await two).toMatch(/changed|current|STATUS/i);expect(f.respond).toHaveBeenCalledTimes(1);
});
it("rejects a delayed event older than the presented approval",async()=>{
 const f=fixture(approval),c=f.make();f.now=2000;await c.handle("first","Run");f.now=3000;
 expect(await c.handle("old","yes",{channel:"imessage",maxReplyCharacters:18000,receivedAt:3000,eventTimestamp:999})).toMatch(/changed|current|STATUS/i);expect(f.respond).not.toHaveBeenCalled();
});
it("persists automatic approval for this conversation, revokes it, and resets it for NEW",async()=>{
 const f=fixture(approval),c=f.make();expect(c.approvalMode).toBe("ask");
 expect(await c.handle("auto","approve for me")).toMatch(/Automatic/);expect(c.approvalMode).toBe("auto");expect(f.send).not.toHaveBeenCalled();
 const restored=f.make();expect(restored.approvalMode).toBe("auto");await restored.handle("first","Run");expect(f.respond).toHaveBeenCalledTimes(1);
 expect(await restored.handle("ask","ask me first")).toMatch(/Ask first/);expect(f.make().approvalMode).toBe("ask");
 await restored.handle("auto-again","approve for me");await restored.handle("new","NEW Separate task");expect(restored.approvalMode).toBe("ask");
});
it("automatic mode leaves questions and oversized approvals for the owner",async()=>{
 for(const card of [question,{...approval,subtitle:"x".repeat(16000)},{...approval,profileRequest:{}} as OptionCardData]){
 const f=fixture(card),c=f.make();await c.handle("auto","approve for me");await c.handle("first","Run");expect(f.respond).not.toHaveBeenCalled();
 }
});
it("collects multiple questions before answering the single provider card",async()=>{
 const f=fixture({...question,questionRequest:{version:1,questions:[{question:"Where?",options:[{label:"Pune"},{label:"Mumbai"}]},{question:"When?",options:[]}]}}),c=f.make();
 expect(await c.handle("first","Plan")).toContain("Where?");expect(await c.handle("one","1")).toContain("When?");expect(f.respond).not.toHaveBeenCalled();
 expect(await c.handle("two","Tomorrow")).toContain("done");expect(f.respond).toHaveBeenCalledWith(expect.anything(),"answer",expect.stringMatching(/Pune[\s\S]*Tomorrow/));
});
it("does not replay an interrupted applying response after restart",async()=>{
 const f=fixture(),c=f.make();await c.handle("first","hello");const state=JSON.parse(readFileSync(f.file,"utf8"));state.pending.applying=true;writeFileSync(f.file,JSON.stringify(state));
 const restored=f.make();expect(await restored.handle("answer","1")).toMatch(/interrupted|STATUS/i);expect(f.respond).not.toHaveBeenCalled();
});
it("fails closed for corrupt or mismatched state instead of creating new work",async()=>{
 const f=fixture();writeFileSync(f.file,'{"version":1,"binding":"another owner"}');const c=f.make();expect(await c.handle("first","hello")).toMatch(/state|unavailable/i);expect(f.createAskTask).not.toHaveBeenCalled();
});
it("does not answer a card already settled in the app or start another task from its stale reply",async()=>{
 const f=fixture(),c=f.make();await c.handle("first","hello");f.settled=true;
 expect(await c.handle("answer","1")).toMatch(/already answered|changed/);expect(f.respond).not.toHaveBeenCalled();expect(f.createAskTask).toHaveBeenCalledTimes(1);
});
it("persists an applying fence before host delivery and does not retry an unknown outcome",async()=>{
 const f=fixture(approval),c=f.make();await c.handle("first","Run fixture");const code=JSON.parse(readFileSync(f.file,"utf8")).pending.code;
 f.respond.mockImplementation(async()=>{expect(JSON.parse(readFileSync(f.file,"utf8")).pending.applying).toBe(true);throw new Error("unknown delivery");});
 expect(await c.handle("answer",`APPROVE ${code}`)).toMatch(/could not be confirmed/);
 await c.handle("retry",`APPROVE ${code}`);expect(f.respond).toHaveBeenCalledTimes(1);
});
it("returns the cached duplicate answer without responding twice, including after restart",async()=>{
 const f=fixture(),c=f.make();await c.handle("first","hello");const reply=await c.handle("answer","1");
 expect(await c.handle("answer","1")).toBe(reply);expect(await f.make().handle("answer","1")).toBe(reply);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(await c.handle("answer","2")).toMatch(/already used/);
});
it("rotates explicit answer codes between questions so an old coded reply cannot answer the next",async()=>{
 const f=fixture({...question,questionRequest:{version:1,questions:[{question:"Where?",options:[{label:"Pune"}]},{question:"When?",options:[]}]}}),c=f.make();
 const first=await c.handle("first","Plan"),code=JSON.parse(readFileSync(f.file,"utf8")).pending.code; expect(first).not.toMatch(/Request code|ANSWER/);
 const second=await c.handle("one",`ANSWER ${code} 1`);expect(second).not.toContain(`Request code: ${code}`);
 expect(await c.handle("late",`ANSWER ${code} 1`)).toMatch(/does not match/);expect(f.respond).not.toHaveBeenCalled();
});
it("never offers a truncated approval on a small transport",async()=>{
 const f=fixture({...approval,subtitle:"full command details ".repeat(100)}),c=f.make();
 const prompt=await c.handle("first","Run",{channel:"text",maxReplyCharacters:1600});expect(prompt).not.toContain("APPROVE");expect(prompt.length).toBeLessThan(1600);
 expect(JSON.parse(readFileSync(f.file,"utf8")).pending).toBeUndefined();
});
it("automatically notifies a question that appears after the initial wait",async()=>{
 const root=mkdtempSync(join(tmpdir(),"omb-channel-notify-"));roots.push(root);let now=0,ready=false,sendId="";
 const notify=vi.fn(async(_id:string,_text:string,_channel:string)=>{});
 const c=new ChannelConversation({file:join(root,"state.json"),binding:"binding",createAskTask:()=>"thread",send:async(_t,s)=>{sendId=s;},respond:async()=>({}),now:()=>now,sleep:async()=>{now+=120000;},notify,
 snapshot:()=>({messageId:"source",activeLeafId:ready?"card":"source",activeTurnId:"turn",executionId:"exec",phase:"working",messages:[{id:"source",role:"user",kind:"text",at:1,sendId},...(ready?[{id:"card",role:"bot" as const,kind:"options" as const,at:2,card:question,turnId:"turn",requestMessageId:"source"}]:[])]})});
 expect(await c.handle("first","hello")).toMatch(/still working/);ready=true;
 await vi.waitFor(()=>expect(notify).toHaveBeenCalledTimes(1),{timeout:2000});expect(notify.mock.calls[0]?.[1]).toContain("Pune");
});
it("keeps invalid-answer feedback within the transport limit", async () => {
 const overhead = formatChannelQuestion(channelQuestions(question)![0]!, "12345678", 0, 1).length - question.subtitle!.length;
 const f = fixture({ ...question, subtitle: "Q".repeat(1590 - overhead) }), c = f.make();
 expect((await c.handle("first", "Question", {channel:"text",maxReplyCharacters:1600})).length).toBe(1590);
 const feedback = await c.handle("invalid", "99");
 expect(feedback.length).toBeLessThanOrEqual(1600); expect(feedback).toContain("Choose a number");
 expect(f.respond).not.toHaveBeenCalled();
});

it("continues ordinary messages in the same task across restart with a fresh request identity", async () => {
 const f=fixture(), c=f.make(); f.settled=true;
 await c.handle("one","First"); const first=JSON.parse(readFileSync(f.file,"utf8")).active;
 await f.make().handle("two","Second"); const second=JSON.parse(readFileSync(f.file,"utf8")).active;
 expect(second.threadId).toBe(first.threadId); expect(second.sendId).not.toBe(first.sendId);
 expect(f.createAskTask).toHaveBeenCalledTimes(1);
 expect(f.send).toHaveBeenLastCalledWith("thread", second.sendId, "Second", {expectedActiveLeafId:"final"});
 await f.make().handle("three","NEW Separate"); expect(f.createAskTask).toHaveBeenCalledTimes(2);
});
it("does not return a previous request's successful final", async () => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-stale-")); roots.push(root); let sendId="";
 const c=new ChannelConversation({file:join(root,"state.json"),binding:"binding",createAskTask:()=>"thread",send:async(_t,s)=>{sendId=s;},respond:async()=>({}),snapshot:()=>({messageId:"current",activeLeafId:"old",activeTurnId:null,executionId:null,phase:"settled",messages:[{id:"current",role:"user",kind:"text",at:1,sendId},{id:"old",role:"bot",kind:"text",at:0,text:"OLD RESULT",turnTerminal:true,turnSucceeded:true,requestMessageId:"previous"}]})});
 expect(await c.handle("one","First")).not.toContain("OLD RESULT");
});
it("returns promptly then preserves an ordinary followup until the active request settles", async () => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-followup-")); roots.push(root); let now=0,ready=false,sendId="",count=0; const sent:string[]=[];
 const options={file:join(root,"state.json"),binding:"binding",createAskTask:()=>"thread",send:async(_t:string,s:string,text:string)=>{sendId=s; sent.push(text); count++;},respond:async()=>({}),now:()=>now,sleep:async()=>{now+=100;},snapshot:():ChannelSnapshot=>({messageId:`source${count}`,activeLeafId:ready?`final${count}`:`source${count}`,activeTurnId:ready?null:"turn",executionId:"exec",phase:ready?"settled":"working",messages:[{id:`source${count}`,role:"user",kind:"text",at:1,sendId},...(ready?[{id:`final${count}`,role:"bot" as const,kind:"text" as const,at:2,text:`done ${count}`,turnTerminal:true,turnSucceeded:true,requestMessageId:`source${count}`}]:[])]})};
 const c=new ChannelConversation(options); expect(await c.handle("first","First")).toMatch(/still working/); expect(now).toBeLessThanOrEqual(2000);
 expect(await c.handle("second","Remember my followup")).toMatch(/saved|queued/i);
 expect(sent).toEqual(["First"]); ready=true;
 const restored=new ChannelConversation(options); expect(await restored.handle("status","STATUS")).toBe("done 1"); await restored.handle("status-two","STATUS"); expect(sent).toEqual(["First","Remember my followup"]);
});
it("automatically delivers both results when a followup arrives during work", async () => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-two-results-")); roots.push(root);
 let ready=false,sendId="",count=0,closed=false,now=0; const notices:string[]=[];
 const c=new ChannelConversation({file:join(root,"state.json"),binding:"binding",closed:()=>closed,createAskTask:()=>"thread",send:async(_t,s)=>{sendId=s;count++;},respond:async()=>({}),now:()=>now,sleep:async()=>{now+=1500;},notify:async(_id,text)=>{notices.push(text);},snapshot:()=>({messageId:`source${count}`,activeLeafId:ready?`final${count}`:`source${count}`,activeTurnId:ready?null:"turn",executionId:"exec",phase:ready?"settled":"working",messages:[{id:`source${count}`,role:"user",kind:"text",at:1,sendId},...(ready?[{id:`final${count}`,role:"bot" as const,kind:"text" as const,at:2,text:`**Result ${count}**`,turnTerminal:true,turnSucceeded:true,requestMessageId:`source${count}`}]:[])]})});
 try {
  await c.handle("one","First"); await c.handle("two","Second"); ready=true;
  await vi.waitFor(()=>expect(notices).toEqual(["Result 1","Result 2"]),{timeout:2000});
 } finally {closed=true;}
});
it("keeps approval command markers literal while question prose is plain", async () => {
 const a=fixture({...approval,subtitle:"echo '**literal**'"}); expect(await a.make().handle("one","Run")).toContain("echo '**literal**'");
 const q=fixture({...question,subtitle:"Choose **a city**",options:["**Pune**","Mumbai"]});
 expect(await q.make().handle("one","Plan")).toContain("Choose a city\n\n1. Pune");
});
it("bounds saved followup text so its private state can be restored", async () => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-bounded-")); roots.push(root);let now=0,sendId="";
 const options={file:join(root,"state.json"),binding:"binding",createAskTask:()=>"thread",send:async(_t:string,s:string)=>{sendId=s;},respond:async()=>({}),now:()=>now,sleep:async()=>{now+=1500;},snapshot:():ChannelSnapshot=>({messageId:"source",activeLeafId:"source",activeTurnId:"turn",executionId:"exec",phase:"working",messages:[{id:"source",role:"user",kind:"text",at:1,sendId}]})};
 const c=new ChannelConversation(options);await c.handle("one","First");
 expect(await c.handle("large","好".repeat(32000))).toContain("saved");
 expect(await c.handle("overflow","More")).toMatch(/full|finish before/i);
 expect(await new ChannelConversation(options).handle("status","STATUS")).toContain("still working");
});
it("preserves a followup when a late question appears before the observer sees it", async () => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-late-question-")); roots.push(root);let now=0,sendId="",ready=false;const sent:string[]=[];
 const c=new ChannelConversation({file:join(root,"state.json"),binding:"binding",createAskTask:()=>"thread",send:async(_t,s,text)=>{sendId=s;sent.push(text);},respond:async()=>({}),now:()=>now,sleep:async()=>{now+=1500;},snapshot:()=>({messageId:"source",activeLeafId:ready?"card":"source",activeTurnId:null,executionId:null,phase:ready?"settled":"working",messages:[{id:"source",role:"user",kind:"text",at:1,sendId},...(ready?[{id:"card",role:"bot" as const,kind:"options" as const,at:2,card:question,requestMessageId:"source"}]:[])]})});
 await c.handle("one","First");ready=true;
 expect(await c.handle("two","Also compare trains")).toContain("saved");
 expect(sent).toEqual(["First"]);
 expect(await c.handle("status","STATUS")).toContain("Which destination?");
});
it("does not block incoming owner dispatch while a deferred notice awaits transport", async () => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-notice-interleave-")); roots.push(root);let now=0,sendId="",ready=false,closed=false,notified=false;
 const c=new ChannelConversation({file:join(root,"state.json"),binding:"binding",closed:()=>closed,createAskTask:()=>"thread",send:async(_t,s)=>{sendId=s;},respond:async()=>({}),now:()=>now,sleep:async()=>{now+=1500;},notify:async()=>{
  // The real transport can be handling this owner callback before its queued
  // notice is allowed to send. Waiting for it must not hold our dispatch lock.
  await c.handle("two","Second");notified=true;
 },snapshot:()=>({messageId:"source",activeLeafId:ready?"final":"source",activeTurnId:null,executionId:null,phase:ready?"settled":"working",messages:[{id:"source",role:"user",kind:"text",at:1,sendId},...(ready?[{id:"final",role:"bot" as const,kind:"text" as const,at:2,text:"done",turnTerminal:true,turnSucceeded:true,requestMessageId:"source"}]:[])]})});
 try {await c.handle("one","First");ready=true;await vi.waitFor(()=>expect(notified).toBe(true),{timeout:1500});} finally {closed=true;}
});
it.each([["count", ["One", "Two", "Three", "Four", "Five"]], ["text size", ["好".repeat(32000)]]] as const)("keeps accepted followups running after rejecting a full queue by %s", async (_limit, followups) => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-full-queue-"));roots.push(root);
 let ready=false,sendId="",count=0,closed=false,now=0;const notices:string[]=[];const sent:string[]=[];
 const c=new ChannelConversation({file:join(root,"state.json"),binding:"binding",closed:()=>closed,createAskTask:()=>"thread",send:async(_t,s,text)=>{sendId=s;count++;sent.push(text);},respond:async()=>({}),now:()=>now,sleep:async()=>{now+=1500;},notify:async(_id,text)=>{notices.push(text);},snapshot:()=>({messageId:`source${count}`,activeLeafId:ready?`final${count}`:`source${count}`,activeTurnId:ready?null:"turn",executionId:"exec",phase:ready?"settled":"working",messages:[{id:`source${count}`,role:"user",kind:"text",at:1,sendId},...(ready?[{id:`final${count}`,role:"bot" as const,kind:"text" as const,at:2,text:`Result ${count}`,turnTerminal:true,turnSucceeded:true,requestMessageId:`source${count}`}]:[])]})});
 try {
  await c.handle("initial","First");
  for(const [index,text] of followups.entries())expect(await c.handle(`accepted${index}`,text)).toContain("saved");
  expect(await c.handle("rejected","MUST NOT RUN")).toContain("queue is full");ready=true;
  await vi.waitFor(()=>expect(notices).toHaveLength(followups.length+1),{timeout:3500});
  expect(sent).toEqual(["First",...followups]);expect(notices[0]).toBe("Result 1");
 }finally{closed=true;}
});
it("explains expired questions without referring to hidden codes",async()=>{
 const f=fixture(),c=f.make();await c.handle("first","Plan");f.now=24*60*60*1000+101;
 const reply=await c.handle("expired","1");expect(reply).toMatch(/question.*expired/i);expect(reply).not.toMatch(/code|ANSWER/);
});
it("explains oversized questions without referring to hidden codes",async()=>{
 const f=fixture({...question,subtitle:"Long context ".repeat(200)}),c=f.make();
 const reply=await c.handle("first","Plan",{channel:"text",maxReplyCharacters:1600});
 expect(reply).toContain("too long");expect(reply).not.toMatch(/code|ANSWER/);
});
it("rejects ambiguous coarse same-second approval replies",async()=>{
 const f=fixture(approval),c=f.make();f.now=10_123;await c.handle("first","Run");f.now=10_456;
 await c.handle("yes","yes",{channel:"imessage",maxReplyCharacters:18000,receivedAt:10_456,eventTimestamp:10_000});expect(f.respond).not.toHaveBeenCalled();
});
it("does not replay an expired interrupted automatic approval on STATUS",async()=>{
 const f=fixture(approval),c=f.make();await c.handle("auto","approve for me");
 f.respond.mockImplementation(async()=>{throw new Error("unknown");});await c.handle("first","Run");f.now=24*60*60*1000;
 const restored=f.make();expect(await restored.handle("status","STATUS")).toMatch(/unknown|again/);expect(f.respond).toHaveBeenCalledTimes(1);
});
it("revocation arriving during an automatic decision stops subsequent approvals",async()=>{
 const f=fixture(approval),c=f.make();await c.handle("auto","approve for me");
 let finish!:()=>void;f.respond.mockImplementation(async()=>{await new Promise<void>(r=>{finish=r;});f.card={...approval,requestId:"second"};return {};});
 const started=c.handle("first","Run");await vi.waitFor(()=>expect(f.respond).toHaveBeenCalledTimes(1));
 const revoked=c.handle("revoke","ask me first");expect(c.approvalMode).toBe("ask");finish();await started;await revoked;
 expect(await c.handle("status","STATUS")).toContain('Reply "yes"');expect(f.respond).toHaveBeenCalledTimes(1);
});
it("does not let delayed or queued mode commands override a later revocation",async()=>{
 const f=fixture(approval),c=f.make();f.now=2000;
 const timing=(eventTimestamp:number)=>({channel:"imessage" as const,maxReplyCharacters:18000,receivedAt:3000,eventTimestamp});
 await c.handle("auto","approve for me",timing(1000));await c.handle("revoke","ask me first",timing(2000));
 await c.handle("stale-auto","approve for me",timing(1000));expect(c.approvalMode).toBe("ask");
 const enable=c.handle("queued-auto","approve for me"),revoke=c.handle("queued-revoke","ask me first");await enable;await revoke;
 expect(c.approvalMode).toBe("ask");expect(f.send).not.toHaveBeenCalled();
});
it("NEW prevents an older automatic-mode command from reopening the preference",async()=>{
 const f=fixture(approval),c=f.make();const timing=(at:number)=>({channel:"imessage" as const,maxReplyCharacters:18000,receivedAt:at,eventTimestamp:at});
 await c.handle("auto","approve for me",timing(1000));await c.handle("new","NEW separate",timing(3000));
 await c.handle("old-auto","approve for me",timing(2000));expect(c.approvalMode).toBe("ask");expect(f.respond).not.toHaveBeenCalled();
});
it("persists receipt-time revocation before a queued owner callback can run",async()=>{
 const f=fixture(approval),c=f.make();await c.handle("auto","approve for me");
 c.revokeAutomaticForOwnerMessage("ask me first",{receivedAt:2000,eventTimestamp:2000});
 expect(c.approvalMode).toBe("ask");expect(f.make().approvalMode).toBe("ask");
 await c.handle("first","Run");expect(f.respond).not.toHaveBeenCalled();
});
it("rejects an equal-time delayed enable and makes old revocations durable",async()=>{
 const f=fixture(approval),c=f.make();const timing=(at:number)=>({channel:"imessage" as const,maxReplyCharacters:18000,receivedAt:at,eventTimestamp:at});
 await c.handle("auto","approve for me",timing(1000));await c.handle("revoke","ask me first",timing(2000));
 await c.handle("tied-auto","approve for me",timing(2000));expect(f.make().approvalMode).toBe("ask");
 await c.handle("later-auto","approve for me",timing(3000));await c.handle("old-revoke","ask me first",timing(1000));
 expect(c.approvalMode).toBe("ask");expect(f.make().approvalMode).toBe("ask");
});

it("rejects a millisecond-timestamped reply for the previous card in the same second",async()=>{
 const f=fixture(approval),c=f.make();f.now=2100;await c.handle("first","Run");
 f.respond.mockImplementation(async()=>{f.now=2500;f.card={...approval,requestId:"second",subtitle:"second command"};return {};});
 await c.handle("yes-one","yes",{channel:"imessage",maxReplyCharacters:18000,receivedAt:2300,eventTimestamp:2200});expect(f.respond).toHaveBeenCalledTimes(1);
 expect(await c.handle("delayed","yes",{channel:"imessage",maxReplyCharacters:18000,receivedAt:3000,eventTimestamp:2200})).toContain("STATUS");expect(f.respond).toHaveBeenCalledTimes(1);
 await c.handle("yes-current","yes",{channel:"imessage",maxReplyCharacters:18000,receivedAt:3100,eventTimestamp:3000});expect(f.respond).toHaveBeenCalledTimes(2);
});

it("exposes only a validated active task for startup channel ownership registration", async () => {
 const f=fixture(),c=f.make();expect(c.activeThreadId).toBeNull();await c.handle("first","Plan");
 expect(c.activeThreadId).toBe("thread");expect(f.make().activeThreadId).toBe("thread");
 writeFileSync(f.file,'{"version":1,"binding":"other"}');expect(f.make().activeThreadId).toBeNull();
});
it("reports a terminal budget stop without claiming success or relaxing failed-request guards", async () => {
 const root=mkdtempSync(join(tmpdir(),"omb-channel-budget-"));roots.push(root);let sendId="";const send=vi.fn(async(_t:string,s:string)=>{sendId=s;});
 const c=new ChannelConversation({file:join(root,"state.json"),binding:"owner",createAskTask:()=>"thread",send,respond:async()=>({}),snapshot:()=>({messageId:"source",activeLeafId:"failure",activeTurnId:null,executionId:null,phase:"untracked",messages:[
 {id:"source",role:"user",kind:"text",at:1,sendId},
 {id:"failure",role:"bot",kind:"activity",at:2,turnId:"turn",requestMessageId:"source",tool:{name:"error: Stopped after 64 steps without a final answer.",ok:false,terminal:true}},
 ]})});
 const reply=await c.handle("first","Work");expect(reply).toMatch(/stopped.*budget/i);expect(reply).toContain("NEW");expect(reply).toContain("Mausbot");expect(reply).not.toMatch(/finished|continues in a new task/i);
 await c.handle("followup","continue");expect(send).toHaveBeenCalledTimes(1);
});
