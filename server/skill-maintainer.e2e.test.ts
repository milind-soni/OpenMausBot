import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { installLibrarySkill, readSkillLibraryIndex, retireLibrarySkill, skillsLibraryRoot } from "./skill-library.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("manages single shared-skill assignments and responsibility through a live Chief capability", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-skill-management-"));
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(gates, "finish") })
    .catch((error) => { rmSync(gates, { recursive: true, force: true }); throw error; });
  const base = fixture.info.url;
  const evidence: unknown[] = [];
  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, internal: Boolean(token), result });
    return result;
  };
  const dump = (): any => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return {}; } };
  const libraryRoot = skillsLibraryRoot(fixture.info.dataDir);
  const libraryDigest = () => {
    const hash = createHash("sha256");
    for (const path of readdirSync(libraryRoot, { recursive: true }).map(String).sort()) {
      try { hash.update(path).update(readFileSync(join(libraryRoot, path))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error; }
    }
    return hash.digest("hex");
  };
  const snapshot = () => [["config.json", "bots.json", "skills-library/index.json"].map((file) => [
    file, statSync(join(fixture.info.dataDir, file)).mtimeMs, createHash("sha256").update(readFileSync(join(fixture.info.dataDir, file))).digest("hex"),
  ]), libraryDigest()];
  try {
    expect((await request("PATCH", "/api/config", { features: { skillsLibrary: true } })).status).toBe(200);
    const author = (await request("POST", "/api/bots", { name: "Author", section: "Skill fixture", settings: { chiefOfStaff: true } })).body.bot;
    expect(author.chiefOfStaff).toBe(true);
    const target = (await request("POST", "/api/bots", { name: "Target", section: "Skill fixture" })).body.bot;
    const text = "---\nname: fixture-audit\ndescription: Audits a fixture.\n---\n\nReview it.\n";
    expect(installLibrarySkill({ name: "fixture-audit", instructions: text, source: "fixture-provenance", root: libraryRoot,
      files: [{ path: "references/details.md", content: "Keep the attachment.\n" }] })).not.toHaveProperty("error");
    expect((await request("PATCH", "/api/skills-library/fixture-audit", { enabled: true })).status).toBe(200);
    for (const name of ["fixture-keep", "fixture-stale"]) {
      expect((await request("POST", "/api/skills-library", { text: text.replaceAll("fixture-audit", name) })).status).toBe(201);
    }
    expect((await request("PUT", `/api/bots/${author.id}/skills-library`, { skills: ["fixture-audit"] })).status).toBe(200);
    expect((await request("PUT", `/api/bots/${target.id}/skills-library`, { skills: ["fixture-keep", "fixture-stale"] })).status).toBe(200);
    expect(retireLibrarySkill("fixture-stale", readSkillLibraryIndex(libraryRoot)["fixture-stale"]!.sha256, libraryRoot)).toEqual({ retired: true });
    expect((await request("POST", `/api/bots/${author.id}/messages`, { threadId: author.threadId, sendId: "maintainer-fixture-0001", text: "Start fixture" })).status).toBeLessThan(300);
    await expect.poll(() => dump().mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN, { timeout: hostTimeout(30_000) }).toBeTruthy();
    const token: string = dump().mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const targetListing = async () => {
      const result = await request("GET", `/api/internal/skills?targetBotId=${target.id}`, undefined, token);
      expect(result, "target skill listing failed").toMatchObject({ status: 200 });
      const persisted = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"))
        .find((bot: { id: string }) => bot.id === target.id)?.assignedSkills;
      expect(persisted).toEqual(result.body.assignedSkills);
      evidence.push({ target_bot_id: target.id, persistedAssignedSkills: persisted });
      return result.body;
    };
    const targetState = async (name = "fixture-audit") => (await targetListing()).library.find((skill: { name: string }) => skill.name === name);
    const manage = async (action: string, name = "fixture-audit", revision?: string) => request("POST", "/api/internal/skills/stage", {
      action, skill_name: name, target_bot_id: target.id, base_revision: revision ?? (await targetState(name)).management_revision,
    }, token);
    const packageBefore = libraryDigest();
    for (const action of ["assign", "unassign", "share"]) {
      const applied = await manage(action);
      expect(applied).toMatchObject({ status: 200, body: { state: "applied", result: { skill: { assigned: action !== "unassign", available: action !== "unassign" } } } });
      expect(await targetState()).toEqual(applied.body.result.skill);
      expect((await targetListing()).assignedSkills).toEqual(action === "unassign" ? ["fixture-keep", "fixture-stale"] : ["fixture-keep", "fixture-stale", "fixture-audit"]);
      expect(libraryDigest()).toBe(packageBefore);
    }
    expect(await targetState("fixture-stale")).toMatchObject({ in_library: false, assigned: true });
    expect((await manage("unassign", "fixture-stale")).status).toBe(200);
    expect((await targetListing()).assignedSkills).toEqual(["fixture-keep", "fixture-audit"]);
    const rejected = async (revision: string, expected: number, action = "unassign") => {
      const before = snapshot();
      expect((await manage(action, "fixture-audit", revision)).status).toBe(expected);
      expect(snapshot()).toEqual(before);
      evidence.push({ action, rejected: expected, unchangedSnapshot: before });
    };
    await rejected("wrong-revision", 409);
    const revision = (await targetState()).management_revision;
    expect((await request("PATCH", `/api/bots/${author.id}`, { chiefOfStaff: false })).status).toBe(200);
    await rejected(revision, 403);
    expect((await request("PATCH", `/api/bots/${author.id}`, { chiefOfStaff: true })).status).toBe(200);
    expect((await request("PATCH", `/api/bots/${target.id}`, { visibility: "admins" })).status).toBe(200);
    await rejected(revision, 403);
    expect((await request("PATCH", `/api/bots/${target.id}`, { visibility: "everyone" })).status).toBe(200);
    const listing = async () => {
      const result = await request("GET", `/api/internal/skills?fromBotId=${author.id}&fromThreadId=${author.threadId}`, undefined, token);
      expect(result, "author skill listing failed").toMatchObject({ status: 200 });
      return result.body.skills.find((skill: { name: string }) => skill.name === "fixture-audit");
    };
    const before = await listing();
    expect(before.shared).toMatchObject({ scope: "selected_bots", enabled: true, maintainer_status: "unassigned" });
    const transfer = { action: "transfer_maintainer", skill_name: "fixture-audit", target_bot_id: target.id, base_revision: before.shared.management_revision };
    const applied = await request("POST", "/api/internal/skills/stage", transfer, token);
    expect(applied).toMatchObject({ status: 200, body: { state: "applied", result: { maintainer_bot_id: target.id, maintainer_status: "assigned", enabled: true, scope: "selected_bots" } } });
    expect((await listing()).shared).toEqual(applied.body.result);
    expect((await request("POST", "/api/internal/skills/stage", transfer, token)).status).toBe(409);
    const library = (await request("GET", "/api/skills-library")).body.skills.find((skill: { name: string }) => skill.name === "fixture-audit");
    expect(library.assignedBots.map((bot: { id: string }) => bot.id).sort()).toEqual([author.id, target.id].sort());
    expect((await request("GET", "/api/skills-library/fixture-audit")).body.text).toBe(text);
    expect(readFileSync(join(libraryRoot, "skills/fixture-audit/references/details.md"), "utf8")).toBe("Keep the attachment.\n");
    const full = ["fixture-keep", ...Array.from({ length: 199 }, (_, index) => `fixture-boundary-${index}`)];
    for (const name of full.slice(1)) {
      expect(installLibrarySkill({ name, instructions: text.replaceAll("fixture-audit", name), source: "fixture", root: libraryRoot })).not.toHaveProperty("error");
    }
    expect((await request("PUT", `/api/bots/${target.id}/skills-library`, { skills: full.slice(1) })).status).toBe(200);
    expect(await manage("assign")).toMatchObject({ status: 200, body: { state: "applied" } });
    expect((await targetListing()).assignedSkills).toEqual([...full.slice(1), "fixture-audit"]);
    const assigned = snapshot();
    for (const action of ["assign", "share"]) {
      expect(await manage(action)).toMatchObject({ status: 200, body: { state: "applied" } });
      expect(snapshot()).toEqual(assigned);
    }
    expect((await request("PUT", `/api/bots/${target.id}/skills-library`, { skills: full })).status).toBe(200);
    await rejected("wrong-revision", 409, "assign");
    expect((await request("PATCH", `/api/bots/${author.id}`, { chiefOfStaff: false })).status).toBe(200);
    await rejected("wrong-revision", 403, "share");
    expect((await request("PATCH", `/api/bots/${author.id}`, { chiefOfStaff: true })).status).toBe(200);
    const fullRevision = (await targetState()).management_revision;
    for (const action of ["assign", "share"]) await rejected(fullRevision, 422, action);
    const fullSnapshot = snapshot();
    expect((await request("PUT", `/api/bots/${target.id}/skills-library`, { skills: [...full, "fixture-audit"] })).status).toBe(400);
    expect(snapshot()).toEqual(fullSnapshot);
    expect((await targetListing()).assignedSkills).toEqual(full);
    const staleName = full[1]!;
    expect(retireLibrarySkill(staleName, readSkillLibraryIndex(libraryRoot)[staleName]!.sha256, libraryRoot)).toEqual({ retired: true });
    expect(await targetState(staleName)).toMatchObject({ assigned: true, in_library: false });
    expect((await manage("unassign", staleName)).status).toBe(200);
    expect((await targetListing()).assignedSkills).toEqual(full.filter((name) => name !== staleName));
    expect((await manage("share")).status).toBe(200);
    expect((await targetListing()).assignedSkills).toEqual([...full.filter((name) => name !== staleName), "fixture-audit"]);
    expect((await request("PATCH", "/api/skills-library/fixture-audit", { everyBot: true })).status).toBe(200);
    expect((await request("POST", `/api/bots/${target.id}/messages`, { threadId: target.threadId, sendId: "assignment-fixture-0002", text: "Read back fixture skills" })).status).toBeLessThan(300);
    await expect.poll(() => dump().mcpConfig?.mcpServers?.agents?.env?.OMB_BOT_ID, { timeout: hostTimeout(30_000) }).toBe(target.id);
    const targetToken: string = dump().mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const unassigned = await manage("unassign");
    expect(unassigned).toMatchObject({ status: 200, body: { result: { skill: { scope: "all_bots", assigned: false, available: true } } } });
    const state = await targetState();
    expect(state).toEqual(unassigned.body.result.skill);
    const general = await request("GET", "/api/internal/skills", undefined, targetToken);
    expect(general.status).toBe(200);
    expect(general.body.skills.find((skill: { name: string }) => skill.name === "fixture-audit")).toMatchObject({ enabled: true,
      shared: { scope: state.scope, assigned: state.assigned, enabled: state.enabled, management_revision: state.management_revision } });
    expect((await targetListing()).assignedSkills).toEqual(full.filter((name) => name !== staleName));
  } finally {
    const evidencePath = `${fixture.info.logPath}.skill-management.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
    rmSync(gates, { recursive: true, force: true });
  }
}, hostTimeout(90_000));
