import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { redactSecrets } from "./config.mjs";

export function readJsonSafe(filePath, retries = 2, delayMs = 100) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      if (!raw || raw.trim().length === 0) {
        if (attempt < retries) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
          continue;
        }
        return null;
      }
      return JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError && attempt < retries) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * (attempt + 1));
        continue;
      }
      if (attempt >= retries) throw err;
    }
  }
  return null;
}

export function pruneBackups(dir, baseName, maxBackups = 5, maxAgeDays = 7) {
  if (!fs.existsSync(dir)) return 0;
  const prefix = `${baseName}.bak.`;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix))
    .map(f => {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      return { file: f, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  let pruned = 0;
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    const isOverCount = i >= maxBackups;
    const isOverAge = (now - item.mtimeMs) > maxAgeMs;
    if (isOverCount || isOverAge) {
      try {
        fs.unlinkSync(item.fullPath);
        pruned++;
      } catch {}
    }
  }
  return pruned;
}

export function createBackup(targetPath, maxBackups = 5) {
  if (!fs.existsSync(targetPath)) return null;
  const dir = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const ts = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "");
  const backupPath = path.join(dir, `${baseName}.bak.${ts}`);

  fs.copyFileSync(targetPath, backupPath);
  pruneBackups(dir, baseName, maxBackups);
  return backupPath;
}

export async function atomicWriteJson(targetPath, data, mode = 0o600) {
  const content = JSON.stringify(data, null, 2);
  const targetDir = path.dirname(targetPath);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Check if content is already identical
  if (fs.existsSync(targetPath)) {
    try {
      const currentRaw = fs.readFileSync(targetPath, "utf8");
      const currentJson = JSON.parse(currentRaw);
      const currentNormalized = JSON.stringify(currentJson, null, 2);
      if (currentNormalized === content) {
        return { written: false, skipped: true };
      }
    } catch {}
    // Create backup before modifying
    createBackup(targetPath);
  }

  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  const fileHandle = await fsp.open(tmpPath, "w", mode);
  try {
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.sync(); // fsync
  } finally {
    await fileHandle.close();
  }

  // Rename with Windows NTFS transient retries
  const retryDelays = [150, 350, 700];
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await fsp.rename(tmpPath, targetPath);
      return { written: true, skipped: false, targetPath };
    } catch (err) {
      lastErr = err;
      if (["EBUSY", "EPERM", "EACCES"].includes(err.code) && attempt < retryDelays.length) {
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      break;
    }
  }

  // If rename failed, cleanup tmpPath
  try { await fsp.unlink(tmpPath); } catch {}
  throw lastErr;
}

export function isProcessAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // EPERM means alive but no permission
  }
}

export function acquireLock(lockPath) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(lockPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (existing.pid === process.pid) {
        return { acquired: false, isCurrentProcess: true, pid: existing.pid };
      }
      if (isProcessAlive(existing.pid)) {
        return { acquired: false, isCurrentProcess: false, pid: existing.pid };
      }
      // Dead process lock, remove it
      fs.unlinkSync(lockPath);
    } catch {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: "1.0.0",
    scriptPath: process.argv[1] || ""
  }, null, 2);

  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    return { acquired: true, pid: process.pid };
  } catch (err) {
    if (err.code === "EEXIST") {
      return { acquired: false, isCurrentProcess: false };
    }
    throw err;
  }
}

export function releaseLock(lockPath) {
  if (!fs.existsSync(lockPath)) return true;
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw);
    if (data.pid === process.pid) {
      fs.unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function discoverInstances(ombDataDir) {
  const configPath = path.join(ombDataDir, "config.json");
  const cfg = readJsonSafe(configPath);
  if (!cfg || !cfg.instances) return [];

  const list = [];
  for (const [instanceId, entry] of Object.entries(cfg.instances)) {
    if (entry?.driver === "antigravityAgent" && entry?.enabled !== false) {
      const hash = crypto.createHash("sha256").update(instanceId).digest("hex");
      const tokenPath = path.join(ombDataDir, "providers", "antigravity", hash, "antigravity-acp", "acp_token.json");
      const currentToken = readJsonSafe(tokenPath);
      list.push({
        instanceId,
        profileHash: hash,
        tokenPath,
        currentToken,
        entry
      });
    }
  }
  return list;
}

export async function checkBotQuiescence(instanceId, timeoutMs = 15000, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch("http://127.0.0.1:8799/api/bots", { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        return true; // Graceful degradation
      }

      const data = await res.json();
      const bots = Array.isArray(data) ? data : data.bots || [];
      const boundBots = bots.filter(b => b.modelSelection?.instanceId === instanceId);
      const isAnyBusy = boundBots.some(b => b.busy === true);

      if (!isAnyBusy) {
        return true;
      }
      await new Promise(r => setTimeout(r, pollMs));
    } catch {
      // 8799 offline or unreachable, allow graceful proceed
      return true;
    }
  }
  return false; // Timed out waiting for quiescence
}

export function appendLog(logPath, event) {
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Rotate if >= 5 MiB
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size >= 5 * 1024 * 1024) {
        const p1 = `${logPath}.1`;
        const p2 = `${logPath}.2`;
        const p3 = `${logPath}.3`;
        try { if (fs.existsSync(p2)) fs.renameSync(p2, p3); } catch {}
        try { if (fs.existsSync(p1)) fs.renameSync(p1, p2); } catch {}
        try { fs.renameSync(logPath, p1); } catch {}
      }
    }

    const record = {
      ts: new Date().toISOString(),
      ...event
    };
    const line = redactSecrets(JSON.stringify(record)) + "\n";
    fs.appendFileSync(logPath, line, "utf8");
  } catch {}
}
