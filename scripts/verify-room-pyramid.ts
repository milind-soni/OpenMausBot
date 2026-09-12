import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { handleToolCall, request } from "./mcp-server.ts";

// Five groups form an asymmetric three-layer organization. Names describe
// responsibility in the parent room; no bot is added to a downstream group.
const organization = [
  { name: "経営会議", members: [["ミナト", "議長"], ["アオイ", "開発担当"], ["ユイ", "営業担当"]], routes: [1, 2], rounds: 2,
    topic: "CSV出力の初期対象。仮案は全項目・全件出力。アオイは早期公開のため対象限定、ユイは営業に必要な項目を要求。2巡目で具体的な妥協案を再検討して決定する。" },
  { name: "開発部", members: [["レン", "部長"], ["リツ", "実装担当"], ["マコ", "品質担当"]], routes: [3, 4], rounds: 2,
    topic: "CSV設計と受入条件。仮案は直接書込み・件数の事前確認のみ。リツは処理の簡素さ、マコは途中失敗と件数変化の危険を検討。2巡目で修正案を相互確認して決定する。" },
  { name: "営業部", members: [["コウ", "部長"], ["サキ", "顧客説明担当"], ["トワ", "営業運用担当"]], routes: [], rounds: 1,
    topic: "公開時の顧客説明と運用。サキは便利さ、トワは個人情報持出しの制約を検討。決定後サキに顧客向けFAQ3問、トワに社内操作チェックリスト5項目の作成を依頼する。" },
  { name: "実装チーム", members: [["ソラ", "リーダー"], ["ヒナ", "CSV作成担当"], ["ナギ", "データ検証担当"]], routes: [], rounds: 1,
    topic: "出力形式とサンプルを議論。決定後ヒナに架空データ3行のCSV本文、ナギにそのCSVのカンマ・引用符の検査表を作成依頼。ナギはヒナの成果を読んで検査する。" },
  { name: "QAチーム", members: [["レオ", "リーダー"], ["メイ", "境界値担当"], ["ハル", "異常系担当"]], routes: [], rounds: 1,
    topic: "受入試験を議論。決定後メイに0件・上限ちょうど・上限超過の3ケース表、ハルに生成中の件数変化・途中失敗・権限なしの3ケース表を作成依頼。入力条件と期待結果を必ず記載する。" },
];

