// Box lifecycle — turn action decisions, find/ready resolution,
// provision/wake/sleep, and the Settings-facing managed mutations.

import {
  adoptResolvedBox,
  beginBoxCreate,
  discardBoxCreate,
  rememberCreatedBox,
  resolveBoxCreate,
  retireDeletedBoxCreate,
  type BoxCreateRequest,
} from "../box-create-idempotency.ts";
import { boxDeletionSnapshot, getBoxDeletion } from "../box-delete-journal.ts";
import type { AppConfig } from "../config.ts";
import {
  BOX_ID,
  boxConfigured,
  boxCredentialEnv,
  boxErrorMessage,
  boxIdCache,
  boxJson,
  forgetBoxId,
  inspectBoxIdentity,
  READY,
  snapshotBoxConfig,
} from "./api.ts";
import { mintDesktopUrl, runCommand } from "./commands.ts";
import {
  assertBotBoxNotDeleting,
  assertBoxNotDeleting,
  deletionFenceError,
  reconcileRecordedBoxDeletion,
  requestRecordedBoxDeletion,
  type BoxDeletionReconciliation,
} from "./deletion.ts";
import {
  inventoryFailure,
  listBoxPages,
  listManagedBoxes,
  type ManagedBoxInventoryInstance,
  type ManagedBoxOwner,
} from "./inventory.ts";
import { boxNameFor, legacyBoxNameFor } from "./naming.ts";

const SLEEPING = new Set(["archived", "archiving", "stopped", "stopping"]);

const DEFAULT_BOX_TTL_SECONDS = 8 * 60 * 60;
const TRIAL_BOX_TTL_SECONDS = 2 * 60 * 60;
const BOX_CREATE_IN_PROGRESS_RETRY_DELAYS_MS = [250, 750, 1_500] as const;

export type BoxTurnLifecycleAction = "attach" | "provision" | "wake" | "none";

/** Decide lifecycle work before a turn mounts Box. Auto may observe and
 * attach an already-ready Box, but only explicit Cloud may create or wake. */
export function boxTurnLifecycleAction({
  explicitCloud,
  canMount,
  state,
}: {
  explicitCloud: boolean;
  canMount: boolean;
  state: string | null;
}): BoxTurnLifecycleAction {
  if (!canMount) return "none";
  if (state && READY.has(state)) return "attach";
  if (!explicitCloud) return "none";
  return state ? "wake" : "provision";
}

export type ManagedBoxMutationClaim = (
  instance: ManagedBoxInventoryInstance,
) => (() => void) | void;

