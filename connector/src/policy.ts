// The server owner's own rules for what MausBot may do here: /etc/mausbot/policy.json on the host, root's, which the
// connector reads (mounted read-only) before each job MausBot sends and never writes. Jobs root runs on the server
// itself are the owner's own and are not limited by it.
//
//   { "jobs": ["status", "host-health", "update", "backup"], "updates": "hold" }
//
// `jobs`: the only kinds MausBot may run here (absent: all of them). `updates: "hold"`: MausBot's home updates wait.
// A self-update of the connector is always accepted, so a held or locked-down server never strands an old connector.
import { readFileSync } from "node:fs";

import { JOB_TYPES, type Job, type JobType } from "./protocol.ts";

export const POLICY_FILE = "policy.json";

export interface Policy {
  jobs: JobType[] | null;
  updates: "automatic" | "hold";
}

const READS: ReadonlySet<JobType> = new Set(["status", "host-health"]);

/** The policy in `text` (null: no file, every job allowed), or why it cannot be used. */
export function parsePolicy(text: string | null): { ok: true; policy: Policy } | { ok: false; problem: string } {
  if (text === null) return { ok: true, policy: { jobs: null, updates: "automatic" } };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, problem: "it is not JSON" }; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problem: "it is not a JSON object" };
  const { jobs, updates, ...rest } = raw as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) return { ok: false, problem: `it has a setting this connector does not know: ${unknown[0]}` };
  if (jobs !== undefined && (!Array.isArray(jobs) || jobs.some((type) => !(JOB_TYPES as readonly unknown[]).includes(type)))) {
    return { ok: false, problem: `"jobs" must list job kinds from: ${JOB_TYPES.join(", ")}` };
  }
  if (updates !== undefined && updates !== "automatic" && updates !== "hold") return { ok: false, problem: '"updates" must be "automatic" or "hold"' };
  return { ok: true, policy: { jobs: (jobs as JobType[] | undefined) ?? null, updates: (updates as Policy["updates"] | undefined) ?? "automatic" } };
}

export function readPolicy(file: string): ReturnType<typeof parsePolicy> {
  let text: string | null;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, problem: `it cannot be read (${(error as NodeJS.ErrnoException).code})` };
    text = null;
  }
  return parsePolicy(text);
}

/** Why the server's policy refuses `job` from MausBot, or null. A self-update is never refused. */
export function policyRefusal(job: Job, read: ReturnType<typeof parsePolicy>, file: string): string | null {
  if (job.type === "self-update") return null;
  if (!read.ok) return READS.has(job.type) ? null : `This server's policy ${file} cannot be used (${read.problem}), so MausBot changes nothing here until it is fixed.`;
  if (read.policy.jobs && !read.policy.jobs.includes(job.type)) return `This server's policy ${file} does not let MausBot run ${job.type} jobs.`;
  if (job.type === "update" && read.policy.updates === "hold") return `This server's policy ${file} holds updates.`;
  return null;
}