export async function verifyRoomPyramid(output: string, live = false, preview = false) {
  // Clear only a previous run's signal, before this run can accept a stop.
  if (preview) rmSync(`${output}.stop`, { force: true });
  let realEngine: { cli: string; environment: Record<string, string> } | undefined;
  if (live) {
    const configPath = process.env.OMB_VERIFY_CC_CONFIG;
    const cli = process.env.OMB_VERIFY_CC_CLI;
    if (!configPath || !cli) throw new Error("Set OMB_VERIFY_CC_CONFIG and OMB_VERIFY_CC_CLI");
    const saved = JSON.parse(readFileSync(configPath, "utf8")).instances?.[process.env.OMB_VERIFY_CC_INSTANCE ?? "claude"]?.environment;
    if (!saved?.ANTHROPIC_AUTH_TOKEN || saved.ANTHROPIC_MODEL !== "glm-5.3") throw new Error("Expected GLM-5.3 profile");
    const environment: Record<string, string> = {};
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) if (typeof saved[key] === "string") environment[key] = saved[key];
    if (process.env.CLAUDE_CODE_GIT_BASH_PATH) environment.CLAUDE_CODE_GIT_BASH_PATH = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    realEngine = { cli, environment };
  }
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: !live, staticDir: preview ? resolve("dist") : undefined, engine: realEngine });
  const commands: any[] = [], rooms: any[] = [], teams: any[][] = [], transcripts: any[] = [];
  const control = async (...args: string[]) => {
    const result = await runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }); commands.push({ args, result }); return result as any;
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await handleToolCall(name, args, (path, options) => request(path, options, session.info.url)); commands.push({ name, args, result }); return result as any;
  };
  const nodesPath = join(session.info.dataDir, "room-handoffs.json");
  const planPath = join(session.info.dataDir, "room-plan.json");
  try {
    for (const group of organization) {
      const members: any[] = [];
      for (const [name, role] of group.members) {
        const bot = (await control("new-bot", "--name", name, "--title", `${group.name}の${role}`, "--section", "検証会社")).bot;
        if (live) await tool("set_bot_model", { bot_id: bot.id, instance_id: "claude", model: "glm-5.3", effort: "low" });
        members.push(bot);
      }
      teams.push(members);
      const bulletin = `企業組織の実験。既存3名で議論→決定→担当メンバーへの分担→担当者が下流へ依頼又は成果を作成→責任者へ報告、の順。責任者${members[0].name}は受領・会議の進行・採否・取りまとめを担当。責任者自身はsend_room_messageで下流へ送らず、決定後assign_room_memberを2人それぞれに使う。担当メンバーは議論の発言時には意見を述べ、後で担当として割り当てられたターンで実行する。担当としての実行時は議論をやり直さない。議論はdiscuss_roomで他2名を順に指定し${group.rounds}巡行う。${group.rounds === 2 ? "1巡目の懸念に責任者が修正案を出し、2巡目で両名がその修正案に回答する。" : "各自が前の人の意見に賛否と具体的な改善を述べる。"}非同期ツール受付後は即座に最終応答でターン終了。待機、再送、ScheduleWakeup禁止。返却結果への了承は最終応答に書く。架空案件のみ。外部検索・実データ・コード変更不要。日本語で各発言原則250字、成果の表やCSVだけは必要な長さで。論点:${group.topic}`;
      const room = (await tool("create_channel", { name: group.name, member_ids: members.map(b => b.id), bulletin, default_responder: { kind: "member", bot_id: members[0].id } })).channel;
      await tool("update_channel", { channel_id: room.id, require_room_discussion: true }); rooms.push(room);
    }
    for (const [index, group] of organization.entries()) for (const target of group.routes) {
      await control("room-routes", "--channel", rooms[target].id, "--from", rooms[index].id);
    }
    // Set exact responsibilities after all destination groups have been created.
    for (const [index, group] of organization.entries()) {
      const mappings = group.routes.map((to, i) => `${teams[index][i + 1].name}が${rooms[to].name}の${teams[to][0].name}宛てに依頼し、その結果をレビューして${teams[index][0].name}へ報告する`).join("。 ");
      if (mappings) await tool("update_channel", { channel_id: rooms[index].id, bulletin: `${rooms[index].bulletin}\n分担:${mappings}。担当者はlist_room_targetsから宛先IDを確認する。下層にも同じ議論・分担・実行の手順を伝える。` });
    }
    if (!live) {
      const plan: Record<string, any> = {};
      for (const [index, group] of organization.entries()) {
        const [chair, one, two] = teams[index];
        const discuss = (round: number) => ({ tool: "discuss_room", arguments: { member_ids: [one.id, two.id], topic: `${group.name}第${round}巡。修正案を検討`, request_key: `round-${round}` } });
        const assign = (bot: any) => ({ tool: "assign_room_member", arguments: { member_id: bot.id, message: `${group.name}決定に基づく担当業務。実行してください`, request_key: `owner-${bot.id}` } });
        const chairTurns: any[] = [{ steps: [{ ...assign(one), expectError: true }, discuss(1)], reply: `${group.name}仮案。各担当の意見を求めます。` }];
        if (group.rounds === 2) chairTurns.push({ expectContextIncludes: [`${two.name}懸念`], steps: [discuss(2)], reply: `${group.name}修正案。懸念を受けて条件を限定します。再確認してください。` });
        chairTurns.push({ expectContextIncludes: [`${two.name}${group.rounds === 2 ? "再検討" : "懸念"}`], steps: [assign(one), assign(two)], reply: `${group.name}決定。懸念を反映し2名に別々の責任を割り当てました。` });
        chairTurns.push({ expectContextIncludes: [`${one.name}成果`, `${two.name}成果`], reply: `${group.name}統合報告。両担当の成果を確認しました。` });
        plan[chair.id] = { turns: chairTurns };
        for (const [memberIndex, member] of [one, two].entries()) {
          const turns: any[] = [{ ...(memberIndex ? { expectContextIncludes: [`${one.name}懸念`] } : {}), reply: `${member.name}懸念。仮案に条件不足があるため修正を提案します。` }];
          if (group.rounds === 2) turns.push({ expectContextIncludes: [`${group.name}修正案`], reply: `${member.name}再検討。修正により懸念が解消しました。境界条件も追加して合意します。` });
          const to = group.routes[memberIndex];
          if (to !== undefined) {
            turns.push({ expectContextIncludes: [`${group.name}決定`], steps: [{ tool: "send_room_message", arguments: { group_id: rooms[to].id, bot_id: teams[to][0].id, message: `${group.name}決定を具体化した依頼。${organization[to].topic}`, request_key: `to-${to}` } }], reply: `${member.name}担当として下層へ依頼しました。` });
            turns.push({ expectContextIncludes: [`${rooms[to].name}統合報告`], reply: `${member.name}成果。下層の結果をレビューして責任者へ報告します。` });
          } else turns.push({ expectContextIncludes: [`${group.name}決定`], reply: `${member.name}成果。担当の成果物を作成しました。検査表:入力0件→ヘッダのみ、上限超過→中断。` });
          plan[member.id] = { turns };
        }
      }
      writeFileSync(planPath, JSON.stringify(plan));
    }
    await control("send-channel", "--channel", rooms[0].id, "--text", "@ミナト CSV出力の公開準備をしてください。経営会議で既存のアオイ・ユイと2巡議論し、修正案を再検討して方針を決めてください。その後、アオイに開発部レンへの依頼と結果確認、ユイに営業部コウへの依頼と結果確認をassign_room_memberで分担。開発部でも2巡議論の後、リツが実装チームのソラへ、マコがQAチームのレオへ依頼します。最下層と営業部は1巡議論後に各既存メンバーへ成果物作成を分担。計画だけで終わらず架空CSVサンプル・検査表・FAQ・チェックリストを作成。結果を各担当が確認して責任者へ戻し、最後に経営会議で統合してください。役割・経路は各グループの掲示にあります。実データやコード変更は不要です。");
    process.stdout.write(JSON.stringify({ phase: "running", live, fixture: session.info, rooms: rooms.map(r => ({ id: r.id, name: r.name })) }) + "\n");
    let wait: any;
    for (let i = 0; i < (live ? 50 : 6); i++) {
      wait = await control("wait", "--channel", rooms[0].id, "--timeout", "30");
      if (wait.status !== "timed-out") break;
      process.stdout.write(JSON.stringify({ phase: "waiting", seconds: (i + 1) * 30 }) + "\n");
    }
    for (const room of rooms) transcripts.push({ name: room.name, id: room.id, transcript: await control("messages", "--channel", room.id, "--limit", "100") });
    const nodes: any[] = JSON.parse(readFileSync(nodesPath, "utf8"));
    assert.equal(wait.status, "settled", JSON.stringify(wait));
    assert(nodes.every(n => n.status === "completed"), JSON.stringify(nodes));
    assert.equal(nodes.filter(n => n.kind === "work").length, 5);
    assert.equal(nodes.filter(n => n.kind === "assignment").length, 10);
    assert.equal(nodes.filter(n => n.kind === "discussion").length, 7);
    for (const [index, group] of organization.entries()) {
      const work = nodes.find(n => n.kind === "work" && n.groupId === rooms[index].id);
      assert.equal(nodes.filter(n => n.kind === "discussion" && n.parentId === work.id).length, group.rounds);
      const assigned = nodes.filter(n => n.kind === "assignment" && n.parentId === work.id);
      assert.deepEqual(new Set(assigned.map(n => n.botId)), new Set(teams[index].slice(1).map(b => b.id)));
      for (const [memberIndex, target] of group.routes.entries()) {
        const child = nodes.find(n => n.kind === "work" && n.groupId === rooms[target].id);
        const owner = nodes.find(n => n.id === child.parentId);
        assert.equal(owner.kind, "assignment"); assert.equal(owner.botId, teams[index][memberIndex + 1].id);
      }
    }
    const currentRooms = (await tool("list_channels", {})).channels;
    for (const room of rooms) assert.deepEqual(currentRooms.find((r: any) => r.id === room.id).memberIds, room.memberIds);
    const bots = (await tool("list_bots", {})).bots.filter((b: any) => teams.flat().some(member => member.id === b.id));
    const provider = !live ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
    const evidence = { ok: true, verifiedAt: new Date().toISOString(), live, model: live ? "glm-5.3" : "scripted", fixture: session.info, rooms, bots, nodes, transcripts, provider, commands };
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(evidence, null, 2));
    process.stdout.write(JSON.stringify({ phase: "verified", output, work: 5, assignment: 10, discussion: 7 }) + "\n");
    if (preview) {
      // A task-specific stop file lets the launcher run its normal finally
      // cleanup on Windows, where terminating the shell can skip JS signals.
      process.stdout.write(JSON.stringify({ phase: "preview", stopFile: `${output}.stop` }) + "\n");
      await new Promise<void>(done => {
        const timer = setInterval(() => { if (existsSync(`${output}.stop`)) { clearInterval(timer); done(); } }, 500);
        const stop = () => { clearInterval(timer); done(); }; process.once("SIGINT", stop); process.once("SIGTERM", stop);
      });
    }
    return evidence;
  } catch (error) {
    for (const room of rooms) if (!transcripts.some(t => t.id === room.id)) {
      try { transcripts.push({ name: room.name, id: room.id, transcript: await control("messages", "--channel", room.id, "--limit", "100") }); } catch { /* preserve original failure */ }
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ ok: false, error: String(error), fixture: session.info, rooms, transcripts, commands,
      nodes: existsSync(nodesPath) ? JSON.parse(readFileSync(nodesPath, "utf8")) : [], log: readFileSync(session.info.logPath, "utf8") }, null, 2));
    throw error;
  } finally { await session.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyRoomPyramid(resolve(process.argv[2] ?? "artifacts/pyramid/verification.json"), process.argv.includes("--live"), process.argv.includes("--preview"));
}
