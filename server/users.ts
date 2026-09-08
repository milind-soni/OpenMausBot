// People, as opposed to devices (docs/plans/2026-09-07-users-and-roles.md).
//
// A session in sessions.ts is a *device*: "Kitchen iPad" is a label, not an
// identity. This file adds the subject every authorization question needs
// first — who is asking — and the role that answers what they may do.
//
// The registry is pure data: it knows nothing about sessions, HTTP or scopes
// beyond the role→scope projection. Revoking a disabled person's devices is
// the server's job, in index.ts, because only it holds both registries.
//
// Two roles, not three. The machine's owner is not a row: a loopback request
// already holds both scopes (see request-auth.ts), which is what makes "may
// an admin demote the owner?" a question phase 1 never has to answer.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { Scope } from "./sessions.ts";

export type Role = "admin" | "member";
export type UserStatus = "active" | "disabled";
export const ROLES: readonly Role[] = ["admin", "member"];

/** What a role may ever do. A device's own ceiling narrows this further; the
 * effective set is the intersection (request-auth.ts). */
export function roleScopes(role: Role): readonly Scope[] {
  return role === "admin" ? ["admin", "client"] : ["client"];
}

const roleSchema = z.enum(["admin", "member"]);
const statusSchema = z.enum(["active", "disabled"]);

const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  /** A label and a future federation join key. Never an authentication
   * factor: a pairing code is the only way in. */
  email: z.string().email().max(320).nullable(),
  role: roleSchema,
  status: statusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The actor's user id, or null when the loopback owner created it. */
  createdBy: z.string().nullable(),
});

const fileSchema = z.object({ version: z.literal(1), users: z.array(userSchema) });

export type UserRecord = z.infer<typeof userSchema>;
/** Nothing in a user record is secret, but the file is still 0600: a roster
 * and its emails are not public. The projection exists so a later field that
 * *is* sensitive does not leak by default. */
export type PublicUser = UserRecord;

/** The read side request-auth.ts needs. Narrow on purpose: the auth path
 * never gains write access to the roster. */
export interface UserDirectory {
  find(id: string): UserRecord | null;
  isEmpty(): boolean;
}

export interface RequestUser {
  id: string;
  name: string;
  role: Role;
}

/** Thrown for the conditions a route turns into 400/409. Everything else is
 * a bug and propagates. */
export class UserError extends Error {
  status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
    this.name = "UserError";
  }
}

const LAST_ADMIN = "this is the last active admin; promote another account first";

function normalizeEmail(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  return value === "" ? null : value;
}

export function publicUser(record: UserRecord): PublicUser {
  return { ...record };
}

export class UserRegistry implements UserDirectory {
  private users: UserRecord[] = [];
  /** "unreadable" latches until the process restarts: see load(). */
  private state: "ok" | "unreadable" = "ok";
  private readonly now: () => number;
  private readonly options: { file: string; now?: () => number };