export async function waitReady(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  assertBoxNotDeleting(boxId);
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    assertBoxNotDeleting(boxId);
    const { body } = await boxJson(cfg, `/boxes/${boxId}`);
    const state = body?.box?.state;
    if (READY.has(state)) return body.box;
    if (state === "error") return null;
    // an archiving box can't resume until the snapshot lands — nudge after
    if (state === "archived") await boxJson(cfg, `/boxes/${boxId}/resume`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

async function revalidateManagedBox(
  cfg: AppConfig,
  owners: ManagedBoxOwner[],
  boxId: string,
): Promise<ManagedBoxInventoryInstance> {
  if (!BOX_ID.test(boxId)) throw Object.assign(new Error("invalid cloud computer id"), { status: 400 });
  const inventory = await listManagedBoxes(cfg, owners);
  if (!inventory.available) throw inventoryFailure(inventory);
  const instance = inventory.instances.find((candidate) => candidate.boxId === boxId);
  if (!instance) {
    throw Object.assign(new Error("that OpenMaus-managed cloud computer no longer exists"), { status: 404 });
  }
  return instance;
}

const QUIESCE_BROWSER = [
  'for name in chrome google-chrome chromium chromium-browser; do pid=$(pgrep -o -x "$name" 2>/dev/null || true); [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true; done',
  'for i in 1 2 3 4 5 6 7 8; do if ! pgrep -x chrome >/dev/null 2>&1 && ! pgrep -x google-chrome >/dev/null 2>&1 && ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then break; fi; sleep 0.25; done',
].join("; ");

async function stopBox(cfg: AppConfig, boxId: string): Promise<void> {
  assertBoxNotDeleting(boxId);
  // Browser shutdown is best-effort, but the provider stop is not: Settings
  // must never say a computer is sleeping when ascii.dev rejected the action.
  await runCommand(cfg, boxId, QUIESCE_BROWSER, { timeoutMs: 5_000 }).catch(() => null);
  const stopped = await boxJson(cfg, `/boxes/${boxId}/stop`, { method: "POST" });
  if (!stopped.ok) throw Object.assign(new Error(boxErrorMessage(stopped.status, "box sleep", stopped.body)), { status: stopped.status });
}

/** Explicit Settings action. Re-listing prevents a stale row from targeting a
 * renamed or foreign provider resource. This never wakes or joins a Box. */
export async function sleepManagedBox(
  cfg: AppConfig,
  owners: ManagedBoxOwner[],
  boxId: string,
  claim?: ManagedBoxMutationClaim,
) {
  cfg = snapshotBoxConfig(cfg);
  assertBoxNotDeleting(boxId);
  const instance = await revalidateManagedBox(cfg, owners, boxId);
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (!SLEEPING.has(instance.state) && !READY.has(instance.state)) {
    throw Object.assign(new Error(`this cloud computer cannot sleep while it is ${instance.state}`), { status: 409 });
  }
  const release = claim?.(instance);
  try {
    if (!SLEEPING.has(instance.state)) await stopBox(cfg, instance.boxId);
    forgetBoxId(instance.boxId);
    return { ok: true };
  } finally {
    release?.();
  }
}

/** Permanent Settings action. The caller must echo the exact freshly-listed
 * machine name as well as its id; ascii.dev independently requires the id in
 * its confirmation header. */
export async function deleteManagedBox(
  cfg: AppConfig,
  owners: ManagedBoxOwner[],
  boxId: string,
  confirmName: string,
  claim?: ManagedBoxMutationClaim,
  options: { pollDelaysMs?: readonly number[] } = {},
) {
  cfg = snapshotBoxConfig(cfg);
  const remembered = getBoxDeletion(boxId);
  if (remembered) {
    const reconciled = await reconcileRecordedBoxDeletion(cfg, remembered, [0]);
    if (reconciled === "confirmed") return { ok: true };
    // A validated accepted operation owns this target. Retrying DELETE would
    // create a second operation and weaken the only trustworthy receipt.
    const current = getBoxDeletion(boxId);
    if (current?.phase === "accepted") {
      return { ok: true, pending: true as const };
    }
    // Prepared (ambiguous request) and blocked records may be retried only by
    // this explicit Settings/bot-deletion path after fresh identity checks.
  }
  const instance = await revalidateManagedBox(cfg, owners, boxId);
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (confirmName !== instance.name) {
    throw Object.assign(new Error("cloud computer confirmation no longer matches — refresh and try again"), { status: 409 });
  }
  const release = claim?.(instance);
  try {
    const confirmation = await requestRecordedBoxDeletion(cfg, {
      boxId: instance.boxId,
      name: instance.name,
      ownerBotId: instance.ownerBotId,
    }, options.pollDelaysMs);
    if (confirmation === "pending") {
      forgetBoxId(instance.boxId);
      return { ok: true, pending: true as const };
    }
    return { ok: true };
  } finally {
    release?.();
  }
}

export async function findBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  assertBotBoxNotDeleting(botId);
  const cachedId = boxIdCache.get(botId);
  if (cachedId) {
    let direct: Awaited<ReturnType<typeof boxJson>> | null = null;
    try {
      direct = await boxJson(cfg, `/boxes/${cachedId}`);
    } catch {
      // A direct read can fail while the account listing still succeeds.
      // Fall through to the authoritative paginated lookup before deciding.
    }
    const directBox = direct?.body?.box;
    if (direct?.ok && directBox?.id === cachedId && directBox.state !== "error") return directBox;
    if (direct?.ok && directBox?.id !== cachedId) {
      throw Object.assign(new Error("ascii.dev returned an invalid cloud computer identity"), { status: 503 });
    }
    boxIdCache.delete(botId); // gone or broken — fall back to the listing
  }
  const name = await boxNameFor(botId);
  const legacyName = legacyBoxNameFor(botId);
  const listed = await listBoxPages(cfg);
  if (!listed.ok) {
    throw Object.assign(new Error(listed.problem), { status: 503 });
  }
  // Prefer the installation-scoped identity. A legacy name remains
  // discoverable only for this exact local bot id.
  const expected = listed.boxes.filter((candidate: any) => candidate?.name === name || candidate?.name === legacyName);
  if (expected.some((candidate: any) => !BOX_ID.test(candidate?.id))) {
    throw Object.assign(new Error("ascii.dev returned an invalid cloud computer identity"), { status: 503 });
  }
  const found = expected.find((candidate: any) => candidate.name === name && candidate.state !== "error")
    ?? expected.find((candidate: any) => candidate.name === legacyName && candidate.state !== "error")
    ?? null;
  if (found) {
    const duplicateId = listed.boxes.filter((candidate: any) => candidate?.id === found.id).length !== 1;
    if (duplicateId) {
      throw Object.assign(new Error("ascii.dev returned a conflicting cloud computer identity"), { status: 503 });
    }
    if (found.name === legacyName) adoptResolvedBox(botId, found.id);
    boxIdCache.set(botId, found.id);
  }
  return found;
}

/** Ready-or-null without the LIST when we already know the box. */
export async function readyBox(cfg: AppConfig, botId: string, budgetMs = 60_000) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) return null;
  if (READY.has(box.state)) return box;
  return waitReady(cfg, box.id, budgetMs);
}

