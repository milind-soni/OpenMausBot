import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FULL_TASK_SCOPED_SYSTEM_PROMPT } from "./access-profile.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { FULL_TASK_SCOPED_MIGRATION_TITLE, migrateFullTaskScopedData } from "./full-task-scoped-migration.ts";

const roots: string[] = [];
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-full-migration-"));
  roots.push(dataDir);
  const bots = [
    {
      id: "finch-id",
      name: "Finch",
      threadId: "finch-old",
      title: "Builder",
      description: "old restrictive Finch prompt",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "claude", model: "sonnet" },
      resumeCursors: { claude: "finch-native-session" },
      cwd: "/tmp/old-finch-cwd",
      computer: "vm",
      autoApprove: false,
      pinnedMessageId: "pin-finch",
      tasks: [
        {
          threadId: "finch-old",
          title: "Keep Finch history",
          createdAt: 1,
          resumeCursors: { claude: "finch-native-session" },
          lastInstanceId: "claude",
          cwd: "/tmp/historical-finch-cwd",
          usage: { input: 10, output: 5, costUsd: null, turns: 1 },
        },
      ],
      createdAt: 1,
    },
    {
      id: "cogs-id",
      name: "Cogs",
      threadId: "cogs-old",
      title: "Engineer",
      description: "old restrictive Cogs prompt",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "codex", model: "gpt" },
      resumeCursors: { codex: "cogs-native-session" },
      cwd: "/tmp/old-cogs-cwd",
      tasks: [{ threadId: "cogs-old", title: "Keep Cogs history", createdAt: 2, resumeCursors: { codex: "cogs-native-session" }, lastInstanceId: "codex" }],
      createdAt: 2,
    },
    {
      id: "basil-id",
      name: "Basil",
      threadId: "basil-thread",
      title: "Old helper",
      description: "preserve me",
      notifications: true,
      color: "red",
      unread: false,
      modelSelection: { instanceId: "claude", model: "sonnet" },
      resumeCursors: { claude: "preserved-basil-session" },
      tasks: [{ threadId: "basil-thread", title: "Preserve Basil history", createdAt: 3, resumeCursors: { claude: "preserved-basil-session" } }],
      computer: "local",
      autoApprove: true,
      alwaysAllow: ["Bash", "mcp__credvault"],
      chiefOfStaff: true,
      hidden: false,
      createdAt: 3,
    },
    {
      id: "other-id",
      name: "Other",
      threadId: "other-thread",
      description: "unchanged",
      resumeCursors: {},
      tasks: [],
    },
  ];
  const routines = {
    version: 1,
    routines: [
      { id: "rb", botId: "basil-id", enabled: true, nextRunAt: 50, updatedAt: 1 },
      { id: "rf", botId: "finch-id", enabled: true, nextRunAt: 50, updatedAt: 1 },
    ],
    runs: [
      { id: "run-b", botId: "basil-id", status: "running", threadId: "basil-routine-thread" },
      { id: "run-f", botId: "finch-id", status: "queued" },
      { id: "run-done", botId: "basil-id", status: "completed" },
    ],
  };
  const webhooks = {
    version: 1,
    webhooks: [
      { id: "wb", botId: "basil-id", enabled: true, updatedAt: 1, secretHash: "a".repeat(64) },
      { id: "wf", botId: "finch-id", enabled: true, updatedAt: 1, secretHash: "b".repeat(64) },
    ],
    deliveries: [{ key: "keep", runId: "run", at: 1 }],
    attempts: [{ id: "attempt", webhookId: "wb", receivedAt: 1, outcome: "accepted", statusCode: 202 }],
  };
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots, null, 2));
  writeFileSync(join(dataDir, "routines.json"), JSON.stringify(routines, null, 2));
  writeFileSync(join(dataDir, "webhooks.json"), JSON.stringify(webhooks, null, 2));
  writeFileSync(join(dataDir, "messages-finch-old.json"), "FINCH TRANSCRIPT BYTES");
  writeFileSync(join(dataDir, "messages-cogs-old.json"), "COGS TRANSCRIPT BYTES");
  mkdirSync(join(dataDir, "workspaces", "basil-id"), { recursive: true });
  writeFileSync(join(dataDir, "workspaces", "basil-id", "owner.txt"), "BASIL WORKSPACE BYTES");
  return { dataDir, bots, routines, webhooks };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempDir));
});

