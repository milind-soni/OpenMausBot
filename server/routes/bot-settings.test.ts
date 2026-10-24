import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCustomMascotFitContext, suggestCustomMascotAnchor } from "../../shared/custom-mascot-fitting.ts";
import { FACE_BOX } from "../../shared/cursor-face-data.ts";
import type { WireBot } from "../../shared/wire.ts";
import { ATTACHMENTS_DIR } from "../attachments.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { closeMessageDb } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { validateCustomMascotDefinition } from "../custom-mascot-validation.ts";
import { Store, type BotRecord, type BotWireProjection } from "../store.ts";
import type { ModelSelection } from "../contracts.ts";
import { createBotSettingsRoutes, type BotSettingsRouteDeps } from "./bot-settings.ts";
import { dispatchRoutes } from "./table.ts";

type DeferredGate = {
  wait: Promise<void>;
  release: () => void;
  entered: Promise<void>;
  enter: () => void;
};

function deferredGate(): DeferredGate {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release, entered, enter };
}

const selection: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const activeGates: DeferredGate[] = [];

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  for (const gate of activeGates.splice(0)) gate.release();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  closeMessageDb();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("test server did not bind a TCP port"));
      resolve(address.port);
    });
  });
}

function bunnyDefinition() {
  const outline = Array.from({ length: 96 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    return [FACE_BOX / 2 + Math.cos(angle) * 108, FACE_BOX / 2 + Math.sin(angle) * 108] as const;
  });
  const anchor = suggestCustomMascotAnchor(createCustomMascotFitContext(outline));
  return validateCustomMascotDefinition({ name: "Bunny", outline, anchor });
}

function appearanceFiles() {
  return existsSync(ATTACHMENTS_DIR) ? readdirSync(ATTACHMENTS_DIR).sort() : [];
}

function wireBot(record: BotRecord): WireBot {
  const {
    tasks: _tasks,
    avatarUrl: _avatarUrl,
    resumeCursors: _resumeCursors,
    approvalGrant: _approvalGrant,
    lastProfileRequestId: _lastProfileRequestId,
    lastTeamSetupReceipt: _lastTeamSetupReceipt,
    packageBase: _packageBase,
    assignedSkills: _assignedSkills,
    ...publicFields
  } = record;
  const projection: BotWireProjection = publicFields;
  return { ...projection, avatarUrl: record.avatarUrl ?? null, tasks: [] };
}

describe("Store bot appearance revisions", () => {
  it("tracks explicit avatar, body, profile, color, and expression choices without persisting the revision", () => {
    const store = new Store(() => selection);
    const bot = store.createBot({ name: "Revision fixture" });
    let expected = store.appearanceRevisions.get(bot);
    const checkBump = (choose: () => void) => {
      choose();
      expected += 1;
      expect(store.appearanceRevisions.get(bot)).toBe(expected);
    };

    checkBump(() => { store.patchBot(bot.id, { avatarUrl: bot.avatarUrl }); });
    checkBump(() => { store.patchBot(bot.id, { avatarCrop: bot.avatarCrop }); });
    checkBump(() => { store.patchBot(bot.id, { mascotBody: bot.mascotBody }); });
    checkBump(() => { store.patchBot(bot.id, { mascotProfile: bot.mascotProfile }); });
    checkBump(() => { store.patchBot(bot.id, { color: bot.color }); });
    checkBump(() => { store.patchBot(bot.id, { mascotExpression: bot.mascotExpression }); });
    checkBump(() => { store.patchBotProfile(bot.id, { avatarUrl: bot.avatarUrl, avatarCrop: bot.avatarCrop }); });
    checkBump(() => { store.addOrSelectMascotShape(bot.id, bunnyDefinition()); });

    expect(bot).not.toHaveProperty("appearanceRevision");
    const persisted = JSON.parse(readFileSync(`${DATA_DIR}/bots.json`, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]).not.toHaveProperty("appearanceRevision");
    const restoredStore = new Store(() => selection);
    const restored = restoredStore.bot(bot.id);
    expect(restored).not.toBeNull();
    if (!restored) throw new Error("restored bot is missing");
    expect(restoredStore.appearanceRevisions.get(restored)).toBe(0);
  });
});

