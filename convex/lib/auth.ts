import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;

// Optional compatibility for an operator's pre-workspace installation. Never public configuration.
export const DEFAULT_OWNER_EMAIL = (process.env.ORIGIN_LEGACY_OWNER_EMAIL || "").trim().toLowerCase();
const PASSWORD_ITERATIONS = 600_000;
const SESSION_DAYS = 30;
const encoder = new TextEncoder();

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function randomHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function hashPassword(password: string, salt: string, iterations = PASSWORD_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: toArrayBuffer(hexToBytes(salt)), iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function makePasswordRecord(password: string) {
  const salt = randomHex(16);
  return {
    passwordHash: await hashPassword(password, salt),
    salt,
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(user: Doc<"users">, password: string) {
  const hash = await hashPassword(password, user.salt, user.iterations);
  let difference = hash.length ^ user.passwordHash.length;
  for (let index = 0; index < hash.length; index += 1) difference |= hash.charCodeAt(index) ^ user.passwordHash.charCodeAt(index);
  return difference === 0;
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(encoder.encode(token)));
  return bytesToHex(new Uint8Array(digest));
}

export async function getUserByEmail(ctx: Ctx, email: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
    .unique();
}

export async function createUser(
  ctx: MutationCtx,
  args: { email: string; name: string; password: string; role?: "owner" | "user" },
) {
  const now = Date.now();
  const passwordRecord = await makePasswordRecord(args.password);
  return await ctx.db.insert("users", {
    email: normalizeEmail(args.email),
    name: args.name.trim() || normalizeEmail(args.email),
    username: normalizeEmail(args.email).split("@")[0],
    ...passwordRecord,
    role: args.role ?? "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

export async function createSession(ctx: MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  if (!user || user.status !== "active") throw new ConvexError("Your session has expired. Sign in again.");
  const now = Date.now();
  const token = randomHex(32);
  await ctx.db.insert("sessions", {
    userId,
    tokenHash: await hashToken(token),
    expiresAt: now + SESSION_DAYS * 24 * 60 * 60 * 1000,
    createdAt: now,
    lastSeenAt: now,
    sessionVersion: user.sessionVersion ?? 0,
  });
  return token;
}

export async function getSessionUser(ctx: Ctx, sessionToken: string) {
  if (!sessionToken || !/^[a-f0-9]{64}$/.test(sessionToken)) return null;
  const tokenHash = await hashToken(sessionToken);
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!session || session.expiresAt < Date.now()) return null;
  const user = await ctx.db.get(session.userId);
  if (!user || user.status !== "active") return null;
  if ((session.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) return null;
  return { session, user };
}

export async function invalidateOtherSessions(ctx: MutationCtx, user: Doc<"users">, current: Doc<"sessions">) {
  const sessionVersion = (user.sessionVersion ?? 0) + 1;
  await ctx.db.patch(user._id, { sessionVersion });
  await ctx.db.patch(current._id, { sessionVersion });
  const sessions = await ctx.db.query("sessions").withIndex("by_user", q => q.eq("userId", user._id)).take(500);
  for (const session of sessions) if (session._id !== current._id) await ctx.db.delete(session._id);
}

export async function requireUser(ctx: Ctx, sessionToken: string) {
  const result = await getSessionUser(ctx, sessionToken);
  if (!result) throw new ConvexError("Your session has expired. Sign in again.");
  return result.user;
}

export function publicUser(user: Doc<"users">) {
  return {
    _id: user._id,
    email: user.email,
    name: user.name,
    username: user.username,
    avatarStorageId: user.avatarStorageId,
    role: user.role,
    status: user.status,
  };
}
