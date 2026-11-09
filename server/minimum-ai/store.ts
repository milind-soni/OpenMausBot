import { closeSync, openSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "../atomic.ts";
import { approveWorkflow, proposeWorkflow, verifyWorkflow, type WorkflowProposal } from "./approval.ts";
import { parseWorkflow, type ToolInvoker, type WorkflowResult } from "./workflow.ts";
import { assertWorkflowBinding, bindWorkflow, workflowSchemaDigest, type WorkflowBindingInput } from "./binding.ts";
import { processAlive } from "./process-alive.ts";
import type { WorkflowToolDescriptor } from "./planning.ts";
import { browserWorkflowCatalog, browserWorkflowFromRecording } from "./browser-workflow.ts";
import type { RecordedBrowserStep } from "./browser-replay.ts";

type RecordEntry = WorkflowProposal & { owner: string; binding: string; revision: string; catalog: readonly WorkflowToolDescriptor[] };
type FileData = { version: 1; plans: Record<string, RecordEntry> };
const BUSY = "This workflow is already running or being tested";

export function createWorkflowStore(file: string) {
  const lockFile = `${file}.locks.sqlite`;
  try { closeSync(openSync(lockFile, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const transaction = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(lockFile);
    try {
      db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS interruptions (id TEXT PRIMARY KEY) STRICT; BEGIN IMMEDIATE");
      try { const result = run(db); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  };
  const load = (): FileData => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || (parsed as FileData).version !== 1 || !(parsed as FileData).plans || typeof (parsed as FileData).plans !== "object" || Array.isArray((parsed as FileData).plans)) throw new Error("Invalid workflow store");
      return parsed as FileData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, plans: Object.create(null) };
      throw error;
    }
  };
  const readFrom = (data: FileData, id: string, owner: string): RecordEntry | null => {
    if (!id || !owner || ["__proto__", "prototype", "constructor"].includes(id)) throw new Error("Invalid workflow identity");
    if (!Object.hasOwn(data.plans, id)) return null;
    const entry = data.plans[id]!;
    if (!entry || entry.owner !== owner) throw new Error("Workflow is not owned by this user");
    return { ...entry, plan: parseWorkflow(entry.plan) };
  };
  const read = (id: string, owner: string) => readFrom(load(), id, owner);
  const leaseIn = (db: DatabaseSync, id: string): { token: string; pid: number } | undefined => {
    const lease = db.prepare("SELECT token, pid FROM leases WHERE id = ?").get(id) as { token: string; pid: number } | undefined;
    if (lease && !processAlive(lease.pid)) { db.prepare("DELETE FROM leases WHERE id = ? AND token = ?").run(id, lease.token); db.prepare("INSERT OR IGNORE INTO interruptions (id) VALUES (?)").run(id); return undefined; }
    return lease;
  };
  const busy = (id: string) => transaction((db) => Boolean(leaseIn(db, id)));
  const acquire = (id: string, owner: string, allowMissing = false): { token: string; release: () => void } => {
    const token = randomUUID();
    transaction((db) => {
      if (!readFrom(load(), id, owner) && !allowMissing) throw new Error("Workflow is unavailable");
      if (leaseIn(db, id)) throw new Error(BUSY);
      if (db.prepare("SELECT 1 FROM interruptions WHERE id = ?").get(id)) throw new Error("A previous run was interrupted; review its effects before allowing another run");
      db.prepare("INSERT INTO leases (id, token, pid) VALUES (?, ?, ?)").run(id, token, process.pid);
    });
    return { token, release: () => { transaction((db) => { db.prepare("DELETE FROM leases WHERE id = ? AND token = ?").run(id, token); }); } };
  };
  const save = (id: string, entry: RecordEntry, options: { expectedRevision?: string; leaseToken?: string } = {}) => transaction((db) => {
    const data = load();
    const current = readFrom(data, id, entry.owner);
    if (options.expectedRevision !== undefined && current?.revision !== options.expectedRevision) throw new Error("Workflow changed during testing");
    const lease = leaseIn(db, id);
    if (lease && lease.token !== options.leaseToken) throw new Error(BUSY);
    if (options.leaseToken && lease?.token !== options.leaseToken) throw new Error("The workflow test is no longer active");
    writeFileAtomic(file, `${JSON.stringify({ version: 1, plans: { ...data.plans, [id]: entry } })}\n`, { mode: 0o600 });
  });
  return {
    acquireRecording(id: string, owner: string) { return acquire(id, owner, true); },
    get(id: string, owner: string, context: WorkflowBindingInput): WorkflowProposal | null {
      const entry = read(id, owner);
      if (!entry) return null;
      if (busy(id)) throw new Error(BUSY);
      if (context.owner !== owner) throw new Error("Workflow owner changed");
      assertWorkflowBinding(entry.binding, context);
      return { plan: entry.plan, verified: entry.verified, approved: entry.approved, fingerprint: entry.fingerprint };
    },
    catalog(id: string, owner: string): readonly WorkflowToolDescriptor[] {
      const entry = read(id, owner);
      if (!entry || !Array.isArray(entry.catalog)) throw new Error("Workflow tool schemas are unavailable");
      return structuredClone(entry.catalog);
    },
    held(id: string): boolean {
      return transaction((db) => { leaseIn(db, id); return Boolean(db.prepare("SELECT 1 FROM interruptions WHERE id = ?").get(id)); });
    },
    acknowledge(id: string, owner: string, allowMissing = false): void {
      transaction((db) => { if (!readFrom(load(), id, owner) && !allowMissing) throw new Error("Workflow is unavailable"); if (leaseIn(db, id)) throw new Error(BUSY); db.prepare("DELETE FROM interruptions WHERE id = ?").run(id); });
    },
    acquireRun(id: string, owner: string, context: WorkflowBindingInput) {
      const lease = acquire(id, owner);
      try {
        const entry = read(id, owner);
        if (!entry?.approved || !entry.verified) throw new Error("The workflow needs approval before it can run");
        if (context.owner !== owner) throw new Error("Workflow owner changed");
        assertWorkflowBinding(entry.binding, context);
        return { proposal: { plan: entry.plan, verified: entry.verified, approved: entry.approved, fingerprint: entry.fingerprint }, release: lease.release };
      } catch (error) { lease.release(); throw error; }
    },
    saveDraft(id: string, owner: string, context: WorkflowBindingInput, input: unknown, allowed: ReadonlySet<string>, paginatedTools: ReadonlySet<string> = new Set(), catalog: readonly WorkflowToolDescriptor[] = []): WorkflowProposal {
      if (context.owner !== owner) throw new Error("Workflow owner changed");
      if (catalog.length && context.schemaDigest !== workflowSchemaDigest(catalog)) throw new Error("Workflow tool schemas changed during setup");
      const proposal = proposeWorkflow(input, allowed, paginatedTools);
      save(id, { ...proposal, owner, binding: bindWorkflow(context), revision: randomUUID(), catalog: structuredClone(catalog) });
      return proposal;
    },
    /** Only an internally validated, completed first run may use this; no actions are repeated while saving. */
    saveRecordedBrowserDraft(id: string, owner: string, context: WorkflowBindingInput, steps: readonly RecordedBrowserStep[], leaseToken?: string, learned?: unknown): WorkflowProposal {
      if (context.owner !== owner || context.schemaDigest !== workflowSchemaDigest(browserWorkflowCatalog)) throw new Error("Workflow owner or browser tools changed");
      const fixed = browserWorkflowFromRecording(steps);
      const plan = learned ?? fixed;
      const proposal = { ...proposeWorkflow(plan, new Set(browserWorkflowCatalog.map((tool) => tool.name))), verified: true };
      save(id, { ...proposal, owner, binding: bindWorkflow(context), revision: randomUUID(), catalog: structuredClone(browserWorkflowCatalog) }, { leaseToken });
      return proposal;
    },
    async verify(id: string, owner: string, context: WorkflowBindingInput, expectedFingerprint: string, allowed: ReadonlySet<string>, invoke: ToolInvoker, paginatedTools: ReadonlySet<string> = new Set(), signal?: AbortSignal, hooks?: { before?: () => void; after?: (result: WorkflowResult) => void; error?: () => void }) {
      const lease = acquire(id, owner);
      try {
        hooks?.before?.();
        const entry = read(id, owner);
        if (!entry || entry.fingerprint !== expectedFingerprint) throw new Error("Workflow changed before testing");
        if (context.owner !== owner) throw new Error("Workflow owner changed");
        assertWorkflowBinding(entry.binding, context);
        const tested = await verifyWorkflow(entry, allowed, invoke, paginatedTools, signal);
        hooks?.after?.(tested.result);
        save(id, { ...tested.proposal, owner, binding: entry.binding, revision: entry.revision, catalog: entry.catalog }, { expectedRevision: entry.revision, leaseToken: lease.token });
        return tested.result;
      } catch (error) { hooks?.error?.(); throw error; }
      finally { lease.release(); }
    },
    approve(id: string, owner: string, context: WorkflowBindingInput, expectedFingerprint: string): WorkflowProposal {
      const entry = read(id, owner);
      if (!entry || entry.fingerprint !== expectedFingerprint) throw new Error("Workflow changed before approval");
      if (context.owner !== owner) throw new Error("Workflow owner changed");
      assertWorkflowBinding(entry.binding, context);
      const approved = approveWorkflow(entry);
      save(id, { ...approved, owner, binding: entry.binding, revision: entry.revision, catalog: entry.catalog }, { expectedRevision: entry.revision });
      return approved;
    },
  };
}
