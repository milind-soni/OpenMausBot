import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson } from "./schema.ts";

/**
 * The account directory is the owner-scoped seam between human names such as
 * "Personal" and provider operations. It stores only account references and
 * provenance; credentials belong to the provider connection, never here.
 */

/** A user-defined identity label; built-ins are conventions, not a closed set. */
export type LogicalIdentity = string;
export type LogicalIdentityInput = string;
export type AccountSource = "connected-app" | "browser" | "phone" | "local";

export interface AccountObservation {
  readonly ownerId: string;
  readonly identity: LogicalIdentityInput;
  readonly provider: string;
  readonly accountId: string;
  readonly source: AccountSource;
  readonly sourceId: string;
  readonly observedAt?: string;
  readonly evidenceRef?: string;
}

export interface AccountDirectoryOptions {
  readonly ownerId: string;
  readonly store?: AccountDirectoryStore;
}

/** Durable adapter seam. Implementations must persist only these safe references. */
export interface AccountDirectoryStore {
  load(ownerId: string): ReadonlyArray<AccountObservation>;
  save(ownerId: string, observations: ReadonlyArray<AccountObservation>): void;
}

/** Useful for tests and embedded callers; replace with a file/database adapter for restart durability. */
export class InMemoryAccountDirectoryStore implements AccountDirectoryStore {
  private readonly records = new Map<string, AccountObservation[]>();

  load(ownerId: string): ReadonlyArray<AccountObservation> {
    return (this.records.get(ownerId) ?? []).map((record) => ({ ...record }));
  }

  save(ownerId: string, observations: ReadonlyArray<AccountObservation>): void {
    this.records.set(ownerId, observations.map((observation) => ({ ...observation })));
  }
}

const persistedObservationSchema = z.object({
  ownerId: z.string(),
  identity: z.string(),
  provider: z.string(),
  accountId: z.string(),
  source: z.enum(["connected-app", "browser", "phone", "local"]),
  sourceId: z.string(),
  observedAt: z.string().optional(),
  evidenceRef: z.string().optional(),
}).strict();
const persistedFileSchema = z.object({
  version: z.literal(1),
  owners: z.record(z.string(), z.array(persistedObservationSchema)),
}).strict();
type PersistedFile = z.infer<typeof persistedFileSchema>;

/** Atomic, mode-restricted JSON persistence for one or more owner scopes. */
export class JsonFileAccountDirectoryStore implements AccountDirectoryStore {
  private readonly file: string;

  constructor(file: string) {
    if (!file.trim()) throw new AccountDirectoryError("invalid_storage", "An account directory file path is required");
    this.file = file;
  }

  load(ownerId: string): ReadonlyArray<AccountObservation> {
    const safeOwnerId = normalizeOpaqueId(ownerId);
    if (!safeOwnerId) throw new AccountDirectoryError("invalid_storage", "The account directory owner is invalid");
    const disk = this.readDisk();
    const records = Object.hasOwn(disk.owners, safeOwnerId) ? disk.owners[safeOwnerId] : undefined;
    return (records ?? []).map((record) => ({ ...record }));
  }

  save(ownerId: string, observations: ReadonlyArray<AccountObservation>): void {
    const safeOwnerId = normalizeOpaqueId(ownerId);
    if (!safeOwnerId) throw new AccountDirectoryError("invalid_storage", "The account directory owner is invalid");
    const safeObservations: Array<z.infer<typeof persistedObservationSchema>> = [];
    for (const observation of observations) {
      const checked = persistedObservationSchema.safeParse(observation);
      if (!checked.success) throw new AccountDirectoryError("storage_invalid", "The account directory contains an invalid record");
      safeObservations.push(checked.data);
    }
    const disk = this.readDisk();
    const owners = { ...disk.owners, [safeOwnerId]: safeObservations };
    const next = { version: 1, owners } satisfies PersistedFile;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    } catch {
      throw new AccountDirectoryError("storage_unwritable", "The account directory could not be written");
    }
  }

  private readDisk(): PersistedFile {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, owners: {} };
      }
      throw new AccountDirectoryError("storage_invalid", "The account directory could not be read");
    }
    try {
      const checked = persistedFileSchema.safeParse(parseJson(text));
      if (!checked.success) throw new Error("invalid account directory storage");
      return checked.data;
    } catch {
      throw new AccountDirectoryError("storage_invalid", "The account directory storage is invalid");
    }
  }
}

export interface AccountSourceRef {
  readonly kind: AccountSource;
  readonly sourceId: string;
}

export interface AccountBinding {
  readonly ownerId: string;
  readonly identity: LogicalIdentity;
  readonly provider: string;
  readonly accountId: string;
  readonly sources: ReadonlyArray<AccountSourceRef>;
  readonly evidenceRefs: ReadonlyArray<string>;
}

