import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { handleToolCall, request } from "./mcp-server.ts";

/** Exercises provider -> real agents MCP -> server -> addressed room turns,
 * not synthetic API capabilities. Every app record lives in the launcher's fixture.
 */
export async function verifyRoomHandoffs(outputPath?: string, preview = false) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true, staticDir: preview ? resolve("dist") : undefined });
  const commands: unknown[] = [];
  const env = { OPENMAUSBOT_URL: session.info.url };
  const control = async (...args: string[]) => {
    const result = await runControlOmb(args, { env });
    commands.push({ command: ["control-omb", ...args], env, result });
    return result as any;
  };
  const fetcher = (path: string, options: RequestInit = {}) => request(path, options, session.info.url);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await handleToolCall(name, args, fetcher); commands.push({ tool: name, args, result }); return result as any;
  };
  try {
    assert.equal((await control("doctor")).ok, true);
    const createBot = async (name: string) => (await control("new-bot", "--name", name, "--section", "検証会社")).bot;
    const ceo = await createBot("ミナト");
    const director = await createBot("レン");
    const deptBystander = await createBot("リツ");
    const engineer = await createBot("ソラ");
    const leafBystander = await createBot("ヒナ");
    const room = async (name: string, members: string[], bulletin: string) => (await tool("create_channel", {
      name, member_ids: members, bulletin, default_responder: { kind: "everyone" },
    })).channel;
    const executive = await room("経営会議", [ceo.id], "EXECUTIVE_PRIVATE_CONTEXT");
    const development = await room("開発部", [director.id, deptBystander.id], "DEVELOPMENT_CONTEXT: CSVはUTF-8 BOM付き");
    const implementation = await room("実装チーム", [engineer.id, leafBystander.id], "IMPLEMENTATION_CONTEXT: 変更にはテストを付ける");
    await control("room-routes", "--channel", development.id, "--from", executive.id);
    await control("room-routes", "--channel", implementation.id, "--from", development.id);
    // Allow the reverse address too: ancestry, not lack of a route, must stop a loop.
    await control("room-routes", "--channel", executive.id, "--from", implementation.id);
    const planPath = join(session.info.dataDir, "room-plan.json");
    const send = (groupId: string, botId: string, key: string, message: string, expectError = false) => ({
      arguments: { group_id: groupId, bot_id: botId, request_key: key, message }, expectError,
    });
    const plan = {
      [ceo.id]: {
        steps: [send(development.id, director.id, "csv", "CSV出力を実装・検証してください。"),
          send(development.id, director.id, "csv", "CSV出力を実装・検証してください。")],
        reply: "開発部のレンに依頼しました。", resumeReply: "経営会議報告：CSV実装と検証結果を受領しました。",
      },
      [director.id]: {
        steps: [send(implementation.id, engineer.id, "build", "CSV出力を実装してください。"),
          send(implementation.id, ceo.id, "non-member", "宛先所属の拒否確認", true)],
        reply: "実装チームのソラに依頼しました。", resumeReply: "開発部報告：実装チームの成果を確認しました。",
      },
      [engineer.id]: {
        steps: [send(executive.id, ceo.id, "loop", "経営会議への循環依頼", true),
          { tool: "delegate_bot", arguments: { bot_id: leafBystander.id, message: "旧経路の制限確認" }, expectError: true }],
        reply: "実装完了：CSV出力と文字コードのテストを確認しました。",
      },
    };
    writeFileSync(planPath, JSON.stringify(plan));
    await control("send-channel", "--channel", executive.id, "--text", "@ミナト CSV出力機能の開発をお願いします。");
    const settled = await control("wait", "--channel", executive.id, "--timeout", "90");
    assert.equal(settled.status, "settled", JSON.stringify(settled));
    const transcripts = [];
    for (const group of [executive, development, implementation]) transcripts.push({ name: group.name, id: group.id,
      transcript: await control("messages", "--channel", group.id, "--limit", "60") });
    const nodes = JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8"));
    assert.equal(nodes.length, 3, "one root, one department request, one implementation request; duplicate creates nothing");
    assert(nodes.every((n: any) => n.status === "completed"), JSON.stringify(nodes));
    const provider = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(provider.map(p => [p.botId, p.resumed]), [
      [ceo.id, false], [director.id, false], [engineer.id, false], [director.id, true], [ceo.id, true],
    ], "only addressed agents run; both ancestors are automatically resumed");
    const deptTurn = provider.find(p => p.botId === director.id);
    const leafTurn = provider.find(p => p.botId === engineer.id);
    assert(deptTurn.system.includes("DEVELOPMENT_CONTEXT"));
    assert(leafTurn.system.includes("IMPLEMENTATION_CONTEXT"));
    assert(!deptTurn.system.includes("EXECUTIVE_PRIVATE_CONTEXT"));
    assert(!leafTurn.system.includes("DEVELOPMENT_CONTEXT"));
    assert(provider.filter(p => p.resumed).every(p => p.system.includes("Room") || p.system.includes("room")));
    const evidence = { ok: true, verifiedAt: new Date().toISOString(), fixture: session.info,
      checks: ["three disjoint rooms in one company section", "only addressed agents start", "destination context", "no source bulletin leak",
        "duplicate suppressed", "non-member rejected", "ancestor loop rejected", "legacy peer tools unavailable on delegated turns",
        "leaf result -> director continuation -> CEO continuation"],
      commands, nodes, transcripts, provider };
    if (outputPath) { mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, JSON.stringify(evidence, null, 2)); }
    if (preview) {
      process.stdout.write(JSON.stringify({ preview: session.info.url, fixture: session.info, rooms: [executive, development, implementation] }) + "\n");
      await new Promise<void>(done => { process.once("SIGINT", done); process.once("SIGTERM", done); });
    }
    return evidence;
  } catch (error) {
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify({ ok: false, error: String(error), fixture: session.info, commands,
        log: readFileSync(session.info.logPath, "utf8") }, null, 2));
    }
    throw error;
  } finally { await session.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? "artifacts/room-handoffs/verification.json");
  const evidence = await verifyRoomHandoffs(output, process.argv.includes("--preview"));
  process.stdout.write(JSON.stringify({ ok: evidence.ok, output, checks: evidence.checks, log: evidence.fixture.logPath }) + "\n");
}
