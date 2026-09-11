import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Role = "admin" | "member";
export interface Workspace {
  slug: string; name: string; host: string; status: string; createdAt: number; error: string | null;
}
export interface Invitation {
  id: string; workspace: string; email: string; role: Role; status: string; expiresAt: number; createdAt: number;
}
export interface Member { workspace: string; email: string; role: Role }
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const digest = (value: string) => createHash("sha256").update(value).digest("base64url");

/** Portal metadata only. Never open a tenant's chat database from this process. */
export class PortalStore {
  readonly db: DatabaseSync;
  readonly now: () => number;
  constructor(db: DatabaseSync, now = Date.now) {
    this.db = db; this.now = now;
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS portal_workspace (
        slug TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, createdAt INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS portal_member (
        workspace TEXT NOT NULL REFERENCES portal_workspace(slug), email TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')), PRIMARY KEY(workspace,email)
      );
      CREATE TABLE IF NOT EXISTS portal_invitation (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES portal_workspace(slug),
        email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')),
        status TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS portal_pending_invite
        ON portal_invitation(workspace,email) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS portal_audit (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, workspace TEXT, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portal_handoff (
        hash TEXT PRIMARY KEY, workspace TEXT NOT NULL, email TEXT NOT NULL,
        challenge TEXT NOT NULL, expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portal_grant (
        hash TEXT PRIMARY KEY, workspace TEXT NOT NULL, email TEXT NOT NULL, expiresAt INTEGER NOT NULL
      );
    `);
    // A restart never presents an unfinished create as Ready or retries a root action blindly.
    db.prepare("UPDATE portal_workspace SET status = 'error', error = ? WHERE status = 'provisioning'")
      .run("Provisioning was interrupted. Check the fleet before retrying or deleting anything.");
  }

  workspace(slug: string): Workspace | undefined {
    return this.db.prepare("SELECT * FROM portal_workspace WHERE slug = ?").get(slug) as unknown as Workspace | undefined;
  }
  workspaces(): Workspace[] {
    return this.db.prepare("SELECT * FROM portal_workspace ORDER BY createdAt DESC").all() as unknown as Workspace[];
  }
  member(workspace: string, email: string): Member | undefined {
    return this.db.prepare("SELECT * FROM portal_member WHERE workspace = ? AND email = ?")
      .get(workspace, normalizeEmail(email)) as unknown as Member | undefined;
  }
  people(workspace: string) {
    return {
      members: this.db.prepare("SELECT * FROM portal_member WHERE workspace = ? ORDER BY email").all(workspace) as unknown as Member[],
      invitations: this.db.prepare("SELECT * FROM portal_invitation WHERE workspace = ? ORDER BY createdAt DESC LIMIT 100").all(workspace) as unknown as Invitation[],
    };
  }
  invitation(id: string): Invitation | undefined {
    return this.db.prepare("SELECT * FROM portal_invitation WHERE id = ?").get(id) as unknown as Invitation | undefined;
  }
  invited(email: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM portal_member WHERE email = ? UNION SELECT 1 FROM portal_invitation WHERE email = ? AND status = 'pending' AND expiresAt > ? LIMIT 1")
      .get(normalizeEmail(email), normalizeEmail(email), this.now()));
  }
  invite(workspace: string, email: string, role: Role): Invitation {
    email = normalizeEmail(email);
    this.db.prepare("UPDATE portal_invitation SET status = 'revoked' WHERE workspace = ? AND email = ? AND status = 'pending'").run(workspace, email);
    const invitation: Invitation = { id: randomUUID(), workspace, email, role, status: "pending", expiresAt: this.now() + 7 * 86400_000, createdAt: this.now() };
    this.db.prepare("INSERT INTO portal_invitation VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(invitation.id, workspace, email, role, invitation.status, invitation.expiresAt, invitation.createdAt);
    return invitation;
  }
  accept(invitation: Invitation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO portal_member VALUES (?, ?, ?) ON CONFLICT(workspace,email) DO UPDATE SET role = excluded.role")
        .run(invitation.workspace, invitation.email, invitation.role);
      this.db.prepare("UPDATE portal_invitation SET status = 'accepted' WHERE id = ?").run(invitation.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  audit(actor: string, action: string, workspace?: string, detail = "") {
    this.db.prepare("INSERT INTO portal_audit(at,actor,action,workspace,detail) VALUES (?,?,?,?,?)")
      .run(this.now(), actor, action, workspace ?? null, detail);
  }
  activity() { return this.db.prepare("SELECT * FROM portal_audit ORDER BY id DESC LIMIT 100").all(); }

  handoff(workspace: string, email: string, challenge: string): string {
    this.db.prepare("DELETE FROM portal_handoff WHERE expiresAt <= ?").run(this.now());
    const code = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO portal_handoff VALUES (?,?,?,?,?)")
      .run(digest(code), workspace, email, challenge, this.now() + 60_000);
    return code;
  }
  consume(code: string, workspace: string, verifier: string): { grant: string; email: string; role: Role } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM portal_handoff WHERE hash = ? AND workspace = ? AND challenge = ? AND expiresAt > ?")
        .get(digest(code), workspace, digest(verifier), this.now()) as { email: string } | undefined;
      const member = row && this.member(workspace, row.email);
      if (!member || this.workspace(workspace)?.status !== "running") { this.db.exec("ROLLBACK"); return null; }
      this.db.prepare("DELETE FROM portal_handoff WHERE hash = ?").run(digest(code));
      const grant = randomBytes(32).toString("base64url");
      this.db.prepare("DELETE FROM portal_grant WHERE expiresAt <= ?").run(this.now());
      this.db.prepare("INSERT INTO portal_grant VALUES (?,?,?,?)").run(digest(grant), workspace, member.email, this.now() + 7 * 86400_000);
      this.db.exec("COMMIT");
      return { grant, email: member.email, role: member.role };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  grant(grant: string, workspace: string): Member | null {
    const row = this.db.prepare("SELECT email FROM portal_grant WHERE hash = ? AND workspace = ? AND expiresAt > ?")
      .get(digest(grant), workspace, this.now()) as { email: string } | undefined;
    return row && this.workspace(workspace)?.status === "running" ? this.member(workspace, row.email) ?? null : null;
  }
  revokeGrants(workspace: string, email: string) {
    this.db.prepare("DELETE FROM portal_grant WHERE workspace = ? AND email = ?").run(workspace, normalizeEmail(email));
  }
}
