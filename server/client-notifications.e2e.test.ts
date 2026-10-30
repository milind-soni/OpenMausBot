import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("lets a Team Cloud member list and read only their own notification feed", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-notifications-token",
    team: { id: "team-notifications", name: "Notifications" } });
  try {
    const team = fixture.team!;
    const owner = await team.pair({ email: "ada@notifications.test", role: "owner" });
    const member = await team.pair({ email: "bob@notifications.test", role: "member" });
    const created = await team.as(owner.token!, "POST", "/api/bots", { name: "Scout" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const opened = await team.as(owner.token!, "POST", `/api/bots/${bot.id}/tasks`, { title: "Ada's private chat" });
    expect(opened.status).toBe(201);
    expect((await team.as(owner.token!, "GET", "/api/notifications")).status).toBe(200);
    const db = new DatabaseSync(join(team.home, ".openmausbot", "messages.db"));
    try {
      const insert = db.prepare("INSERT INTO notification_log(id, at, kind, bot_id, bot_name, thread_id, title, body, for_person) VALUES (?, ?, ?, ?, 'Scout', ?, 'Fixture', '', ?)");
      const ada = personKey({ id: "", email: "ada@notifications.test" });
      for (const [id, kind, threadId, person] of [
        ["own-a", "done", bot.mainThreadId, null], ["own-b", "done", bot.mainThreadId, null],
        ["private", "done", opened.body.task.threadId, null],
        ["spend", "spend", bot.mainThreadId, null],
        ["owners-ask", "question", bot.mainThreadId, null], ["targeted", "done", bot.mainThreadId, ada],
      ] as const) insert.run(id, Date.now(), kind, bot.id, threadId, person);

      const listed = await team.as(member.token!, "GET", "/api/notifications");
      expect(listed.status).toBe(200);
      expect(listed.body.notifications.map((entry: { id: string }) => entry.id).sort()).toEqual(["own-a", "own-b"]);
      expect((await team.as(member.token!, "POST", "/api/notifications/own-a/read")).status).toBe(200);
      for (const id of ["private", "owners-ask", "targeted", "spend"]) {
        expect((await team.as(member.token!, "POST", `/api/notifications/${id}/read`)).status, id).toBe(404);
      }
      expect((await team.as(member.token!, "POST", "/api/notifications/read-all")).status).toBe(200);
      expect(db.prepare("SELECT id FROM notification_log WHERE read = 1 ORDER BY id").all().map((row) => row.id)).toEqual(["own-a", "own-b"]);
      expect(db.prepare("SELECT id FROM notification_log WHERE read = 0 ORDER BY id").all().map((row) => row.id)).toEqual(["owners-ask", "private", "spend", "targeted"]);
    } finally {
      db.close();
    }
  } finally {
    await fixture.close();
  }
}, hostTimeout(120_000));

it("keeps admin spend alerts unread when a Team Cloud member opens a shared conversation", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-spend-read-token",
    team: { id: "team-spend-read", name: "Spend reads" } });
  try {
    const team = fixture.team!;
    const owner = await team.pair({ email: "ada@notifications.test", role: "owner" });
    const member = await team.pair({ email: "bob@notifications.test", role: "member" });
    const created = await team.as(owner.token!, "POST", "/api/bots", { name: "Scout" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const channel = await team.as(owner.token!, "POST", "/api/groups", { name: "Updates", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(channel.status).toBe(201);
    const group = channel.body.group;
    const unread = async () => {
      const listed = await team.as(owner.token!, "GET", "/api/notifications");
      expect(listed.status).toBe(200);
      return listed.body.notifications.filter((entry: { read: boolean }) => !entry.read).map((entry: { id: string }) => entry.id).sort();
    };
    await unread();
    const db = new DatabaseSync(join(team.home, ".openmausbot", "messages.db"));
    try {
      const insert = db.prepare("INSERT INTO notification_log(id, at, kind, bot_id, bot_name, thread_id, title, body) VALUES (?, ?, 'spend', ?, 'Scout', ?, 'Fixture spend', '$12 of $20 spent')");
      insert.run("shared-spend", Date.now(), bot.id, bot.mainThreadId);
      insert.run("workspace-spend", Date.now(), bot.id, "");
      for (const [path, threadId] of [
        [`/api/bots/${bot.id}/read`, bot.mainThreadId],
        [`/api/bots/${bot.id}/tasks/${bot.mainThreadId}`, bot.mainThreadId],
        [`/api/groups/${group.id}/read`, group.threadId],
        [`/api/groups/${group.id}/tasks/${group.threadId}`, group.threadId],
      ]) {
        db.prepare("UPDATE notification_log SET read = 0").run();
        db.prepare("UPDATE notification_log SET thread_id = ? WHERE id = 'shared-spend'").run(threadId);
        expect(await unread()).toEqual(["shared-spend", "workspace-spend"]);
        expect((await team.as(member.token!, "POST", path, { threadId })).status, path).toBe(200);
        expect(await unread(), path).toEqual(["shared-spend", "workspace-spend"]);
        expect((await team.as(owner.token!, "POST", path, { threadId })).status, path).toBe(200);
        expect(await unread(), path).toEqual(["workspace-spend"]);
      }
    } finally {
      db.close();
    }
  } finally {
    await fixture.close();
  }
}, hostTimeout(120_000));
