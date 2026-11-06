import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "../src/store.ts";
import type { DeskEvent, DeskState } from "../src/types.ts";

function tinySeed(): DeskState {
  return {
    requirements: [
      { id: "REQ-1041", title: "QA Lead", client: "Litware", clientContact: "qa@litware.example.com", location: "Austin, TX", workMode: "remote", rate: 55, employmentType: "C2C", skills: ["selenium"], minYears: 6, jd: "QA lead", status: "open", receivedAt: 1, postedOn: [] },
    ],
    candidates: [],
    pipeline: [],
    emails: [],
    screens: [],
    paperwork: [],
    submissions: [],
    interviews: [],
    onboarding: [],
    timesheets: [],
    vendors: [],
    activity: [],
    pending: [],
    script: {
      heroClientEmail: { kind: "client_requirement", from: "a@contosohealth.example.com", to: ["desk@desk.example.com"], subject: "s", body: "b", attachments: [] },
      vendorReplies: [],
      morning: {
        feedbackEmail: { kind: "client_feedback", from: "a@contosohealth.example.com", to: ["desk@desk.example.com"], subject: "f", body: "f", attachments: [] },
        offerAcceptedEmail: { kind: "offer_accepted", from: "a@contosohealth.example.com", to: ["desk@desk.example.com"], subject: "o", body: "o", attachments: [] },
        timesheetMonth: "2026-10",
      },
    },
    counters: { REQ: 1041 },
    flags: { clientEmailDelivered: false, morningDelivered: false },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "desk-store-"));
  const seedPath = join(dir, "seed.json");
  const statePath = join(dir, "state.json");
  writeFileSync(seedPath, JSON.stringify(tinySeed()));
  return { seedPath, statePath };
}

test("loads seed when no state file exists", () => {
  const paths = setup();
  const store = createStore(paths);
  assert.equal(store.state.requirements.length, tinySeed().requirements.length);
});

test("save then new store reloads state", () => {
  const paths = setup();
  const store = createStore(paths);
  store.state.flags.clientEmailDelivered = true;
  store.save();
  const again = createStore(paths);
  assert.equal(again.state.flags.clientEmailDelivered, true);
});

test("reset restores seed and emits reset", () => {
  const paths = setup();
  const store = createStore(paths);
  const seen: DeskEvent[] = [];
  store.on((e) => seen.push(e));
  store.state.flags.morningDelivered = true;
  store.state.requirements.pop();
  store.reset();
  assert.deepEqual(store.state, tinySeed());
  assert.equal(seen.at(-1)?.name, "reset");
});

test("nextId formats", () => {
  const store = createStore(setup());
  assert.equal(store.nextId("REQ"), "REQ-1042");
  assert.equal(store.nextId("EM"), "EM-0001");
  assert.equal(store.nextId("EM"), "EM-0002");
});

test("emit stamps time and calls listeners; unsubscribe stops calls", () => {
  const store = createStore({ ...setup(), now: () => 5000 });
  const seen: DeskEvent[] = [];
  const off = store.on((e) => seen.push(e));
  store.emit({ name: "job_posted", reqId: "REQ-1041" });
  assert.deepEqual(seen, [{ name: "job_posted", reqId: "REQ-1041", at: 5000 }]);
  off();
  store.emit({ name: "job_posted" });
  assert.equal(seen.length, 1);
});

test("log appends activity with actor and ids", () => {
  const store = createStore({ ...setup(), now: () => 7000 });
  store.log("Matcher", "scored 3", { reqId: "REQ-1041" });
  assert.deepEqual(store.state.activity.at(-1), { at: 7000, actor: "Matcher", text: "scored 3", reqId: "REQ-1041" });
});
