import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";

export const LEASE_MS = 20_000;
export function createDesktopKey() {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
export const fingerprint = key => createHash("sha256").update(key).digest("hex").match(/.{4}/g).join(" ");
const fields = ["action", "epoch", "workspace", "device", "origin", "publicKey", "nonce", "expires", "botId", "threadId", "mode", "grantId"];
export const signingBytes = claim => Buffer.from(JSON.stringify(fields.map(field => claim[field] ?? null)));
export function signedRequest(key, scope, now = Date.now()) {
  const claim = { ...scope, publicKey: key.publicKey, nonce: randomUUID(), expires: now + 15_000 };
  return { claim, signature: sign(null, signingBytes(claim), key.privateKey).toString("base64") };
}
export function verifyRequest(packet, context, now = Date.now()) {
  const c = packet?.claim;
  if (!c || !["enroll", "status", "full", "renew", "cancel"].includes(c.action) ||
      !Number.isSafeInteger(c.expires) || c.expires <= now || c.expires > now + 30_000 ||
      !/^[a-f0-9-]{36}$/.test(c.nonce) || c.workspace !== context.workspace ||
      c.device !== context.device || c.origin !== context.origin || c.epoch !== context.epoch ||
      typeof c.publicKey !== "string" || c.publicKey.length > 100 ||
      typeof packet.signature !== "string" || packet.signature.length > 100) throw new Error("Invalid desktop approval proof");
  const key = createPublicKey({ key: Buffer.from(c.publicKey, "base64"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, signingBytes(c), key, Buffer.from(packet.signature, "base64"))) {
    throw new Error("Invalid desktop approval signature");
  }
  if (["full", "renew", "cancel"].includes(c.action) &&
      (typeof c.botId !== "string" || !/^[\w-]{1,120}$/.test(c.botId) || typeof c.threadId !== "string" || !/^[\w-]{1,120}$/.test(c.threadId) || c.mode !== "full" ||
       !/^[a-f0-9-]{36}$/.test(c.grantId))) throw new Error("Invalid conversation approval scope");
  return c;
}
export const bindingId = c => createHash("sha256").update(JSON.stringify([c.workspace, c.device, c.origin, c.publicKey])).digest("hex");

/** Only Electron main owns this object. HTTP can propose a key, but cannot
 * call authorize. Keys and owner bindings live in the OS-encrypted store. */
export function createRemoteApprovalAuthority({ read, update, execute, validate, now = Date.now }) {
  const pending = new Map();
  const seen = new Map();
  const active = new Map();
  function prune() {
    for (const [id, expiry] of seen) if (expiry <= now()) seen.delete(id);
    for (const [id, row] of pending) if (row.expires <= now()) pending.delete(id);
  }
  async function cancel(id) {
    const row = active.get(id);
    if (!row) return;
    active.delete(id);
    clearTimeout(row.timer);
    // Serialize recovery behind the in-flight five-step exchange.
    await row.work.catch(() => {});
    await execute(row.context, row.claim, "ask");
  }
  function arm(id, row) {
    clearTimeout(row.timer);
    row.timer = setTimeout(() => { void cancel(id).catch(() => {}); }, LEASE_MS);
    row.timer.unref?.();
  }
  return {
    pending() { prune(); return [...pending.entries()].map(([id, row]) => ({ id, ...row })); },
    bindings() { return Object.entries(read().remoteApprovalBindings ?? {}).map(([id, row]) => ({ id, ...row })); },
    async authorize(id) {
      prune();
      const row = pending.get(id);
      if (!row) throw new Error("Enrollment expired; request it again on the laptop");
      await validate(row.context);
      if (row.expires <= now()) throw new Error("Enrollment expired");
      await update(doc => ({ ...doc, remoteApprovalBindings: { ...doc.remoteApprovalBindings,
        [id]: { workspace: row.claim.workspace, device: row.claim.device, origin: row.claim.origin,
          publicKey: row.claim.publicKey, fingerprint: fingerprint(row.claim.publicKey) } } }));
      pending.delete(id);
    },
    async revoke(id) {
      await update(doc => {
        const bindings = { ...doc.remoteApprovalBindings };
        delete bindings[id];
        return { ...doc, remoteApprovalBindings: bindings };
      });
      // Revocation is already durable. If the private port is unavailable,
      // the server journal/lease still recovers the scope to Ask.
      await Promise.allSettled([...active].filter(([, row]) => row.binding === id).map(([grant]) => cancel(grant)));
    },
    async handle(packet, context) {
      prune();
      const c = verifyRequest(packet, context, now());
      if (seen.has(c.nonce) || seen.size >= 4096) throw new Error("Desktop proof replayed or rate limited");
      seen.set(c.nonce, c.expires);
      const id = bindingId(c);
      if (c.action === "enroll") {
        if (pending.size >= 20 && !pending.has(id)) throw new Error("Too many pending enrollments");
        pending.set(id, { claim: c, context, expires: now() + 120_000 });
        return { fingerprint: fingerprint(c.publicKey), pending: true };
      }
      const bound = read().remoteApprovalBindings?.[id];
      if (!bound) throw new Error("Authorize this laptop in the host app's Server menu first");
      if (c.action === "status") return { available: true };
      if (c.action === "cancel") {
        const row = active.get(c.grantId);
        if (row && (row.binding !== id || row.claim.botId !== c.botId || row.claim.threadId !== c.threadId)) throw new Error("Wrong grant target");
        await cancel(c.grantId);
        return { cancelled: true };
      }
      if (c.action === "renew") {
        const row = active.get(c.grantId);
        if (!row || row.binding !== id || row.claim.botId !== c.botId || row.claim.threadId !== c.threadId) throw new Error("Grant ended");
        arm(c.grantId, row);
        return { renewed: true };
      }
      if (active.has(c.grantId) || [...active.values()].some(row => row.claim.botId === c.botId && (row.inFlight || row.claim.threadId === c.threadId))) throw new Error("Another desktop grant is active for this bot");
      const row = { claim: c, context, binding: id, work: null, timer: null, inFlight: true };
      active.set(c.grantId, row);
      row.work = Promise.resolve().then(() => execute(context, c, "full"));
      arm(c.grantId, row);
      try {
        const bot = await row.work;
        row.inFlight = false;
        if (!active.has(c.grantId) || !read().remoteApprovalBindings?.[id]) throw new Error("Desktop grant was cancelled");
        return { bot };
      } catch (error) {
        await cancel(c.grantId);
        throw error;
      }
    },
    async stop() { await Promise.all([...active.keys()].map(cancel)); },
  };
}
