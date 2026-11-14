import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSeed, HERO_REQUIREMENT } from "../seed/generate.ts";
import { keywordScore } from "../src/rank.ts";
import type { DeskState } from "../src/types.ts";

function heroRanking(seed: DeskState) {
  return seed.candidates
    .map((c) => ({ name: c.name, score: keywordScore(c, HERO_REQUIREMENT) }))
    .sort((a, b) => b.score - a.score);
}

function addressOf(s: string): string {
  return /<([^>]+)>/.exec(s)?.[1] ?? s;
}

test("is deterministic", () => {
  assert.equal(JSON.stringify(buildSeed()), JSON.stringify(buildSeed()));
});

test("has the spec'd volumes", () => {
  const seed = buildSeed();
  assert.equal(seed.candidates.length, 400);
  assert.equal(seed.requirements.length, 19);
  assert.equal(seed.vendors.length, 25);
  assert.equal(seed.script.vendorReplies.length, 6);
  assert.equal(seed.counters.REQ, 1041);
  assert.equal(seed.requirements.at(-1)?.id, "REQ-1041");
});

for (const size of [{}, { candidates: 200, requirements: 7 }]) {
  const label = JSON.stringify(size);

  test(`hero pool is tuned ${label}`, () => {
    const ranked = heroRanking(buildSeed(size));
    const strong = ranked.filter((r) => r.score >= 80).length;
    assert.ok(strong >= 20 && strong <= 25, `strong matches: ${strong}`);
    assert.deepEqual(ranked.slice(0, 3).map((r) => r.name).sort(), ["Ana Souza", "Kiran Rao", "Marcus Lee"]);
    assert.ok(ranked[2]!.score - ranked[3]!.score >= 4, `gap ${ranked[2]!.score} vs ${ranked[3]!.score}`);
  });

  test(`stages 6–7 are seeded ${label}`, () => {
    const seed = buildSeed(size);
    const count = (stage: string) => seed.pipeline.filter((p) => p.stage === stage).length;
    assert.ok(count("interview") >= 2);
    assert.ok(count("offer") >= 1);
    assert.ok(count("onboarding") >= 2);
    assert.deepEqual(seed.onboarding.map((o) => o.path).sort(), ["C2C", "W2"]);
    assert.ok(seed.timesheets.length >= 2);
    const feedback = seed.script.morning.feedbackEmail;
    assert.equal(seed.pipeline.find((p) => p.candidateId === feedback.candidateId)?.stage, "interview");
    const offer = seed.script.morning.offerAcceptedEmail;
    assert.equal(seed.pipeline.find((p) => p.candidateId === offer.candidateId)?.stage, "offer");
  });
}

test("respects cut sizes", () => {
  const seed = buildSeed({ candidates: 200, requirements: 7 });
  assert.equal(seed.candidates.length, 200);
  assert.equal(seed.requirements.length, 7);
  assert.equal(seed.requirements[0]?.id, "REQ-1035");
});

test("all contacts are fictional", () => {
  const seed = buildSeed();
  const fictional = /@([a-z0-9-]+\.)*example\.com$/;
  const consultants = seed.script.vendorReplies.flatMap((r) => r.consultants);
  for (const c of [...seed.candidates, ...consultants]) {
    assert.match(c.email, fictional, c.email);
    assert.ok(c.linkedin.startsWith("https://linkedin.example.com/in/"), c.linkedin);
    assert.match(c.phone, /^\(\d{3}\) 555-01\d{2}$/, c.phone);
  }
  for (const v of seed.vendors) assert.match(v.email, fictional, v.email);
  for (const r of seed.requirements) assert.match(r.clientContact, fictional, r.clientContact);
  const script = [seed.script.heroClientEmail, seed.script.morning.feedbackEmail, seed.script.morning.offerAcceptedEmail];
  for (const e of script) for (const a of [e.from, ...e.to]) assert.match(addressOf(a), fictional, a);
});

test("ids are unique and counters sit past them", () => {
  const seed = buildSeed();
  const consultants = seed.script.vendorReplies.flatMap((r) => r.consultants);
  const ids = [...seed.candidates, ...consultants].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const maxCan = Math.max(...ids.map((id) => Number(id.slice(4))));
  assert.ok(seed.counters.CAN! >= maxCan);
  const names = seed.candidates.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("top 3 profiles match the spec", () => {
  const seed = buildSeed();
  const byName = (n: string) => seed.candidates.find((c) => c.name === n)!;
  const kiran = byName("Kiran Rao");
  assert.equal(kiran.workAuth, "H-1B");
  assert.equal(kiran.contactPreference, "phone");
  assert.equal(kiran.screenAnswers, undefined);
  assert.equal(byName("Ana Souza").workAuth, "H-4 EAD");
  assert.equal(byName("Marcus Lee").workAuth, "USC");
  assert.ok(byName("Ana Souza").screenAnswers && byName("Marcus Lee").screenAnswers);
  for (const doc of [...kiran.workAuthDocs, ...byName("Ana Souza").workAuthDocs]) assert.match(doc.name, /SAMPLE/);
});

test("vendor consultants never beat the top 3", () => {
  const seed = buildSeed();
  const third = heroRanking(seed)[2]!.score;
  for (const reply of seed.script.vendorReplies) {
    assert.ok(reply.consultants.length >= 1 && reply.consultants.length <= 3);
    for (const c of reply.consultants) {
      const s = keywordScore(c, HERO_REQUIREMENT);
      assert.ok(s >= 55 && s <= 85 && s < third, `${c.name} ${s}`);
      assert.equal(c.vendorId, reply.vendorId);
    }
  }
});
