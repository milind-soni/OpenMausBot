import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_CLIENT_NAME, discoverAcpModels, resolveCustomAcpModels } from "./custom-model-catalog.ts";

/** Lets a test see a process that reports it would not stop; the real stop still runs. */
const stop = vi.hoisted(() => ({ refuses: false }));
vi.mock("../../procs.ts", async (original) => {
  const procs = await original<typeof import("../../procs.ts")>();
  return { ...procs, killCliTree: async (...args: Parameters<typeof procs.killCliTree>) => (await procs.killCliTree(...args)) && !stop.refuses };
});

const scratch: string[] = [];
afterEach(async () => { stop.refuses = false; await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fake(mode = "normal") {
  const cwd = await mkdtemp(join(tmpdir(), "omb-catalog-test-"));
  scratch.push(cwd);
  const cli = join(cwd, "fake.mjs");
  const dump = join(cwd, "requests.jsonl");
  await writeFile(cli, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let current='deep';
const mode=process.env.CATALOG_MODE;
const modelOptions=[{value:'deep',name:'Deep'},{value:'flash',name:'Flash'},{value:'silent',name:'Silent'},{value:'rejected',name:'Rejected'}];
function result(){return {sessionId:'fake-session',configOptions:[{id:'model',type:'select',category:'model',currentValue:current,options:modelOptions},...(current==='silent'?[]:[{id:current==='flash'?'thought_level':'reasoning_effort',type:'select',category:'thought_level',currentValue:current==='flash'?'low':'max',options:[{value:current==='flash'?'low':'max',name:current==='flash'?'Low':'Max'}]}])]};}
function emit(value){process.stdout.write(JSON.stringify(value)+'\\n');}
function legacyResult(){const r=result();return {...r,models:{currentModelId:current,availableModels:modelOptions.map(x=>({modelId:x.value,name:x.name}))},configOptions:r.configOptions.filter(x=>x.id!=='model')}}
appendFileSync(process.env.CATALOG_DUMP,JSON.stringify({cwd:process.cwd(),pid:process.pid})+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const msg=JSON.parse(line); appendFileSync(process.env.CATALOG_DUMP,JSON.stringify({cwd:process.cwd(),...msg})+'\\n');
 if(!msg.method)continue;
 if(msg.method==='initialize'){emit({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}});continue;}
 if(msg.method==='session/new'){
  if(mode==='exit'){process.exit(3);}
  if(mode==='legacy'){emit({jsonrpc:'2.0',id:msg.id,result:legacyResult()});continue;}
  if(mode==='no-models'){emit({jsonrpc:'2.0',id:msg.id,result:{sessionId:'fake-session'}});continue;}
  if(mode==='flood'){process.stdout.write('x'.repeat(2*1024*1024));continue;}
  emit({jsonrpc:'2.0',id:900,method:'fs/read_text_file',params:{sessionId:'fake-session',path:'/secret'}});
  emit({jsonrpc:'2.0',id:901,method:'session/request_permission',params:{sessionId:'fake-session'}});
  emit({jsonrpc:'2.0',id:msg.id,result:result()});continue;
 }
 if(msg.method==='session/set_model'){current=msg.params.modelId;emit({jsonrpc:'2.0',id:msg.id,result:legacyResult()});continue;}
 if(msg.method==='session/set_config_option'){
  if(msg.params.value==='rejected'){emit({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'secret-provider-details'}});continue;}
  if(mode==='stale'&&msg.params.value==='flash'){emit({jsonrpc:'2.0',id:msg.id,result:result()});continue;}
  current=msg.params.value;
  if(mode==='notification'){emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fake-session',update:{sessionUpdate:'config_option_update',configOptions:result().configOptions}}});emit({jsonrpc:'2.0',id:msg.id,result:{}});continue;}
  emit({jsonrpc:'2.0',id:msg.id,result:result()});continue;
 }
 emit({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'unexpected method'}});
}
appendFileSync(process.env.CATALOG_DUMP,JSON.stringify({eof:true})+'\\n');
if(mode==='ignore-eof')setInterval(()=>{},1000);`);
  return {
    config: { cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}` },
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd, CATALOG_MODE: mode, CATALOG_DUMP: dump },
    requests: async () => (await readFile(dump, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>)
      .filter((entry) => entry.pid === undefined && !entry.eof),
    log: async () => (await readFile(dump, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>),
  };
}

