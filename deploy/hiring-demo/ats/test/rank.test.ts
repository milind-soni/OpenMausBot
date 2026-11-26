import { test } from "node:test";
import assert from "node:assert/strict";

import { keywordScore, matchesQuery } from "../src/rank.ts";
import type { Candidate, Requirement } from "../src/types.ts";

function candidate(over: Partial<Candidate>): Candidate {
  return {
    id: "CAN-0001", name: "Test Person", email: "t@example.com", phone: "(555) 010-0000", linkedin: "https://linkedin.example.com/in/t",
    title: "Software Engineer", location: "Dallas, TX", relocate: false, workAuth: "USC", years: 10, skills: [], rateExpectation: 60,
    noticeWeeks: 2, availability: "2 weeks", education: "BS CS", resume: "", source: "dice", contactPreference: "text", workAuthDocs: [],
    ...over,
  };
}

const heroReq: Pick<Requirement, "skills" | "minYears" | "location" | "workMode" | "rate"> = {
  skills: ["Spring Boot", "AWS", "Kafka"], minYears: 8, location: "Dallas, TX", workMode: "hybrid", rate: 68,
};

test("phrase and AND", () => {
  const both = candidate({ resume: "Built Spring Boot services on Kafka." });
  const kafkaOnly = candidate({ resume: "Kafka streams, Spring framework, boot loaders." });
  assert.equal(matchesQuery('"spring boot" AND kafka', both), true);
  assert.equal(matchesQuery('"spring boot" AND kafka', kafkaOnly), false);
});

test("OR and NOT with parentheses", () => {
  const kotlinSenior = candidate({ skills: ["Kotlin"], title: "Senior Engineer" });
  const javaIntern = candidate({ skills: ["Java"], title: "Intern" });
  const python = candidate({ skills: ["Python"] });
  const q = "(java OR kotlin) NOT intern";
  assert.equal(matchesQuery(q, kotlinSenior), true);
  assert.equal(matchesQuery(q, javaIntern), false);
  assert.equal(matchesQuery(q, python), false);
});

test("adjacent terms are AND", () => {
  const both = candidate({ skills: ["Java", "AWS"] });
  const javaOnly = candidate({ skills: ["Java"] });
  assert.equal(matchesQuery("java aws", both), matchesQuery("java AND aws", both));
  assert.equal(matchesQuery("java aws", javaOnly), false);
});

test("terms match whole words only", () => {
  const js = candidate({ skills: ["JavaScript"] });
  assert.equal(matchesQuery("java", js), false);
});

test("empty query matches everything", () => {
  assert.equal(matchesQuery("  ", candidate({})), true);
});

test("malformed query throws", () => {
  assert.throws(() => matchesQuery("(java AND aws", candidate({})), /Bad Boolean query/);
  assert.throws(() => matchesQuery('"spring boot', candidate({})), /Bad Boolean query/);
});

test("keywordScore ranks a perfect match at 100", () => {
  const c = candidate({ skills: ["Spring Boot", "AWS", "Kafka"], years: 10, location: "Dallas, TX", rateExpectation: 66 });
  assert.equal(keywordScore(c, heroReq), 100);
});

test("keywordScore penalises missing skills and years", () => {
  const c = candidate({ skills: ["AWS"], years: 4, location: "Seattle, WA", relocate: false, rateExpectation: 80 });
  assert.equal(keywordScore(c, heroReq), 20 + 10 + 0 + 0);
});

test("keywordScore finds skills in the resume and gives half location credit in the same state", () => {
  const c = candidate({ skills: [], resume: "Spring Boot microservices on AWS with Kafka", years: 8, location: "Irving, TX", rateExpectation: 73 });
  assert.equal(keywordScore(c, heroReq), 60 + 20 + 5 + 5);
});
