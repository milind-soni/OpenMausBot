// Each job type of the protocol, and nothing else: what runs for a job is fixed here, and its arguments were checked
// (protocol.ts checkJob) before it got here.
import { asJobError } from "./failure.ts";
import type { Home } from "./home.ts";
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