/** ascii.dev trial accounts reject the normal eight-hour auto-stop with a
 * structured `trial_auto_stop_required` refusal. Retry that one condition
 * once at the provider's advertised maximum (or the documented two-hour
 * trial ceiling). Other create failures must retain their original error. */
function trialBoxTtlSeconds(body: any): number | null {
  const code = body?.error?.code ?? body?.code;
  if (code !== "trial_auto_stop_required") return null;
  const details = body?.error?.details ?? body?.details ?? {};
  for (const value of [details.maxTtlSeconds, details.maximumTtlSeconds, details.maxAutoStopSeconds]) {
    if (Number.isInteger(value) && value > 0 && value <= DEFAULT_BOX_TTL_SECONDS) return value;
  }
  return TRIAL_BOX_TTL_SECONDS;
}

type BoxCreateResult = Awaited<ReturnType<typeof boxJson>> & {
  request: BoxCreateRequest;
  /** Automatic deletion is safe only for a Box first created by this exact
   * provisioning call. A journal recovery may point at durable user data. */
  createdThisAttempt: boolean;
};

function idempotentCreateInProgress(result: Awaited<ReturnType<typeof boxJson>>): boolean {
  const code = result.body?.error?.code ?? result.body?.code;
  return result.status === 409 && code === "idempotency_in_progress";
}