describe("custom ACP catalog discovery (isolated fake CLI)", () => {
  it("discovers model-specific variants without prompts, tools, MCP or shared config edits", async () => {
    const fixture = await fake();
    const catalog = await resolveCustomAcpModels(fixture.env, fixture.config);
    expect(catalog).toEqual({ default: "agent-default", options: [
      { id: "agent-default", label: "Agent default", custom: true },
      { id: "deep", label: "Deep", custom: true, variants: [{ id: "max", label: "Max" }] },
      { id: "flash", label: "Flash", custom: true, variants: [{ id: "low", label: "Low" }] },
      { id: "silent", label: "Silent", custom: true }, { id: "rejected", label: "Rejected", custom: true },
    ] });
    const requests = await fixture.requests();
    expect(requests.filter((r) => r.method).map((r) => r.method)).toEqual([
      "initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option",
    ]);
    expect(requests[0].params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(requests.find((r) => r.method === "session/new")?.params.mcpServers).toEqual([]);
    expect(requests.find((r) => r.id === 900)?.error.code).toBe(-32601);
    expect(requests.find((r) => r.id === 901)?.result.outcome.outcome).toBe("cancelled");
    await expect(readFile(requests[0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never attaches the previous model's effort when a switch was not confirmed", async () => {
    const fixture = await fake("stale");
    const catalog = await resolveCustomAcpModels(fixture.env, fixture.config);
    expect(catalog.options.find((m) => m.id === "flash")).toEqual({ id: "flash", label: "Flash", custom: true });
  });

  it("accepts a matching fresh config update when the native setter returns an empty result", async () => {
    const fixture = await fake("notification");
    const catalog = await resolveCustomAcpModels(fixture.env, fixture.config);
    expect(catalog.options.find((m) => m.id === "flash")?.variants).toEqual([{ id: "low", label: "Low" }]);
  });

  it("discovers legacy catalogs through session/set_model without assuming a config ID", async () => {
    const fixture = await fake("legacy");
    const catalog = await resolveCustomAcpModels(fixture.env, fixture.config);
    expect(catalog.options.find((m) => m.id === "flash")?.variants).toEqual([{ id: "low", label: "Low" }]);
    const requests = await fixture.requests();
    expect(requests.filter((r) => r.method === "session/set_model")).toHaveLength(3);
    expect(requests.some((r) => r.method === "session/set_config_option")).toBe(false);
  });

  it("returns a safe failure and cleans up when the native process exits", async () => {
    const fixture = await fake("exit");
    await expect(resolveCustomAcpModels(fixture.env, fixture.config)).rejects.toThrow("closed during model discovery");
    const requests = await fixture.requests();
    await expect(readFile(requests[0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails instead of replacing a previous catalog with an empty response", async () => {
    const fixture = await fake("no-models");
    await expect(resolveCustomAcpModels(fixture.env, fixture.config)).rejects.toThrow("did not advertise any models");
  });

  it("hands the agent's session to forgetSession once the process has stopped, and never before", async () => {
    const fixture = await fake();
    const forgetSession = vi.fn(async () => {});
    await discoverAcpModels(fixture.env, fixture.config.cli, [], { forgetSession });
    expect(forgetSession).toHaveBeenCalledOnce();
    const [session] = forgetSession.mock.calls[0] as unknown as [{ sessionId: string; cwd: string; env: unknown }];
    expect(session.sessionId).toBe("fake-session");
    expect(basename(session.cwd)).toMatch(/^omb-acp-models-/);
    // macOS reports the agent's cwd through /private; the folder name is the same either way.
    expect(basename(session.cwd)).toBe(basename((await fixture.requests())[0].cwd));
    expect(session.env).toBe(fixture.env);
    expect((await fixture.requests())[0].params.clientInfo.name).toBe(DISCOVERY_CLIENT_NAME);

    stop.refuses = true;
    const stuck = vi.fn(async () => {});
    await expect(discoverAcpModels(fixture.env, fixture.config.cli, [], { forgetSession: stuck })).rejects.toThrow("could not be stopped");
    expect(stuck).not.toHaveBeenCalled();
  });

  it("stops a custom agent at once, and lets an agent asked to exit gracefully read EOF first", async () => {
    const custom = await fake();
    await resolveCustomAcpModels(custom.env, custom.config);
    expect((await custom.log()).some((entry) => entry.eof)).toBe(false);
    const graceful = await fake();
    await discoverAcpModels(graceful.env, graceful.config.cli, [], { exitGraceMs: 10_000 });
    expect((await graceful.log()).some((entry) => entry.eof)).toBe(true);
  });

  it("still stops an agent that ignores EOF, once the grace period is over", async () => {
    const fixture = await fake("ignore-eof");
    await discoverAcpModels(fixture.env, fixture.config.cli, [], { exitGraceMs: 50 });
    const log = await fixture.log();
    expect(log.some((entry) => entry.eof)).toBe(true);
    const pid = log.find((entry) => entry.pid !== undefined)?.pid as number;
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("bounds malformed output and still removes its isolated workspace", async () => {
    const fixture = await fake("flood");
    await expect(resolveCustomAcpModels(fixture.env, fixture.config)).rejects.toThrow("line limit");
    const requests = await fixture.requests();
    await expect(readFile(requests[0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
