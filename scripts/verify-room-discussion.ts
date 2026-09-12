import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { handleToolCall, request } from "./mcp-server.ts";

export async function verifyRoomDiscussion(output: string, preview = false, live = false) {
  let realEngine: { cli: string; environment: Record<string, string> } | undefined;
  if (live) {
    const configPath = process.env.OMB_VERIFY_CC_CONFIG;
    const cli = process.env.OMB_VERIFY_CC_CLI;
    if (!configPath || !cli) throw new Error("Set OMB_VERIFY_CC_CONFIG to the existing OMB config and OMB_VERIFY_CC_CLI to Claude Code. Credentials are never printed.");
    const saved = JSON.parse(readFileSync(configPath, "utf8")).instances?.[process.env.OMB_VERIFY_CC_INSTANCE ?? "claude"]?.environment;
    if (!saved?.ANTHROPIC_AUTH_TOKEN || saved.ANTHROPIC_MODEL !== "glm-5.3") throw new Error("Expected configured GLM-5.3 credentials");
    const environment: Record<string, string> = {};
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) if (typeof saved[key] === "string") environment[key] = saved[key];
    if (process.env.CLAUDE_CODE_GIT_BASH_PATH) environment.CLAUDE_CODE_GIT_BASH_PATH = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    realEngine = { cli, environment };
  }
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: !live, staticDir: preview ? resolve("dist") : undefined, engine: realEngine });
  const commands: unknown[] = [];
  const control = async (...args: string[]) => {
    const result = await runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } });
    commands.push({ command: args, result }); return result as any;
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await handleToolCall(name, args, (path, options) => request(path, options, session.info.url));
    commands.push({ tool: name, args, result }); return result as any;
  };
  const transcripts: any[] = [];
  let rooms: any[] = [];
  try {
    const bots: any[] = [];
    for (const [name, title] of [
      ["ミナト", "経営会議の議長。議論して方針と対象範囲を決める"],
      ["アオイ", "営業責任者。顧客価値と優先順位を検討"],
      ["ユイ", "管理責任者。予算と情報管理のリスクを指摘"],
      ["レン", "開発部長。部内議論で要件を設計と受入条件に具体化"],
      ["リツ", "設計担当。方式の比較と実装の複雑さを評価"],
      ["マコ", "品質責任者。漏れや失敗条件を指摘"],
      ["ソラ", "実装チームリーダー。チーム議論で実装・テスト計画をまとめる"],
      ["ヒナ", "実装担当。具体的な処理方式と代案を提案"],
      ["ナギ", "テスト担当。他の意見を検討し境界値と確認手順を提案"],
    ]) {
      const bot = (await control("new-bot", "--name", name, "--title", title, "--section", "検証会社")).bot;
      if (live) await tool("set_bot_model", { bot_id: bot.id, instance_id: "claude", model: "glm-5.3", effort: "low" });
      bots.push(bot);
    }
    const [ceo, sales, finance, director, architect, qa, lead, developer, tester] = bots;
    for (const [index, name] of ["経営会議", "開発部", "実装チーム"].entries()) {
      const members = bots.slice(index * 3, index * 3 + 3);
      const bulletin = `既存の3メンバーで議論する。責任者は最初に仮案を出し、discuss_roomで他の2名の意見を聞く。後の発言者は先の意見に賛否や修正を述べる。責任者は採否と理由をまとめてから次層へ依頼する。日本語で各発言は最大300字。ツールの非同期受付後は待機やScheduleWakeupをせず最終応答でターンを終える。下流の成果の了承や承認は自分の最終応答に書く。了承を新規依頼として送らない。コード変更や外部検索は不要、今回はCSV出力の設計会議だけ。${index === 0 ? "開発部のレンに決定した事業要件を渡す。" : index === 1 ? "実装チームのソラに設計と受入条件を渡す。" : "下流への新規依頼は不要。議論後に実装手順・テスト計画・未確定点を報告する。実装完了とは言わない。"}`;
      const room = (await tool("create_channel", { name, member_ids: members.map(b => b.id), bulletin,
        default_responder: { kind: "member", bot_id: members[0].id } })).channel;
      await tool("update_channel", { channel_id: room.id, require_room_discussion: true }); rooms.push(room);
    }
    await control("room-routes", "--channel", rooms[1].id, "--from", rooms[0].id);
    await control("room-routes", "--channel", rooms[2].id, "--from", rooms[1].id);
    const planPath = join(session.info.dataDir, "room-plan.json");
    const send = (index: number, bot: any, message: string, expectError = false) => ({ tool: "send_room_message", arguments: { group_id: rooms[index].id, bot_id: bot.id, message, request_key: `assign-${index}` }, expectError });
    const discuss = (members: any[], topic: string) => ({ tool: "discuss_room", arguments: { member_ids: members.map(b => b.id), topic, request_key: "design-discussion" } });
    const business = "顧客のExcel利用を優先し、初版はCSV出力のみ。個人情報は対象外、上限1万件。対象範囲を絞り短納期とする。設計と受入条件を部内で議論してください。";
    const design = "経営決定を受け、UTF-8 BOM付きCSVを採用。個人情報を除外し上限1万件、引用符をエスケープ。失敗時は途中ファイルを残さない。実装・テスト計画をチームで議論してください。";
    if (!live) writeFileSync(planPath, JSON.stringify({
      [ceo.id]: { turns: [
        { steps: [send(1, director, "そのまま中継", true), discuss([sales, finance], "CSVとPDFを同時に提供する仮案です。優先度・費用・情報管理を議論してください。"), send(1, director, "議論前の中継", true)], reply: "仮案はCSVとPDFの同時提供です。@アオイ @ユイ 営業・管理の観点から必要性とリスクを確認します。" },
        { expectContextIncludes: ["CSVを先行", "個人情報"], steps: [send(1, director, business)], reply: "【経営決定】営業のCSV先行案と管理の情報制限を採用。PDFは後回しにし、個人情報を除外・上限1万件で開発部へ依頼します。" },
        { expectContextIncludes: ["UTF-8 BOM", "途中ファイル"], reply: "【経営確認】CSV先行と個人情報除外が設計・試験計画に反映されました。未確定の出力列は営業が確認します。今回は設計完了で、実装は未着手です。" },
      ] },
      [sales.id]: { steps: [send(1, director, "参加者からの独断の依頼", true), { ...discuss([finance], "議論の再帰呼出し"), expectError: true }], reply: "顧客はExcelで集計したいのでCSVを先行すべきです。PDF同時開発より、出力列を顧客と確認する方が価値があります。" },
      [finance.id]: { expectContextIncludes: ["CSVを先行"], reply: "CSV先行に賛成です。ただし顧客データをそのまま出す案には反対。個人情報を除外し、予算内に収めるため上限1万件に絞りましょう。" },
      [director.id]: { turns: [
        { expectContextIncludes: ["個人情報は対象外"], steps: [discuss([architect, qa], "経営要件を満たすCSVを設計します。仮案は単純な文字列結合です。文字コード・境界値・失敗処理を検討してください。")], reply: "CSV先行・個人情報除外・1万件制限を受領。単純な文字列結合を仮案に、設計と品質の意見を確認します。" },
        { expectContextIncludes: ["UTF-8 BOM", "途中ファイル"], steps: [send(2, lead, design)], reply: "【開発決定】単純結合案を撤回。UTF-8 BOMと引用符処理を採用し、失敗時は途中ファイルを残さないことを受入条件に追加して実装チームへ渡します。" },
        { expectContextIncludes: ["一時ファイル", "10001件"], steps: [{ ...send(2, lead, "了承しました", true), arguments: { ...send(2, lead, "了承しました").arguments, request_key: "acknowledgement" } }], reply: "【開発レビュー】一時ファイルから成功時だけ確定する案を承認。UTF-8 BOM、引用符、10001件、途中ファイル削除の試験計画を確認。出力列は経営側への確認事項です。" },
      ] },
      [architect.id]: { reply: "単純結合ではカンマや改行を含む値が壊れます。CSVライブラリを使い、Excel向けにUTF-8 BOMを付ける方式を提案します。" },
      [qa.id]: { expectContextIncludes: ["CSVライブラリ"], reply: "ライブラリ案に賛成。文字コードだけでは不足で、引用符と上限超過も試験が必要です。失敗時に途中ファイルを残さない条件を追加しましょう。" },
      [lead.id]: { turns: [
        { expectContextIncludes: ["UTF-8 BOM付きCSV"], steps: [discuss([developer, tester], "受入条件を満たす実装手順とテスト計画を議論します。直接ファイルへ書き出す仮案の問題点と代案を挙げてください。")], reply: "BOM・引用符処理・件数制限を確認。直接書き出す仮案について、実装手順と失敗時のテストをチーム内で検討します。" },
        { expectContextIncludes: ["一時ファイル", "10001件"], reply: "【実装計画】直接書込み案を修正し、一時ファイルへ出力、成功時だけ確定します。0件・1万件・10001件、引用符、改行、失敗時の削除を試験。出力列は要確認。コードは未変更です。" },
      ] },
      [developer.id]: { reply: "直接書込みは途中失敗で壊れたCSVが残ります。一時ファイルに書き、成功時だけ確定する方式に変更し、個人情報列は出力前に除外します。" },
      [tester.id]: { expectContextIncludes: ["一時ファイル"], reply: "一時ファイル方式に賛成。ただし削除失敗も考慮が必要です。0件・1万件・10001件、カンマ・改行・引用符と、異常終了時の残骸を確認する試験を追加します。" },
    }));
    await control("send-channel", "--channel", rooms[0].id, "--text", "@ミナト CSV出力の新機能を検討してください。各層の既存メンバーで議論し、その判断を踏まえて経営会議→開発部のレン→実装チームのソラへ依頼してください。各層で仮案・賛否・修正・決定を示し、ただの中継にしないでください。最下層は実装とテストの計画を議論し、結果を上に戻してください。今回は設計会議なのでコード変更は不要です。");
    process.stdout.write(JSON.stringify({ phase: "running", url: session.info.url, live, rooms: rooms.map(r => ({ id: r.id, name: r.name })) }) + "\n");
    let wait: any;
    for (let attempt = 0; attempt < (live ? 50 : 3); attempt++) {
      wait = await control("wait", "--channel", rooms[0].id, "--timeout", "30");
      if (wait.status !== "timed-out") break;
      process.stdout.write(JSON.stringify({ phase: "waiting", elapsedSeconds: (attempt + 1) * 30 }) + "\n");
    }
    for (const room of rooms) transcripts.push({ name: room.name, id: room.id, transcript: await control("messages", "--channel", room.id, "--limit", "100") });
    const nodes = JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8"));
    const provider = !live && existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
    const checks: string[] = [];
    assert.equal(wait.status, "settled", JSON.stringify(wait));
    assert(nodes.every((n: any) => n.status === "completed"), JSON.stringify(nodes));
    assert.equal(nodes.filter((n: any) => n.kind === "work").length, 3);
    assert.equal(nodes.filter((n: any) => n.kind === "discussion").length, 3);
    for (const [index, room] of rooms.entries()) {
      const discussion = nodes.find((n: any) => n.kind === "discussion" && n.groupId === room.id);
      assert.deepEqual(new Set(discussion.participants), new Set(bots.slice(index * 3 + 1, index * 3 + 3).map(b => b.id)));
    }
    checks.push("three independent rooms, each with three existing members", "all three rooms complete member discussions", "all three leaders decide after discussion", "downstream results resume both ancestors");
    if (!live) {
      assert.deepEqual(provider.map(p => p.botId), [ceo.id, sales.id, finance.id, ceo.id, director.id, architect.id, qa.id, director.id, lead.id, developer.id, tester.id, lead.id, director.id, ceo.id]);
      checks.push("premature forwarding rejected before and during discussion", "completed recipient is not restarted by an acknowledgement", "later member sees earlier opinion", "leaders receive opinions and downstream briefs contain accepted changes");
    }
    const currentBots = live ? (await tool("list_bots", {})).bots.filter((b: any) => bots.some(original => original.id === b.id)) : bots;
    const evidence = { ok: true, verifiedAt: new Date().toISOString(), live, model: live ? "glm-5.3" : "scripted", fixture: session.info, checks, bots: currentBots, rooms, nodes, transcripts, provider, commands };
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(evidence, null, 2));
    process.stdout.write(JSON.stringify({ phase: "verified", ok: true, output, preview: preview ? session.info.url : undefined, checks }) + "\n");
    if (preview) await new Promise<void>(done => { process.once("SIGINT", done); process.once("SIGTERM", done); });
    return evidence;
  } catch (error) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ ok: false, error: String(error), nodes: existsSync(join(session.info.dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8")) : [], fixture: session.info, rooms, transcripts, commands, log: readFileSync(session.info.logPath, "utf8") }, null, 2));
    throw error;
  } finally { await session.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyRoomDiscussion(resolve(process.argv[2] ?? "artifacts/room-discussion/verification.json"), process.argv.includes("--preview"), process.argv.includes("--live"));
}
