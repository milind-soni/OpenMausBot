import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareInkboxConversationState, type InkboxConversationBinding } from "./inkbox-conversation-state.ts";
import { ChannelConversation, type ChannelSnapshot } from "./channel-conversation.ts";
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const original: InkboxConversationBinding={identityId:"identity",botId:"bot",ownerPhone:"+14155550123",phoneNumberId:null};
const discovered={...original,phoneNumberId:"phone-resource"};
const legacy=(root:string,binding:InkboxConversationBinding)=>({file:join(root,createHash("sha256").update(JSON.stringify(binding)).digest("hex"),"conversation.json"),binding:JSON.stringify(binding)});
function fixture(waiting=false){
 const root=mkdtempSync(join(tmpdir(),"omb-conversation-migration-"));roots.push(root);let sendId="",created=0;const sends:string[]=[];const answers:string[]=[];
 const options={createAskTask:()=>`thread-${++created}`,send:async(_thread:string,id:string,text:string)=>{sendId=id;sends.push(text);},respond:async(_target:unknown,_behavior:unknown,text?:string)=>{answers.push(text??"");waiting=false;return {};},snapshot:():ChannelSnapshot=>({messageId:"source",activeLeafId:waiting?"card":"final",activeTurnId:waiting?"turn":null,executionId:waiting?"execution":null,phase:waiting?"waiting":"settled",messages:[{id:"source",role:"user",kind:"text",at:1,sendId},...(waiting?[{id:"card",role:"bot" as const,kind:"options" as const,at:2,turnId:"turn",requestMessageId:"source",card:{title:"Where?",subtitle:"Where?",options:["Pune","Mumbai"],requestId:"question",requestType:"question" as const}}]:[{id:"final",role:"bot" as const,kind:"text" as const,at:2,text:"done",requestMessageId:"source",turnTerminal:true,turnSucceeded:true}])]})};
 const make=(binding:InkboxConversationBinding)=>new ChannelConversation({...prepareInkboxConversationState(root,binding),...options});
 return {root,make,options,sends,answers,get created(){return created;}};
}
it("continues the existing task when setup discovers a phone resource",async()=>{
 const f=fixture();await new ChannelConversation({...legacy(f.root,original),...f.options}).handle("first","Hello");
 expect(await f.make(discovered).handle("next","Continue")).toBe("done");expect(f.created).toBe(1);expect(f.sends).toEqual(["Hello","Continue"]);
});
it("answers the existing pending question after phone discovery without starting new work",async()=>{
 const f=fixture(true);await new ChannelConversation({...legacy(f.root,original),...f.options}).handle("first","Plan");
 expect(await f.make(discovered).handle("answer","2")).toBe("done");expect(f.created).toBe(1);expect(f.sends).toEqual(["Plan"]);expect(f.answers[0]).toContain("Mumbai");
});
it("preserves the interrupted applying fence across phone discovery",async()=>{
 const f=fixture(true),old=legacy(f.root,original);await new ChannelConversation({...old,...f.options}).handle("first","Plan");
 const state=JSON.parse(readFileSync(old.file,"utf8"));state.pending.applying=true;writeFileSync(old.file,JSON.stringify(state));
 expect(await f.make(discovered).handle("answer","2")).toContain("interrupted");expect(f.created).toBe(1);expect(f.answers).toEqual([]);expect(f.sends).toEqual(["Plan"]);
});
it("retains existing phone-bound state using the stable path on later restarts",async()=>{
 const f=fixture(),old=legacy(f.root,discovered);await new ChannelConversation({...old,...f.options}).handle("first","Hello");
 const prepared=prepareInkboxConversationState(f.root,discovered);expect(prepared.file).toBe(legacy(f.root,original).file);expect(existsSync(old.file)).toBe(false);
 await f.make(discovered).handle("second","Continue");await f.make(discovered).handle("third","Again");expect(f.created).toBe(1);
});
it("fails closed when old and new phone paths contain different state",async()=>{
 const f=fixture();await new ChannelConversation({...legacy(f.root,original),...f.options}).handle("first","Hello");
 const other=legacy(f.root,discovered);mkdirSync(dirname(other.file),{recursive:true});writeFileSync(other.file,JSON.stringify({version:1,binding:other.binding,active:{threadId:"other-task",sendId:"other-send"}}));
 const before=readFileSync(other.file,"utf8");expect(await f.make(discovered).handle("next","Must not run")).toContain("state is unavailable");expect(f.sends).toEqual(["Hello"]);expect(readFileSync(other.file,"utf8")).toBe(before);
});
it.each([{...discovered,ownerPhone:"+14155550999"},{...discovered,botId:"other-bot"},{...discovered,identityId:"other-identity"},{...discovered,phoneNumberId:"different-phone"}])("does not rewrite state with a different saved binding %j",async(saved)=>{
 const f=fixture(),path=legacy(f.root,original).file;mkdirSync(dirname(path),{recursive:true});const bytes=JSON.stringify({version:1,binding:JSON.stringify(saved),active:{threadId:"other-task",sendId:"other-send"}});writeFileSync(path,bytes);
 expect(await f.make(discovered).handle("next","Must not run")).toContain("state is unavailable");expect(f.sends).toEqual([]);expect(readFileSync(path,"utf8")).toBe(bytes);
});