  // No parameter properties: the server runs this file under Node's
  // strip-only TypeScript mode, which only erases types.
  constructor(options: { file: string; now?: () => number }) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.load();
  }

  /** A missing file is an empty roster — the pre-RBAC state, and the reason
   * an upgrade is invisible to existing deployments.
   *
   * An unreadable one is NOT. SessionRegistry starts empty on a parse failure
   * because pairing again is cheap; recreating a roster is not, and starting
   * empty would also orphan every bound session while overwriting the only
   * copy of the evidence. So the registry latches into a state where it
   * serves nobody and, above all, never persists. Loopback still works, so
   * the operator can repair the file and restart. */
  private load(): void {
    if (!existsSync(this.options.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.options.file, "utf8"));
    } catch (error) {
      return this.markUnreadable(error);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) return this.markUnreadable(parsed.error);
    this.users = parsed.data.users;
  }

  private markUnreadable(error: unknown): void {
    this.state = "unreadable";
    this.users = [];
    console.error(
      `${this.options.file} could not be read (${error instanceof Error ? error.message : String(error)}). `
      + "No account can sign in until it is repaired; this server will not overwrite it. "
      + "Fix or remove the file and restart. Access from this machine still works.",
    );
  }

  private persist(): void {
    if (this.state === "unreadable") {
      throw new UserError(409, "the account file could not be read at startup; repair it and restart before making changes");
    }
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, JSON.stringify({ version: 1, users: this.users }, null, 2) + "\n", { mode: 0o600 });
  }

  /** null when the roster is fine, a sentence for /api/auth/users otherwise. */
  notice(): string | null {
    return this.state === "unreadable"
      ? "the account file could not be read at startup; no account can sign in until it is repaired and this server is restarted"
      : null;
  }

  isEmpty(): boolean {
    return this.users.length === 0;
  }

  find(id: string): UserRecord | null {
    return this.users.find((u) => u.id === id) ?? null;
  }

  findByEmail(email: string): UserRecord | null {
    const value = normalizeEmail(email);
    return value ? this.users.find((u) => u.email === value) ?? null : null;
  }

  list(): PublicUser[] {
    return this.users.map(publicUser);
  }

  private activeAdmins(): UserRecord[] {
    return this.users.filter((u) => u.role === "admin" && u.status === "active");
  }

  /** Guard A. An invariant of the file, so it is enforced here rather than in
   * a route handler: it then holds for every future caller, the admin panel
   * included, and it binds loopback too (which loses nothing — loopback can
   * add another admin first). */
  private assertNotLastAdmin(target: UserRecord, next: { role?: Role; status?: UserStatus }): void {
    const wasActiveAdmin = target.role === "admin" && target.status === "active";
    if (!wasActiveAdmin) return;
    const stillActiveAdmin = (next.role ?? target.role) === "admin" && (next.status ?? target.status) === "active";
    if (stillActiveAdmin) return;
    if (this.activeAdmins().length <= 1) throw new UserError(409, LAST_ADMIN);
  }

  private assertEmailFree(email: string | null, exceptId?: string): void {
    if (!email) return;
    if (this.users.some((u) => u.email === email && u.id !== exceptId)) {
      throw new UserError(409, "that email is already in use");
    }
  }

  create(input: { name: string; email?: string | null; role?: Role }, actorId: string | null): PublicUser {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new UserError(400, "name must be 1 to 80 characters");
    const email = normalizeEmail(input.email);
    if (email && !z.string().email().max(320).safeParse(email).success) throw new UserError(400, "email is not a valid address");
    this.assertEmailFree(email);
    const now = this.now();
    const record: UserRecord = {
      id: randomUUID(),
      name,
      email,
      role: input.role ?? "member",
      status: "active",
      createdAt: now,
      updatedAt: now,
      createdBy: actorId,
    };
    this.users.push(record);
    this.persist();
    return publicUser(record);
  }

  update(id: string, patch: { name?: string; email?: string | null; role?: Role; status?: UserStatus }): PublicUser | null {
    const record = this.find(id);
    if (!record) return null;
    this.assertNotLastAdmin(record, patch);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 80) throw new UserError(400, "name must be 1 to 80 characters");
      record.name = name;
    }
    if (patch.email !== undefined) {
      const email = normalizeEmail(patch.email);
      if (email && !z.string().email().max(320).safeParse(email).success) throw new UserError(400, "email is not a valid address");
      this.assertEmailFree(email, id);
      record.email = email;
    }
    if (patch.role !== undefined) record.role = patch.role;
    if (patch.status !== undefined) record.status = patch.status;
    record.updatedAt = this.now();
    this.persist();
    return publicUser(record);
  }

  remove(id: string): boolean {
    const record = this.find(id);
    if (!record) return false;
    this.assertNotLastAdmin(record, { status: "disabled" });
    this.users = this.users.filter((u) => u.id !== id);
    this.persist();
    return true;
  }
}
