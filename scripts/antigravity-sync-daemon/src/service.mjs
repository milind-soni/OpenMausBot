import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CORE_CODING_MODELS, TIMERS } from "./types.mjs";
import { readJsonSafe } from "./repo.mjs";

export function loadAccounts(toolsDir) {
  const indexFile = path.join(toolsDir, "accounts.json");
  const indexData = readJsonSafe(indexFile);
  if (!indexData) return { currentAccountId: null, accounts: [] };

  const currentAccountId = indexData.current_account_id || indexData.current_agy_account_id || null;
  const accountsMap = new Map();

  const detailDir = path.join(toolsDir, "accounts");
  if (fs.existsSync(detailDir)) {
    const files = fs.readdirSync(detailDir);
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      const detail = readJsonSafe(path.join(detailDir, f));
      if (detail && detail.id) {
        accountsMap.set(detail.id, detail);
      }
    }
  }

  // Merge with index accounts if detail not on disk
  if (Array.isArray(indexData.accounts)) {
    for (const acc of indexData.accounts) {
      if (!accountsMap.has(acc.id)) {
        accountsMap.set(acc.id, acc);
      }
    }
  }

  return {
    currentAccountId,
    currentTargetIde: indexData.current_target_ide || null,
    accounts: Array.from(accountsMap.values())
  };
}

export function filterEligibleAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  return accounts.filter(acc => {
    if (!acc) return false;
    if (acc.disabled === true) return false;
    if (acc.proxy_disabled === true) return false;
    if (acc.validation_blocked === true) return false;
    if (acc.quota && acc.quota.is_forbidden === true) return false;
    const rt = acc.token?.refresh_token;
    if (typeof rt !== "string" || rt.trim().length === 0) return false;
    return true;
  });
}

export function scoreAccount(account) {
  if (!account) return -9999;
  let score = 0;

  // Tier base
  const tier = account.quota?.subscription_tier?.toUpperCase();
  if (tier === "PRO") {
    score += 1000;
  }

  // Quota calculation
  const models = account.quota?.models;
  if (Array.isArray(models) && models.length > 0) {
    const coreModels = models.filter(m => CORE_CODING_MODELS.includes(m.name));
    const targetSet = coreModels.length > 0 ? coreModels : models;

    let sum = 0;
    let allZero = true;
    for (const m of targetSet) {
      const p = typeof m.percentage === "number" ? m.percentage : 0;
      sum += p;
      if (p > 0) allZero = false;
    }
    const mean = Math.round(sum / targetSet.length);
    score += mean;

    if (allZero) {
      score -= 200; // All zero penalty
    }
  }

  return score;
}

export function rankCandidateAccounts(accounts) {
  const eligible = filterEligibleAccounts(accounts);
  return eligible.sort((a, b) => scoreAccount(b) - scoreAccount(a));
}

export function isAccountHealthy(account) {
  if (!account) return false;
  if (account.disabled || account.proxy_disabled || account.validation_blocked || account.quota?.is_forbidden) {
    return false;
  }
  const models = account.quota?.models;
  if (Array.isArray(models) && models.length > 0) {
    const hasAnyQuota = models.some(m => (m.percentage || 0) > 0);
    if (!hasAnyQuota) return false;
  }
  return true;
}

