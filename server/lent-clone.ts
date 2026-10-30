// A lent folder that is a GitHub repository starts its copy here as a clone (docs/files.md, "Git repositories"): My
// Cloud fetches what GitHub has, with its own git sign-in for a private repository (whatever git on My Cloud already
// uses; a public one needs none), at the computer's commit. The desktop's next Files pass then sends only what differs on
// the computer: changes not pushed yet, and files git ignores, such as .env. A clone that can't sign in or fails leaves
// the copy to Files, as for any other folder. The person chooses nothing.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const lentGit = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).refine((repo) => !repo.split("/").some((part) => part === "." || part === "..")),
  // Never an option: git reads a leading "-" as one.
  branch: z.string().regex(/^[\w./-]{1,200}$/).refine((branch) => !branch.startsWith("-") && !branch.split("/").some((part) => part === "" || part === "." || part === "..")).nullable(),
  head: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/).nullable(),
}).strict();
export type LentGit = z.infer<typeof lentGit>;
type CloneRecord = { state: "cloning" | "cloned" | "failed"; at: number; repo: string };

const CLONE_MS = 10 * 60_000;
const RETRY_MS = 24 * 60 * 60_000;

/** git without a prompt: no terminal, no askpass, no credential dialog; only the sign-in My Cloud already has. */
export function runGit(args: string[], timeoutMs = CLONE_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    // The address is always https://github.com/<owner>/<name>.git (lentGit's repo), never one a computer sent.
    const child = spawn("git", ["-c", "credential.interactive=never", "-c", "core.hooksPath=/dev/null", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    });
    let error = "";
    child.stderr.on("data", (chunk) => { if (error.length < 4_000) error += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(error.trim().split("\n").at(-1) || `git exited ${code}`)); });
  });
}

export function createLentClones(options: {
  dataDir: string; now?: () => number; git?: (args: string[]) => Promise<void>;
  /** Where a repository is fetched from; tests point it at a local one. */
  url?: (repo: string) => string;
  /** The copy changed (cloned, or given back to Files): wake the desktop's long poll. */
  changed?: (syncId: string) => void;
}) {
  const now = options.now ?? Date.now;
  const git = options.git ?? ((args: string[]) => runGit(args));
  const url = options.url ?? ((repo: string) => `https://github.com/${repo}.git`);
  const dir = join(options.dataDir, "sync");
  const file = join(dir, "clones.json");
  const read = (): Record<string, CloneRecord> => { try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, CloneRecord>; } catch { return {}; } };
  const set = (syncId: string, record: CloneRecord) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileAtomic(file, JSON.stringify({ ...read(), [syncId]: record }), { mode: 0o600 }); };
  let chain: Promise<void> = Promise.resolve();
  const empty = (folder: string) => { try { return readdirSync(folder).length === 0; } catch { return false; } };

  async function clone(syncId: string, copy: string, wanted: LentGit): Promise<void> {
    const work = join(dir, "clones", syncId);
    try {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(join(dir, "clones"), { recursive: true, mode: 0o700 });
      // History without file contents; checking out the computer's commit fetches only what that commit holds.
      await git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--", url(wanted.repo), work]);
      // The computer's commit on its branch; one never pushed falls back to the branch as GitHub has it, and Files sends
      // the difference either way.
      const tries = [
        ...(wanted.head ? [wanted.branch ? ["-B", wanted.branch, wanted.head] : ["--detach", wanted.head]] : []),
        ...(wanted.branch ? [[wanted.branch]] : []),
        ["HEAD"],
      ];
      for (const [index, args] of tries.entries()) {
        try { await git(["-C", work, "checkout", "--quiet", ...args]); break; } catch (error) { if (index === tries.length - 1) throw error; }
      }
      // Files may have started meanwhile: a copy that is no longer empty is left to it.
      if (!empty(copy)) throw new Error("the copy filled while cloning");
      for (const name of readdirSync(work)) renameSync(join(work, name), join(copy, name));
      set(syncId, { state: "cloned", at: now(), repo: wanted.repo });
    } catch (error) {
      try { set(syncId, { state: "failed", at: now(), repo: wanted.repo }); } catch {}
      console.warn(`[files] cloning ${wanted.repo} for a lent folder: ${error instanceof Error ? error.message : String(error)}; Files copies it instead`);
    } finally {
      rmSync(work, { recursive: true, force: true });
      options.changed?.(syncId);
    }
  }

  // After a restart nothing is cloning: those copies go to Files.
  for (const [syncId, record] of Object.entries(read())) if (record.state === "cloning") set(syncId, { ...record, state: "failed", at: now() });

  return {
    /** A new, empty copy of a lent folder that is a GitHub repository: cloned in the background, one at a time. True while
     * it is (the desktop leaves that copy alone until then). A clone that failed is tried again a day later. */
    start(syncId: string, copy: string, git: unknown): boolean {
      const parsed = lentGit.safeParse(git);
      if (!parsed.success || !empty(copy)) return false;
      const known = read()[syncId];
      if (known && (known.state !== "failed" || known.at + RETRY_MS > now())) return known.state === "cloning";
      set(syncId, { state: "cloning", at: now(), repo: parsed.data.repo });
      // One clone that fails in any way never stops the next.
      chain = chain.then(() => clone(syncId, copy, parsed.data)).catch(() => {});
      return true;
    },
    cloning(syncId: string): boolean { return read()[syncId]?.state === "cloning"; },
    /** The repository a copy was cloned from, for bots. */
    repo(syncId: string): string | null { const known = read()[syncId]; return known?.state === "cloned" ? known.repo : null; },
    idle: () => chain,
  };
}

export type LentClones = ReturnType<typeof createLentClones>;