async function requestBoxCreate(cfg: AppConfig, botId: string, ttlSeconds: number, env: Record<string, string>): Promise<BoxCreateResult> {
  // The computer needs the user's desktop session, not the account owner's
  // host credentials. Keep provider-side env injection off; the only keys the
  // guest ever has are the ones this OpenMausBot forwards (`env`), which its
  // agents need now that the turn runs on the box. The idempotency identity
  // stays the secret-free part: a trial-TTL retry must receive a different
  // key, and the journal on disk never carries a credential.
  const body = JSON.stringify({ ttlSeconds, noEnv: true });
  const wireBody = JSON.stringify({ ttlSeconds, noEnv: true, ...(Object.keys(env).length ? { env } : {}) });
  let attempt = beginBoxCreate(botId, body);
  let request = attempt.request;
  let createdThisAttempt = attempt.startedNow;

  // A previous process received the Box but died before naming it. Resolve
  // the durable identity directly; never issue a second create first.
  if (request.boxId) {
    const recovered = await boxJson(cfg, `/boxes/${request.boxId}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (recovered.ok && recovered.body?.box?.id === request.boxId) {
      return { ...recovered, request, createdThisAttempt: false };
    }
    if (recovered.status !== 404 && recovered.status !== 410) {
      return { ...recovered, request, createdThisAttempt: false };
    }
    discardBoxCreate(request);
    attempt = beginBoxCreate(botId, body);
    request = attempt.request;
    createdThisAttempt = attempt.startedNow;
  }

  let last: Awaited<ReturnType<typeof boxJson>> | null = null;
  let ambiguousRetries = 0;
  let inProgressRetries = 0;
  for (;;) {
    try {
      last = await boxJson(cfg, "/boxes", {
        method: "POST",
        headers: { "Idempotency-Key": request.idempotencyKey },
        signal: AbortSignal.timeout(45_000),
        body: wireBody,
      });
    } catch (error) {
      // A dropped response is ambiguous: ascii.dev may already have created
      // the Box. One retry with the same key recovers it safely.
      if (ambiguousRetries++ === 0) continue;
      throw error;
    }
    const boxId = last.body?.box?.id;
    if (last.ok && typeof boxId === "string" && boxId) {
      request = rememberCreatedBox(request, boxId);
      return { ...last, request, createdThisAttempt };
    }
    if (idempotentCreateInProgress(last)) {
      const delay = BOX_CREATE_IN_PROGRESS_RETRY_DELAYS_MS[inProgressRetries++];
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return { ...last, request, createdThisAttempt };
    }
    if ((last.status >= 500 || last.ok) && ambiguousRetries++ === 0) continue;
    // A 5xx or any idempotency conflict can follow a provider-side create;
    // keep its key for recovery. Only a definitive client rejection proves
    // this request did not create a Box and may be replaced safely.
    if (last.status < 500 && last.status !== 409 && !last.ok) discardBoxCreate(request);
    return { ...last, request, createdThisAttempt };
  }
}

async function createBox(cfg: AppConfig, botId: string, env: Record<string, string>) {
  const first = await requestBoxCreate(cfg, botId, DEFAULT_BOX_TTL_SECONDS, env);
  if (first.ok) return first;
  const trialTtl = trialBoxTtlSeconds(first.body);
  return trialTtl === null ? first : requestBoxCreate(cfg, botId, trialTtl, env);
}

/** A prior explicit delete always wins over provisioning. Reconcile/retry the
 * old immutable target, then require a fresh provision request so one click
 * can never both erase and silently recreate the same computer. */
async function finishPriorDeletionBeforeProvision(cfg: AppConfig, botId: string): Promise<void> {
  const remembered = boxDeletionSnapshot().filter((record) => record.ownerBotId === botId);
  if (!remembered.length) return;
  for (const deletion of remembered) {
    let state = await reconcileRecordedBoxDeletion(cfg, deletion, [0]);
    if (state !== "confirmed") {
      const current = getBoxDeletion(deletion.boxId);
      if (current?.phase === "prepared" || current?.phase === "blocked") {
        state = await requestRecordedBoxDeletion(cfg, {
          boxId: current.boxId,
          name: current.name,
          ownerBotId: current.ownerBotId,
        });
      }
    }
    if (state !== "confirmed") throw deletionFenceError();
  }
  throw Object.assign(
    new Error("the previous cloud computer deletion finished — retry to create a new computer"),
    { status: 409 },
  );
}

/**
 * Find-or-create the bot's persistent box, wait for ready, and mint a fresh
 * desktop URL. The box ships its own computer-use driver and agent runner.
 */
export async function provisionBox(cfg: AppConfig, botId: string, _botName: string) {
  const credentialEnv = boxCredentialEnv(cfg);
  cfg = snapshotBoxConfig(cfg);
  if (!boxConfigured(cfg)) {
    throw new Error('box provider not enabled — add {"box":{"token":"…"}} to ~/.openmausbot/config.json');
  }
  await finishPriorDeletionBeforeProvision(cfg, botId);
  const vmName = await boxNameFor(botId);
  let box = await findBox(cfg, botId);
  let created = false;
  let createRequest: BoxCreateRequest | null = null;
  try {
    if (!box) {
      // Deletion can be prepared by another process after the initial lookup.
      // Never create a replacement until the durable fence is reconciled.
      assertBotBoxNotDeleting(botId);
      // Provider-side backstop: archives itself (billing pauses, disk
      // survives) if every stop path dies. Trial accounts get one narrower
      // retry when ascii.dev reports their shorter TTL ceiling.
      const createRes = await createBox(cfg, botId, credentialEnv);
      if (!createRes.ok || !createRes.body?.box?.id) {
        throw new Error(boxErrorMessage(createRes.status, "box create", createRes.body));
      }
      box = createRes.body.box;
      createRequest = createRes.request;
      created = createRes.createdThisAttempt;
      const rename = await boxJson(cfg, `/boxes/${box.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: vmName }),
      });
      if (!rename.ok) throw new Error(boxErrorMessage(rename.status, "box naming", rename.body));
      if (createRequest) createRequest = resolveBoxCreate(createRequest);
    }
    const ready = await waitReady(cfg, box.id);
    if (!ready) throw new Error("box did not become ready within 90s — retry in a minute");

    // Nothing to install: every box ships its own computer-use driver and
    // registers it with every harness it runs.
    const joinUrl = await mintDesktopUrl(cfg, box.id);
    if (!joinUrl) throw new Error("box desktop link could not be created");
    return { boxId: box.id, machineName: vmName, reused: !created, state: ready.state, joinUrl };
  } catch (error) {
    if (!created || !box?.id) throw error;
    const originalMessage = error instanceof Error ? error.message : String(error);
    // Capture the provider's current name when possible. Naming may be the
    // step that failed, so the desired deterministic name is only a fallback
    // for the durable fence, never proof of a later live identity.
    const inspected = await inspectBoxIdentity(cfg, box.id);
    if (inspected.available && !inspected.identity) {
      retireDeletedBoxCreate(box.id);
      boxIdCache.delete(botId);
      throw error;
    }
    let cleanupConfirmation: BoxDeletionReconciliation;
    try {
      cleanupConfirmation = await requestRecordedBoxDeletion(cfg, {
        boxId: box.id,
        name: inspected.identity?.name ?? vmName,
        ownerBotId: botId,
      });
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${originalMessage}. The new computer's deletion was not confirmed: ${cleanupMessage}. Check box ${box.id} in ascii.dev.`);
    }
    if (cleanupConfirmation === "confirmed") throw error;
    boxIdCache.delete(botId);
    throw Object.assign(
      new Error(
        `${originalMessage}. ascii.dev accepted deletion of the new computer, but it is still pending; `
        + `its recovery record was kept, along with its deletion fence. Check box ${box.id} in ascii.dev.`,
        { cause: error },
      ),
      { status: 503 },
    );
  }
}

/** Wake the bot's box and return a FRESH desktop URL. */
export async function joinBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer yet — provision it first");
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("the box did not wake in time — try again");
  // Provider archive/resume preserves disk but not processes; the box brings
  // its own driver daemon back up, so there is nothing to reattach here.
  const joinUrl = await mintDesktopUrl(cfg, box.id);
  if (!joinUrl) throw new Error("box desktop link could not be created");
  return { joinUrl, state: ready.state ?? null };
}

/** Mint a human-control URL without changing provider lifecycle or guest
 * processes. This is the only join path allowed while a bot turn is active. */
export async function joinReadyBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) throw Object.assign(new Error("no computer yet — provision it first"), { status: 409 });
  if (!READY.has(box.state)) {
    throw Object.assign(
      new Error("the cloud computer is sleeping or starting — interrupt the bot before waking it"),
      { status: 409 },
    );
  }
  const joinUrl = await mintDesktopUrl(cfg, box.id);
  if (!joinUrl) throw new Error("box desktop link could not be created");
  return { joinUrl, state: box.state ?? null };
}

/** Archive the bot's box now (billing pauses, disk survives). */
export async function sleepBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot");
  await stopBox(cfg, box.id);
  forgetBoxId(box.id);
  return { ok: true };
}
