import test from "node:test";
import assert from "node:assert/strict";
import {
  filterEligibleAccounts,
  scoreAccount,
  rankCandidateAccounts
} from "../src/service.mjs";

test("filterEligibleAccounts filters out accounts failing hard checks", () => {
  const accounts = [
    {
      id: "acc-1",
      email: "valid@example.com",
      disabled: false,
      proxy_disabled: false,
      validation_blocked: false,
      token: { refresh_token: "1//valid-token" },
      quota: { is_forbidden: false, subscription_tier: "PRO" }
    },
    {
      id: "acc-disabled",
      email: "dis@example.com",
      disabled: true,
      proxy_disabled: false,
      token: { refresh_token: "1//token" }
    },
    {
      id: "acc-proxy-disabled",
      email: "proxy-dis@example.com",
      disabled: false,
      proxy_disabled: true,
      token: { refresh_token: "1//token" }
    },
    {
      id: "acc-validation-blocked",
      email: "val-block@example.com",
      disabled: false,
      proxy_disabled: false,
      validation_blocked: true,
      token: { refresh_token: "1//token" }
    },
    {
      id: "acc-forbidden",
      email: "forbid@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "1//token" },
      quota: { is_forbidden: true }
    },
    {
      id: "acc-no-token",
      email: "no-token@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "" }
    }
  ];

  const eligible = filterEligibleAccounts(accounts);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, "acc-1");
});

test("scoreAccount awards 1000 base for PRO and averages core coding models", () => {
  const proAccount = {
    id: "pro-1",
    quota: {
      subscription_tier: "PRO",
      models: [
        { name: "gemini-3.8-flash-high", percentage: 80 },
        { name: "gemini-4-neon-high", percentage: 60 },
        { name: "claude-sonnet-5-5-high", percentage: 70 },
        { name: "claude-opus-5-5-high", percentage: 50 }
      ]
    }
  };

  const freeAccount = {
    id: "free-1",
    quota: {
      subscription_tier: "FREE",
      models: [
        { name: "gemini-3.8-flash-high", percentage: 80 },
        { name: "gemini-4-neon-high", percentage: 60 },
        { name: "claude-sonnet-5-5-high", percentage: 70 },
        { name: "claude-opus-5-5-high", percentage: 50 }
      ]
    }
  };

  const proScore = scoreAccount(proAccount);
  const freeScore = scoreAccount(freeAccount);

  // Mean = (80 + 60 + 70 + 50) / 4 = 65
  assert.equal(proScore, 1065);
  assert.equal(freeScore, 65);
});

test("scoreAccount applies -200 penalty when all models are 0%", () => {
  const exhaustedAccount = {
    id: "exhausted",
    quota: {
      subscription_tier: "PRO",
      models: [
        { name: "gemini-3.8-flash-high", percentage: 0 },
        { name: "claude-sonnet-5-5-high", percentage: 0 }
      ]
    }
  };

  const score = scoreAccount(exhaustedAccount);
  // Base 1000 + Mean 0 - Penalty 200 = 800
  assert.equal(score, 800);
});

test("rankCandidateAccounts orders by PRO tier first, then highest quota score", () => {
  const accounts = [
    {
      id: "free-high-quota",
      email: "free@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "token1" },
      quota: { subscription_tier: "FREE", models: [{ name: "gemini-3.8-flash-high", percentage: 100 }] }
    },
    {
      id: "pro-low-quota",
      email: "pro-low@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "token2" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 20 }] }
    },
    {
      id: "pro-high-quota",
      email: "pro-high@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "token3" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 90 }] }
    }
  ];

  const ranked = rankCandidateAccounts(accounts);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].id, "pro-high-quota");
  assert.equal(ranked[1].id, "pro-low-quota");
  assert.equal(ranked[2].id, "free-high-quota");
});