describe("POST /api/bots/:id/mascot-shapes persistence errors", () => {
  it("returns a fixed 500 message and leaves the bot unchanged when the registry cannot be written", async () => {
    const store = new Store(() => selection);
    const bot = store.createBot({ name: "Mascot persistence fixture" });
    const route = createBotSettingsRoutes({
      store,
      cfg: {} as AppConfig,
      broadcast: () => {},
      wireBot,
    } as unknown as BotSettingsRouteDeps);
    const app = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      try {
        const handled = await dispatchRoutes([route], {
          req,
          res,
          url,
          path: url.pathname,
          method: req.method ?? "GET",
          auth: { kind: "loopback", scopes: ["admin", "client"] } satisfies RequestAuth,
          json,
          readBody,
        });
        if (!handled) json(res, 404, { error: "not found" });
      } catch (error) {
        const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
        json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    servers.push(app);
    const port = await listen(app);
    const base = "http://127.0.0.1:" + port;
    const botsPath = join(DATA_DIR, "bots.json");
    const backupPath = join(DATA_DIR, "bots.json.mascot-storage-test-backup");
    const originalBytes = readFileSync(botsPath);
    const validatedShape = bunnyDefinition();
    const body = {
      shape: {
        name: "Storage failure Bunny",
        outline: validatedShape.outline,
        anchor: validatedShape.anchor,
      },
    };
    const before = structuredClone(bot);

    let moved = false;
    try {
      renameSync(botsPath, backupPath);
      moved = true;
      mkdirSync(botsPath);
      const response = await fetch(base + "/api/bots/" + bot.id + "/mascot-shapes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      expect(response.status).toBe(500);
      expect(result.error).toBe("custom mascot could not be saved");
      expect(result.error).not.toContain(DATA_DIR);
    } finally {
      if (moved) {
        rmSync(botsPath, { recursive: true, force: true });
        if (existsSync(backupPath)) renameSync(backupPath, botsPath);
      }
    }

    expect(readFileSync(botsPath)).toEqual(originalBytes);
    expect(store.bot(bot.id)).toEqual(before);
  });
});

describe("POST /api/bots/:id/avatar/generate", () => {
  it("rejects a late image after same-value custom, builtin, color, and expression selections", async () => {
    const gates: DeferredGate[] = [];
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const imageProvider = createServer((_req, res) => {
      const gate = gates.shift();
      if (!gate) {
        res.writeHead(500).end();
        return;
      }
      gate.enter();
      void gate.wait.then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      });
    });
    servers.push(imageProvider);
    const imagePort = await listen(imageProvider);
    const cfg = {
      imageGen: { provider: "custom", customUrl: `http://127.0.0.1:${imagePort}/v1`, customModel: "fixture/image" },
    } as AppConfig;
    const store = new Store(() => selection);
    const bot = store.createBot({ name: "Appearance race fixture" });
    const route = createBotSettingsRoutes({
      store,
      cfg,
      broadcast: () => {},
      wireBot,
    } as unknown as BotSettingsRouteDeps);
    const app = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      try {
        const handled = await dispatchRoutes([route], {
          req,
          res,
          url,
          path: url.pathname,
          method: req.method ?? "GET",
          auth: { kind: "loopback", scopes: ["admin", "client"] } satisfies RequestAuth,
          json,
          readBody,
        });
        if (!handled) json(res, 404, { error: "not found" });
      } catch (error) {
        const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
        json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    servers.push(app);
    const appPort = await listen(app);
    const base = `http://127.0.0.1:${appPort}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const shape = bunnyDefinition();
    const { id: _shapeId, ...definition } = shape;
    const shapePath = `/api/bots/${bot.id}/mascot-shapes`;
    const selected = await call("POST", shapePath, { shape: definition });
    expect(selected.status).toBe(201);
    expect(selected.body.bot).toMatchObject({ avatarCrop: "mascot", mascotProfile: { selected: { kind: "custom" } } });

    const assertLateGenerationRejected = async (chooseAgain: () => Promise<{ status: number }>) => {
      const before = structuredClone(store.bot(bot.id)!);
      const filesBefore = appearanceFiles();
      const gate = deferredGate();
      gates.push(gate);
      activeGates.push(gate);
      const generation = call("POST", `/api/bots/${bot.id}/avatar/generate`, { prompt: "blue fox" });
      try {
        await Promise.race([
          gate.entered,
          generation.then((result) => { throw new Error(`generation returned before reaching fixture provider: ${result.status}`); }),
        ]);
        const reselection = await chooseAgain();
        expect(reselection.status).toBeGreaterThanOrEqual(200);
        expect(reselection.status).toBeLessThan(300);
        gate.release();

        const result = await generation;
        expect(result.status).toBe(409);
        const current = store.bot(bot.id)!;
        expect(current.avatarUrl).toBe(before.avatarUrl);
        expect(current.avatarCrop).toBe(before.avatarCrop);
        expect(current.mascotProfile).toEqual(before.mascotProfile);
        const persisted = JSON.parse(readFileSync(`${DATA_DIR}/bots.json`, "utf8")) as Array<Record<string, unknown>>;
        expect(persisted.find((candidate) => candidate.id === bot.id)).toMatchObject({
          avatarCrop: before.avatarCrop,
          mascotProfile: before.mascotProfile,
        });
        expect(appearanceFiles()).toEqual(filesBefore);
      } finally {
        gate.release();
        await generation.catch(() => undefined);
        const index = activeGates.indexOf(gate);
        if (index >= 0) activeGates.splice(index, 1);
      }
    };

    await assertLateGenerationRejected(() => call("POST", shapePath, { shape: definition }));

    store.patchBot(bot.id, { mascotBody: "cursor" });
    const selectedBuiltin = store.bot(bot.id)!;
    expect(selectedBuiltin.mascotProfile).toMatchObject({ selected: { kind: "builtin", bodyId: "cursor" }, shapes: [{ name: "Bunny" }] });
    await assertLateGenerationRejected(async () => ({ status: store.patchBot(bot.id, { mascotBody: "cursor" }) ? 200 : 404 }));

    store.patchBot(bot.id, { color: "cyan", mascotExpression: "focused" });
    await assertLateGenerationRejected(async () => ({
      status: store.patchBot(bot.id, { color: "cyan", mascotExpression: "focused" }) ? 200 : 404,
    }));
  }, 20_000);
});