export type AccountRegistrationResult =
  | { readonly status: "accepted"; readonly binding: AccountBinding }
  | { readonly status: "duplicate"; readonly binding: AccountBinding };

export interface AccountResolutionRequest {
  readonly ownerId: string;
  readonly identity: LogicalIdentity;
  readonly provider: string;
}

export interface ExactAccountResolutionRequest extends AccountResolutionRequest {
  readonly accountId: string;
}

/** An explicit inventory record paired with a human-selected logical slot.
 * There is intentionally no display-name matching here: callers must provide
 * the identity binding themselves when bootstrapping Personal/SEF/Anvil. */
export interface ExplicitAccountBinding {
  readonly identity: LogicalIdentity;
  readonly provider: string;
  readonly accountId: string;
  readonly source: AccountSource;
  readonly sourceId: string;
  readonly observedAt?: string;
  readonly evidenceRef?: string;
}

export interface AccountReconciliationResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: ReadonlyArray<{ readonly binding: ExplicitAccountBinding; readonly reason: string }>;
}

/** Functional bootstrap seam for startup code that already has explicit
 * Personal/SEF/Anvil mappings. It is intentionally a thin named helper so a
 * future inventory adapter cannot silently infer identity from aliases. */
export function reconcileAccountDirectory(
  directory: AccountDirectory,
  bindings: ReadonlyArray<ExplicitAccountBinding>,
): AccountReconciliationResult {
  return directory.reconcile(bindings);
}

export type AccountResolution =
  | AccountBinding & { readonly status: "resolved" }
  | {
      readonly status: "ambiguous";
      readonly ownerId: string;
      readonly identity: LogicalIdentity;
      readonly provider: string;
      readonly candidates: ReadonlyArray<Pick<AccountBinding, "accountId" | "sources" | "evidenceRefs">>;
    }
  | {
      readonly status: "not_found";
      readonly ownerId: string;
      readonly identity: LogicalIdentity;
      readonly provider: string;
    }
  | { readonly status: "forbidden"; readonly reason: "owner_mismatch" }
  | { readonly status: "invalid"; readonly reason: string };

export type AccountDirectoryErrorCode =
  | "invalid_owner"
  | "invalid_storage"
  | "storage_invalid"
  | "storage_unwritable"
  | "invalid_observation"
  | "ownership_mismatch"
  | "identity_conflict"
  | "credentials_not_allowed";

export class AccountDirectoryError extends Error {
  readonly code: AccountDirectoryErrorCode;

  constructor(code: AccountDirectoryErrorCode, message: string) {
    super(message);
    this.name = "AccountDirectoryError";
    this.code = code;
  }
}

interface StoredObservation {
  readonly ownerId: string;
  readonly identity: LogicalIdentity;
  readonly provider: string;
  readonly accountId: string;
  readonly source: AccountSource;
  readonly sourceId: string;
  readonly evidenceRef?: string;
}

interface MutableCandidate {
  readonly accountId: string;
  readonly observations: Map<string, StoredObservation>;
}

const FORBIDDEN_FIELDS = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "private_key",
  "privatekey",
  "refresh_token",
  "refreshtoken",
  "secret",
  "token",
]);

const SOURCE_ORDER = {
  browser: 0,
  "connected-app": 1,
  local: 2,
  phone: 3,
} satisfies Readonly<Record<AccountSource, number>>;

export class AccountDirectory {
  private readonly ownerId: string;
  private readonly store: AccountDirectoryStore;
  private readonly candidates = new Map<string, Map<string, MutableCandidate>>();
  private readonly accountClaims = new Map<string, LogicalIdentity>();
  private readonly observations = new Map<string, StoredObservation>();

  constructor(options: AccountDirectoryOptions) {
    const ownerId = normalizeOpaqueId(options.ownerId);
    if (!ownerId) throw new AccountDirectoryError("invalid_owner", "An owner ID is required");
    this.ownerId = ownerId;
    this.store = options.store ?? new InMemoryAccountDirectoryStore();
    for (const observation of this.store.load(ownerId)) {
      const safe = normalizeObservation(observation);
      if (safe.ownerId !== ownerId) {
        throw new AccountDirectoryError("ownership_mismatch", "The durable account record belongs to another owner");
      }
      this.insert(safe);
    }
  }

  /** The owner scope used by this directory; exposed to trusted adapters so
   * they cannot accidentally register a record under another owner. */
  getOwnerId(): string {
    return this.ownerId;
  }