describe("full-task-scoped bot migration", () => {
  it("starts clean Finch/Cogs tasks and recoverably quarantines Basil", () => {
    const { dataDir, bots: originalBots } = fixture();
    const ids = ["finch-new", "cogs-new"];
    const receipt = migrateFullTaskScopedData({ dataDir, now: () => 1_750_000_000_000, newId: () => ids.shift()! });

    expect(receipt).toMatchObject({
      schema: "openmaus.full-task-scoped-migration.v1",
      changed: true,
      changedFiles: ["bots.json", "routines.json", "webhooks.json"],
      basilRoutinesDisabled: 1,
      basilRunsCancelled: 1,
      basilWebhooksDisabled: 1,
    });
    const migrated = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    for (const [name, threadId] of [["Finch", "finch-new"], ["Cogs", "cogs-new"]]) {
      const bot = migrated.find((candidate: { name: string }) => candidate.name === name);
      expect(bot).toMatchObject({
        accessProfile: "full-task-scoped",
        autoApprove: true,
        computer: "local",
        description: FULL_TASK_SCOPED_SYSTEM_PROMPT,
        resumeCursors: {},
        threadId,
      });
      expect(bot.cwd).toBeUndefined();
      expect(bot.pinnedMessageId).toBeUndefined();
      expect(bot.tasks[0]).toEqual({
        threadId,
        title: FULL_TASK_SCOPED_MIGRATION_TITLE,
        createdAt: 1_750_000_000_000,
        resumeCursors: {},
      });
      expect(bot.tasks[1].title).toContain(`Keep ${name} history`);
      expect(bot.tasks[1].resumeCursors).toEqual({});
      expect(bot.tasks[1].lastInstanceId).toBeUndefined();
    }
    expect(migrated.find((bot: { name: string }) => bot.name === "Finch").tasks[1]).toMatchObject({
      cwd: "/tmp/historical-finch-cwd",
      usage: { input: 10, output: 5, turns: 1 },
    });

    const basil = migrated.find((bot: { name: string }) => bot.name === "Basil");
    expect(basil).toMatchObject({
      hidden: true,
      autoApprove: false,
      computer: "off",
      alwaysAllow: [],
      chiefOfStaff: false,
      resumeCursors: { claude: "preserved-basil-session" },
      tasks: originalBots[2]!.tasks,
    });
    expect(readFileSync(join(dataDir, "messages-finch-old.json"), "utf8")).toBe("FINCH TRANSCRIPT BYTES");
    expect(readFileSync(join(dataDir, "messages-cogs-old.json"), "utf8")).toBe("COGS TRANSCRIPT BYTES");
    expect(readFileSync(join(dataDir, "workspaces", "basil-id", "owner.txt"), "utf8")).toBe("BASIL WORKSPACE BYTES");

    const routines = JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8"));
    expect(routines.routines[0]).toMatchObject({ botId: "basil-id", enabled: false, nextRunAt: null, updatedAt: 1_750_000_000_000 });
    expect(routines.routines[1]).toMatchObject({ botId: "finch-id", enabled: true, nextRunAt: 50 });
    expect(routines.runs[0]).toMatchObject({ botId: "basil-id", status: "cancelled", finishedAt: 1_750_000_000_000 });
    expect(routines.runs[1]).toMatchObject({ botId: "finch-id", status: "queued" });
    expect(routines.runs[2]).toMatchObject({ botId: "basil-id", status: "completed" });

    const webhooks = JSON.parse(readFileSync(join(dataDir, "webhooks.json"), "utf8"));
    expect(webhooks.webhooks[0]).toMatchObject({ botId: "basil-id", enabled: false, updatedAt: 1_750_000_000_000, secretHash: "a".repeat(64) });
    expect(webhooks.webhooks[1]).toMatchObject({ botId: "finch-id", enabled: true });
    expect(webhooks.deliveries).toHaveLength(1);
    expect(webhooks.attempts).toHaveLength(1);

    const backup = join(dataDir, "backups", receipt.backupDirectory!);
    expect(JSON.parse(readFileSync(join(backup, "bots.json"), "utf8"))).toEqual(originalBots);
    expect(JSON.parse(readFileSync(join(backup, "basil-record.json"), "utf8"))).toEqual(originalBots[2]);
    expect(receipt.afterSha256["bots.json"]).toBe(sha(readFileSync(join(dataDir, "bots.json"))));
    expect(existsSync(join(dataDir, ".full-task-scoped-migration.transaction.json"))).toBe(false);

    const activeThreads = migrated.filter((bot: { name: string }) => ["Finch", "Cogs"].includes(bot.name)).map((bot: { threadId: string }) => bot.threadId);
    const repeated = migrateFullTaskScopedData({
      dataDir,
      now: () => 1_750_000_001_000,
      newId: () => {
        throw new Error("an idempotent migration must not allocate another task");
      },
    });
    expect(repeated).toMatchObject({ changed: false, backupDirectory: null, changedFiles: [] });
    const afterRepeat = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    expect(afterRepeat.filter((bot: { name: string }) => ["Finch", "Cogs"].includes(bot.name)).map((bot: { threadId: string }) => bot.threadId)).toEqual(activeThreads);
  });

  it("rolls every replaced file back when a later write fails", () => {
    const { dataDir } = fixture();
    const originals = Object.fromEntries(
      ["bots.json", "routines.json", "webhooks.json"].map((name) => [name, readFileSync(join(dataDir, name))]),
    );
    expect(() =>
      migrateFullTaskScopedData({
        dataDir,
        newId: (() => {
          const ids = ["fresh-finch", "fresh-cogs"];
          return () => ids.shift()!;
        })(),
        beforeWrite: (name) => {
          if (name === "routines.json") throw new Error("injected write failure");
        },
      }),
    ).toThrow("injected write failure");
    for (const [name, contents] of Object.entries(originals)) {
      expect(readFileSync(join(dataDir, name))).toEqual(contents);
    }
    expect(existsSync(join(dataDir, "migration-full-task-scoped.v1.json"))).toBe(false);
    expect(existsSync(join(dataDir, ".full-task-scoped-migration.transaction.json"))).toBe(false);
  });

  it("fails closed before writing when a named bot is ambiguous", () => {
    const { dataDir } = fixture();
    const botsPath = join(dataDir, "bots.json");
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    bots.push({ ...bots[0], id: "second-finch" });
    writeFileSync(botsPath, JSON.stringify(bots));
    const before = readFileSync(botsPath);
    expect(() => migrateFullTaskScopedData({ dataDir })).toThrow("Expected exactly one Finch bot; found 2");
    expect(readFileSync(botsPath)).toEqual(before);
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });
});