export function planSync({
  currentAccountId,
  accounts,
  instances,
  syncPolicy = "primary-and-unhealthy",
  cooldownState = {}
}) {
  const decisions = [];
  const ranked = rankCandidateAccounts(accounts);
  if (ranked.length === 0) return decisions;

  const accountsByRt = new Map();
  const accountsById = new Map();
  for (const acc of accounts) {
    if (acc.id) accountsById.set(acc.id, acc);
    if (acc.token?.refresh_token) {
      const rtHash = crypto.createHash("sha256").update(acc.token.refresh_token).digest("hex");
      accountsByRt.set(rtHash, acc);
    }
  }

  // Track accounts assigned to healthy instances to preserve fleet diversity
  const assignedAccountIds = new Set();
  for (const inst of instances) {
    const rt = inst.currentToken?.refresh_token;
    if (rt) {
      const rtHash = crypto.createHash("sha256").update(rt).digest("hex");
      const matched = accountsByRt.get(rtHash);
      if (matched && isAccountHealthy(matched)) {
        assignedAccountIds.add(matched.id);
      }
    }
  }

  for (const inst of instances) {
    const isPrimary = inst.instanceId === "antigravity";
    const currentToken = inst.currentToken;

    let needsSync = false;
    let reason = null;
    let boundAccount = null;

    if (currentToken?.refresh_token) {
      const rtHash = crypto.createHash("sha256").update(currentToken.refresh_token).digest("hex");
      boundAccount = accountsByRt.get(rtHash) || null;
    }

    // T4: Corrupted, missing token or missing aicode scope
    if (!currentToken || !currentToken.refresh_token) {
      needsSync = true;
      reason = "T4_TOKEN_REPAIR";
    } else if (Array.isArray(currentToken.scopes) && !currentToken.scopes.includes("https://www.googleapis.com/auth/aicode")) {
      needsSync = true;
      reason = "T4_TOKEN_REPAIR";
    }

    // T2: Account disabled or forbidden
    if (!needsSync && boundAccount) {
      if (boundAccount.disabled || boundAccount.proxy_disabled || boundAccount.validation_blocked || boundAccount.quota?.is_forbidden) {
        needsSync = true;
        reason = "T2_UNHEALTHY";
      }
    }

    // T1: Quota exhausted (all models 0%)
    if (!needsSync && boundAccount?.quota?.models) {
      const allZero = boundAccount.quota.models.every(m => (m.percentage || 0) <= 0);
      if (allZero) {
        needsSync = true;
        reason = "T1_QUOTA_ZERO";
      }
    }

    // T3: Manual switch on primary instance
    if (!needsSync && isPrimary && currentAccountId) {
      const targetAcc = accountsById.get(currentAccountId);
      if (targetAcc && targetAcc.token?.refresh_token) {
        if (!currentToken || currentToken.refresh_token !== targetAcc.token.refresh_token) {
          needsSync = true;
          reason = "T3_MANUAL_SWITCH";
        }
      }
    }

    if (needsSync) {
      let chosenAccount = null;

      // If T3 manual switch, strictly honor the requested target account
      if (reason === "T3_MANUAL_SWITCH" && currentAccountId) {
        chosenAccount = accountsById.get(currentAccountId) || null;
      }

      // Otherwise pick best ranked account preserving diversity
      if (!chosenAccount) {
        chosenAccount = ranked.find(acc => !assignedAccountIds.has(acc.id)) || ranked[0];
      }

      if (chosenAccount) {
        assignedAccountIds.add(chosenAccount.id);
        decisions.push({
          instanceId: inst.instanceId,
          tokenPath: inst.tokenPath,
          reason,
          fromAccountId: boundAccount ? boundAccount.id : null,
          toAccountId: chosenAccount.id,
          toEmail: chosenAccount.email,
          tier: chosenAccount.quota?.subscription_tier || "PRO",
          score: scoreAccount(chosenAccount),
          accountData: chosenAccount
        });
      }
    }
  }

  return decisions;
}

export function buildAcpTokenPayload(account, templateToken = null) {
  const clientId = templateToken?.client_id || process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || "1071006060485-sqfdk67ki6udhnvd5mqnl951knbts8ec.apps.googleusercontent.com";
  const clientSecret = templateToken?.client_secret || process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || "";
  const projectId = templateToken?.project_id || account?.token?.project_id || "aicode-consumers";

  return {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: account.token.refresh_token,
    token_uri: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/aicode"
    ],
    project_id: projectId
  };
}