  register(observation: AccountObservation): AccountRegistrationResult {
    const safe = normalizeObservation(observation);
    if (safe.ownerId !== this.ownerId) {
      throw new AccountDirectoryError("ownership_mismatch", "The observation belongs to another owner");
    }

    const observationKey = keyOfObservation(safe);
    const existing = this.observations.get(observationKey);
    if (existing) {
      const binding = this.bindingFor(safe.identity, safe.provider, safe.accountId);
      return { status: "duplicate", binding };
    }

    this.insert(safe);
    this.persist();
    return { status: "accepted", binding: this.bindingFor(safe.identity, safe.provider, safe.accountId) };
  }

  /** Reconcile only explicitly bound inventory records. Unknown or malformed
   * records are reported, never guessed into a logical identity. */
  reconcile(bindings: ReadonlyArray<ExplicitAccountBinding>): AccountReconciliationResult {
    let accepted = 0;
    let duplicates = 0;
    const rejected: Array<{ binding: ExplicitAccountBinding; reason: string }> = [];
    for (const binding of bindings) {
      try {
        const result = this.register({ ownerId: this.ownerId, ...binding });
        if (result.status === "accepted") accepted += 1;
        else duplicates += 1;
      } catch (error) {
        rejected.push({
          binding,
          reason: error instanceof Error ? error.message : "The account binding was rejected",
        });
      }
    }
    return { accepted, duplicates, rejected };
  }

  resolve(request: AccountResolutionRequest): AccountResolution {
    if (request.ownerId !== this.ownerId) return { status: "forbidden", reason: "owner_mismatch" };
    const identity = normalizeIdentity(request.identity);
    const provider = normalizeProvider(request.provider);
    if (!identity || !provider) return { status: "invalid", reason: "A valid identity and provider are required" };

    const byAccount = this.candidates.get(keyOfIdentity(identity, provider));
    if (!byAccount || byAccount.size === 0) {
      return { status: "not_found", ownerId: this.ownerId, identity, provider };
    }
    const bindings = [...byAccount.values()]
      .sort((left, right) => left.accountId.localeCompare(right.accountId))
      .map((candidate) => this.bindingFromCandidate(identity, provider, candidate));
    if (bindings.length !== 1) {
      return {
        status: "ambiguous",
        ownerId: this.ownerId,
        identity,
        provider,
        candidates: bindings.map(({ accountId, sources, evidenceRefs }) => ({ accountId, sources, evidenceRefs })),
      };
    }
    const binding = bindings[0];
    if (!binding) return { status: "not_found", ownerId: this.ownerId, identity, provider };
    return { status: "resolved", ...binding };
  }

  resolveExact(request: ExactAccountResolutionRequest): AccountResolution {
    const base = this.resolve(request);
    if (base.status !== "resolved") return base;
    const accountId = normalizeAccountId(request.accountId);
    if (!accountId || accountId !== base.accountId) {
      return { status: "not_found", ownerId: base.ownerId, identity: base.identity, provider: base.provider };
    }
    return base;
  }

  /** Resolve an exact provider account without accepting a logical alias. */
  findExactAccount(request: { readonly ownerId: string; readonly provider: string; readonly accountId: string }): AccountBinding | null {
    if (request.ownerId !== this.ownerId) return null;
    const provider = normalizeProvider(request.provider);
    const accountId = normalizeAccountId(request.accountId);
    if (!provider || !accountId) return null;
    const identity = this.accountClaims.get(keyOfAccount(provider, accountId));
    return identity ? this.bindingFor(identity, provider, accountId) : null;
  }

  snapshot(): ReadonlyArray<AccountBinding> {
    const bindings: AccountBinding[] = [];
    for (const [identityProvider, byAccount] of this.candidates) {
      const separator = identityProvider.indexOf("\u0000");
      const identityText = identityProvider.slice(0, separator);
      const provider = identityProvider.slice(separator + 1);
      const identity = normalizeIdentity(identityText);
      if (!identity) continue;
      for (const candidate of byAccount.values()) {
        bindings.push(this.bindingFromCandidate(identity, provider, candidate));
      }
    }
    return bindings.sort((left, right) =>
      left.identity.localeCompare(right.identity) ||
      left.provider.localeCompare(right.provider) ||
      left.accountId.localeCompare(right.accountId),
    );
  }

  private persist(): void {
    this.store.save(this.ownerId, [...this.observations.values()].map((observation) => ({ ...observation })));
  }

  private insert(safe: StoredObservation): void {
    const observationKey = keyOfObservation(safe);
    if (this.observations.has(observationKey)) return;
    const accountKey = keyOfAccount(safe.provider, safe.accountId);
    const claimedIdentity = this.accountClaims.get(accountKey);
    if (claimedIdentity && claimedIdentity !== safe.identity) {
      throw new AccountDirectoryError(
        "identity_conflict",
        "An exact provider account cannot belong to two logical identities",
      );
    }
    let byAccount = this.candidates.get(keyOfIdentity(safe.identity, safe.provider));
    if (!byAccount) {
      byAccount = new Map<string, MutableCandidate>();
      this.candidates.set(keyOfIdentity(safe.identity, safe.provider), byAccount);
    }
    let candidate = byAccount.get(safe.accountId);
    if (!candidate) {
      candidate = { accountId: safe.accountId, observations: new Map<string, StoredObservation>() };
      byAccount.set(safe.accountId, candidate);
    }
    candidate.observations.set(keyOfSource(safe.source, safe.sourceId), safe);
    this.observations.set(observationKey, safe);
    this.accountClaims.set(accountKey, safe.identity);
  }

