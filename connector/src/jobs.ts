// Each job type of the protocol, and nothing else: what runs for a job is fixed here, and its arguments were checked
// (protocol.ts checkJob) before it got here.
import { auditArgs, type AuditEvent, type AuditLog, type AuditSource } from "./audit.ts";
import { asJobError } from "./failure.ts";
import type { Home } from "./home.ts";
import { errorText, type Log } from "./log.ts";
import type { ConnectorIdentity, HostHealth, Job, JobArgs, JobReply, JobResults, JobType } from "./protocol.ts";

/** Jobs that change the home, its data or the connector; they wait for each other. */
const CHANGES: ReadonlySet<JobType> = new Set(["start", "stop", "restart", "update", "backup", "restore", "export-disk", "import-disk", "self-update"]);
const MAX_WAITING = 8;

export interface RunnerDeps {
  home: Home;
  hostHealth: () => Promise<HostHealth>;
  identity: () => ConnectorIdentity;
  admin: () => { origin: string; token: string };
  /** Null when the new connector took over and will answer this job itself. */
  selfUpdate: (job: Job<"self-update">) => Promise<JobReply | null>;
}

export function jobRunner(deps: RunnerDeps): (job: Job) => Promise<JobReply | null> {
  let waiting = 0;
  const run = async (job: Job): Promise<JobReply | null> => {
    const ok = <T extends JobType>(result: JobResults[T]): JobReply => ({ id: job.id, ok: true, result });
    try {
      switch (job.type) {
        case "start": {
          const { image, env } = job.args as JobArgs["start"];
          return ok(await deps.home.start(job.id, image, env));
        }
        case "stop":
          return ok(await deps.home.stop());
        case "restart":
          return ok(await deps.home.restart());
        case "update":
          return ok(await deps.home.update(job.id, (job.args as JobArgs["update"]).image));
        case "backup":
          return ok(await deps.home.backup(job.id));
        case "restore":
          return ok(await deps.home.restore(job.id, (job.args as JobArgs["restore"]).backupId));
        case "export-disk":
          return ok(await deps.home.exportDisk(job.id, deps.admin()));
        case "import-disk":
          return ok(await deps.home.importDisk(job.id, (job.args as JobArgs["import-disk"]).url, deps.admin()));
        case "status": {
          await deps.home.refreshHealth();
          const { backups, snapshot } = await deps.home.copies();
          return ok({ home: await deps.home.report(), connector: deps.identity(), backups, snapshot });
        }
        case "host-health":
          return ok({ host: await deps.hostHealth() });
        case "self-update":
          return await deps.selfUpdate(job as Job<"self-update">);
      }
    } catch (error) {
      return { id: job.id, ok: false, error: asJobError(error) };
    }
  };
  return async (job) => {
    if (!CHANGES.has(job.type)) return run(job);
    if (waiting >= MAX_WAITING) return { id: job.id, ok: false, error: { code: "busy", message: `${MAX_WAITING} jobs are already waiting on this server; send this one again later.` } };
    waiting += 1;
    try {
      return await run(job);
    } finally {
      waiting -= 1;
    }
  };
}

/** Jobs only read: they run even when the audit log cannot be written, and that is logged. */
const READS: ReadonlySet<JobType> = new Set(["status", "host-health"]);

export interface Desk {
  /**
   * Every job, from any channel, comes in here: recorded in the audit log, run, and its result recorded. A job that
   * would change something is refused when it cannot be recorded. Null: the new connector answers a self-update.
   */
  submit(job: Job, by: AuditSource): Promise<JobReply | null>;
}

export function jobDesk(deps: { run: (job: Job) => Promise<JobReply | null>; audit: AuditLog; log: Log }): Desk {
  const record = (event: AuditEvent): boolean => {
    try {
      deps.audit.append(event);
      return true;
    } catch (error) {
      deps.log(`could not write the audit log ${deps.audit.file}: ${errorText(error)}`);
      return false;
    }
  };
  return {
    async submit(job, by) {
      if (!record({ event: "job", by, id: job.id, type: job.type, args: auditArgs(job) }) && !READS.has(job.type)) {
        return { id: job.id, ok: false, error: { code: "audit_unavailable", message: `The audit log at ${deps.audit.file} cannot be written, so nothing was done. Run the install command again to repair it.` } };
      }
      const reply = await deps.run(job);
      if (reply) record(resultEvent(by, job.type, reply));
      return reply;
    },
  };
}

export function resultEvent(by: AuditSource, type: JobType, reply: JobReply): AuditEvent {
  return reply.ok ? { event: "result", by, id: reply.id, type, ok: true, detail: resultDetail(reply.result as Record<string, unknown>) } : { event: "result", by, id: reply.id, type, ok: false, error: reply.error };
}

/** The images and copies a result names: what the server's owner looks for afterwards. */
function resultDetail(result: Record<string, unknown>): Record<string, unknown> {
  const home = result.home as { state?: string; image?: string | null } | undefined;
  const detail: Record<string, unknown> = {};
  if (home) Object.assign(detail, { home: home.state, image: home.image ?? null });
  for (const key of ["previousImage", "backupId", "bytes", "sha256"]) if (result[key] !== undefined) detail[key] = result[key];
  const copy = (result.snapshot ?? result.backup) as { id?: string } | null | undefined;
  if (copy?.id) detail.copy = copy.id;
  const connector = result.connector as { version?: string; image?: string | null } | undefined;
  if (connector) Object.assign(detail, { connector: connector.version, connectorImage: connector.image ?? null });
  return detail;
}