  private bindingFor(identity: LogicalIdentity, provider: string, accountId: string): AccountBinding {
    const byAccount = this.candidates.get(keyOfIdentity(identity, provider));
    const candidate = byAccount?.get(accountId);
    if (!candidate) throw new AccountDirectoryError("invalid_observation", "Account binding was not created");
    return this.bindingFromCandidate(identity, provider, candidate);
  }

  private bindingFromCandidate(identity: LogicalIdentity, provider: string, candidate: MutableCandidate): AccountBinding {
    const stored = [...candidate.observations.values()];
    const sources = stored
      .map(({ source, sourceId }) => ({ kind: source, sourceId }))
      .sort((left, right) => SOURCE_ORDER[left.kind] - SOURCE_ORDER[right.kind] || left.sourceId.localeCompare(right.sourceId));
    const evidenceRefs = [...new Set(stored.flatMap((item) => item.evidenceRef ? [item.evidenceRef] : []))].sort();
    return { ownerId: this.ownerId, identity, provider, accountId: candidate.accountId, sources, evidenceRefs };
  }
}

function normalizeObservation(input: AccountObservation): StoredObservation {
  rejectCredentialFields(input);
  const ownerId = normalizeOpaqueId(input.ownerId);
  const identity = normalizeIdentity(input.identity);
  const provider = normalizeProvider(input.provider);
  const accountId = normalizeAccountId(input.accountId);
  const source = normalizeSource(input.source);
  const sourceId = normalizeOpaqueId(input.sourceId);
  if (!ownerId || !identity || !provider || !accountId || !source || !sourceId) {
    throw new AccountDirectoryError("invalid_observation", "The account observation contains an invalid reference");
  }
  if (input.observedAt !== undefined && Number.isNaN(Date.parse(input.observedAt))) {
    throw new AccountDirectoryError("invalid_observation", "Observation time must be a valid date");
  }
  const evidenceRef = input.evidenceRef === undefined ? undefined : normalizeEvidenceRef(input.evidenceRef);
  const safe = { ownerId, identity, provider, accountId, source, sourceId };
  if (evidenceRef) return { ...safe, evidenceRef };
  return safe;
}

function rejectCredentialFields(input: AccountObservation): void {
  for (const field of Object.keys(input)) {
    const normalized = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toLowerCase();
    if (FORBIDDEN_FIELDS.has(normalized)) {
      throw new AccountDirectoryError("credentials_not_allowed", "Credentials are never accepted by the account directory");
    }
  }
}

function normalizeIdentity(value: string): LogicalIdentity | null {
  const normalized = value.trim();
  if (normalized !== value || normalized.length === 0 || normalized.length > 100) return null;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return null;
  }
  return normalized;
}

function normalizeSource(value: string): AccountSource | null {
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "connected-app": return "connected-app";
    case "browser": return "browser";
    case "phone": return "phone";
    case "local": return "local";
    default: return null;
  }
}

function normalizeProvider(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9._-]{1,63}$/.test(normalized) ? normalized : null;
}

function normalizeAccountId(value: string): string | null {
  const normalized = value.trim();
  return normalized === value && /^ca_[A-Za-z0-9_-]{2,200}$/.test(normalized) ? normalized : null;
}

function normalizeOpaqueId(value: string): string | null {
  const normalized = value.trim();
  if (normalized !== value || normalized.length === 0 || normalized.length > 200 || /\s/u.test(normalized)) return null;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return null;
  }
  return normalized;
}

function normalizeEvidenceRef(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > 500 || /(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)=/i.test(normalized)) {
    throw new AccountDirectoryError("credentials_not_allowed", "Credential-bearing evidence is never stored");
  }
  return normalized;
}

function keyOfIdentity(identity: LogicalIdentity, provider: string): string {
  return `${identity}\u0000${provider}`;
}

function keyOfAccount(provider: string, accountId: string): string {
  return `${provider}\u0000${accountId}`;
}

function keyOfSource(source: AccountSource, sourceId: string): string {
  return `${source}\u0000${sourceId}`;
}

function keyOfObservation(observation: StoredObservation): string {
  return `${observation.identity}\u0000${observation.provider}\u0000${observation.accountId}\u0000${observation.source}\u0000${observation.sourceId}`;
}
