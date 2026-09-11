import { z } from "zod";
import type { FleetReply } from "../../../server/fleet-client.ts";
import { createPortalAuth, type Mail, type PortalConfig } from "./auth.ts";
import { ProviderGateway } from "./gateway.ts";
import { normalizeEmail, type PortalStore, type Role } from "./store.ts";

type Fleet = (method: string, path: string, body?: unknown) => Promise<FleetReply>;
const emailSchema = z.email().max(320).transform(normalizeEmail);
const roleSchema = z.enum(["admin", "member"]);
const slugSchema = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const proofSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const providerSchema = z.enum(["anthropic", "openrouter"]);
const createSchema = z.object({ slug: slugSchema, name: z.string().trim().min(1).max(80), models: z.array(z.string()).default([]), openrouterModels: z.array(z.string()).default([]) });
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };

export async function createPortal(options: {
  config: PortalConfig; store: PortalStore; fleet: Fleet; sendMail: (mail: Mail) => Promise<void>;
  licensed: () => boolean; providerFetch?: typeof fetch;
}) {
  const { config, store, fleet, sendMail } = options;
  const auth = await createPortalAuth(config, store, sendMail);
  const gateway = new ProviderGateway(store, config.secret, options.providerFetch, options.licensed);
  // ponytail: one portal process and one queue per fleet; use a durable job worker if multi-host provisioning becomes necessary.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = tail.then(work, work); tail = next.catch(() => undefined); return next; };
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const admin = (email: string) => config.admins.includes(email);
  const operate = async (method: string, path: string, body?: unknown) => {
    let reply: FleetReply;
    try { reply = await fleet(method, path, body); } catch { return fail(502, "The workspace manager is unavailable. No success has been recorded; check its status before retrying."); }
    if (reply.status < 200 || reply.status >= 300) fail(502, "The workspace manager could not finish this operation. Check the server's fleet log before retrying.");
    return reply.body;
  };
  const requireWorkspace = (slug: string) => store.workspace(slug) ?? fail(404, "Workspace not found.");
  const canManage = (slug: string, email: string) => {
    requireWorkspace(slug);
    if (!admin(email) && store.member(slug, email)?.role !== "admin") fail(403, "Workspace administrator access is required.");
  };
  const syncMember = (slug: string, email: string, role: Role) => operate("POST", `/workspaces/${slug}/users`, { action: "add", email, chatOnly: role === "member" });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (url.origin !== config.url) return json({ error: "Unrecognized portal origin." }, 403);
      if (path === "/api/health") return json({ ok: true, service: "openmausbot-admin" });
      if (!options.licensed()) return json({ error: "An active Admin license is required." }, 403);
      if (path === "/api/public/config" && request.method === "GET") return json({ name: config.name, providers: [...(config.google ? ["google"] : []), ...(config.github ? ["github"] : [])] });
      const gatewayPath = /^\/api\/gateway\/([a-z0-9-]+)\/(anthropic|openrouter)(\/v1\/.*)$/.exec(path);
      if (gatewayPath) return await gateway.handle(request, gatewayPath[1], gatewayPath[3], providerSchema.parse(gatewayPath[2]));
      // Backchannel endpoints accept only high-entropy, workspace-bound proofs. Browser cookies are never authentication here.
      if (request.method === "POST" && ["/api/handoff/consume", "/api/handoff/check"].includes(path)) {
        if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Send JSON." }, 415);
        const body = await request.json();
        if (path.endsWith("/consume")) {
          const input = z.object({ workspace: slugSchema, code: proofSchema, verifier: proofSchema }).parse(body);
          const grant = store.consume(input.code, input.workspace, input.verifier);
          return grant ? json(grant) : json({ error: "This sign-in link expired or was already used. Start again." }, 401);
        }
        const input = z.object({ workspace: slugSchema, grant: proofSchema }).parse(body);
        const member = store.grant(input.grant, input.workspace);
        return member ? json({ email: member.email, role: member.role }) : json({ error: "Workspace access has ended." }, 401);
      }
      if (path.startsWith("/api/auth/")) return await auth.handler(request);
      if (!["GET", "HEAD"].includes(request.method)) {
        if (request.headers.get("origin") !== config.url) return json({ error: "A same-origin request is required." }, 403);
        if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Send JSON." }, 415);
      }
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session || !session.user.emailVerified) return json({ error: "Sign in with your verified email to continue." }, 401);
      const email = normalizeEmail(session.user.email);
      if (path === "/api/me") return json({ email, name: session.user.name, platformAdmin: admin(email) });
      if (path === "/api/workspaces" && request.method === "GET") return json({ workspaces: store.workspaces().filter((workspace) => admin(email) || store.member(workspace.slug, email)).map((workspace) => ({ ...workspace, role: store.member(workspace.slug, email)?.role ?? null, models: gateway.access(workspace.slug), openrouterModels: gateway.access(workspace.slug, "openrouter") })) });
      if (path === "/api/workspaces" && request.method === "POST") {
        if (!admin(email)) return json({ error: "Only a platform administrator can create workspaces." }, 403);
        const input = createSchema.parse(await request.json());
        gateway.validateModels(input.models);
        gateway.validateModels(input.openrouterModels, "openrouter");
        return await serial(async () => {
          if (store.workspace(input.slug)) return json({ error: "This workspace name is already reserved." }, 409);
          const fleetInfo = await operate("GET", "/workspaces") as { domain?: unknown; workspaces?: { slug: string }[] };
          const domain = z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/).parse(fleetInfo.domain);
          if (fleetInfo.workspaces?.some((workspace) => workspace.slug === input.slug)) return json({ error: "This name already belongs to an existing fleet workspace." }, 409);
          const host = `${input.slug}.${domain}`;
          if (host === new URL(config.url).hostname) return json({ error: "This name is reserved for the Admin portal." }, 409);
          gateway.validateModels(input.models);
          gateway.validateModels(input.openrouterModels, "openrouter");
          store.db.prepare("INSERT INTO portal_workspace VALUES (?,?,?,?,?,NULL)").run(input.slug, input.name, host, "provisioning", store.now());
          store.audit(email, "workspace.create.started", input.slug);
          try {
            const key = gateway.issue(input.slug, input.models, input.openrouterModels);
            await operate("POST", "/workspaces", {
              slug: input.slug, admins: [config.admins[0]], members: [], portalUrl: config.url,
              anthropicUrl: `${config.url}/api/gateway/${input.slug}/anthropic`, anthropicKey: key,
              openrouterUrl: `${config.url}/api/gateway/${input.slug}/openrouter/v1`, openrouterKey: key,
              openrouterModels: input.openrouterModels, openrouterDefault: input.models.length === 0 && input.openrouterModels.length > 0,
            });
            store.db.prepare("UPDATE portal_workspace SET status = 'running' WHERE slug = ?").run(input.slug);
            store.audit(email, "workspace.create.completed", input.slug);
            return json({ workspace: store.workspace(input.slug) }, 201);
          } catch {
            store.db.prepare("UPDATE portal_workspace SET status = 'error', error = ? WHERE slug = ?")
              .run("Provisioning did not finish. Check the fleet log; do not reuse this name or delete its data blindly.", input.slug);
            store.audit(email, "workspace.create.failed", input.slug);
            return json({ error: "Workspace creation did not finish. Its name is reserved for recovery.", workspace: store.workspace(input.slug) }, 502);
          }
        });
      }
      const invitationMatch = /^\/api\/invitations\/([\w-]+)(?:\/(accept|revoke|resend))?$/.exec(path);
      if (invitationMatch) {
        const invitation = store.invitation(invitationMatch[1]) ?? fail(404, "Invitation not found.");
        const workspace = requireWorkspace(invitation.workspace);
        const action = invitationMatch[2];
        if (request.method === "GET" && !action) {
          if (email !== invitation.email) return json({ error: "This invitation is for a different email. Switch accounts to accept it.", wrongAccount: true }, 403);
          return json({ invitation, workspace: { name: workspace.name, slug: workspace.slug } });
        }
        if (request.method !== "POST") return json({ error: "Not found." }, 404);
        if (action === "accept") return await serial(async () => {
          const current = store.invitation(invitation.id)!;
          if (email !== current.email) return json({ error: "This invitation is for a different email. Switch accounts to accept it." }, 403);
          if (current.status !== "pending" || current.expiresAt <= store.now()) return json({ error: "This invitation is no longer available. Ask your administrator for a new one." }, 409);
          if (requireWorkspace(workspace.slug).status !== "running") return json({ error: "This workspace is not ready yet." }, 409);
          await syncMember(workspace.slug, email, current.role);
          store.accept(current);
          store.audit(email, "invitation.accepted", workspace.slug);
          return json({ workspace: workspace.slug, url: `https://${workspace.host}/api/auth/hosted/start` });
        });
        canManage(workspace.slug, email);
        if (action === "revoke") return await serial(async () => {
          canManage(workspace.slug, email);
          store.db.prepare("UPDATE portal_invitation SET status = 'revoked' WHERE id = ? AND status = 'pending'").run(invitation.id);
          store.audit(email, "invitation.revoked", workspace.slug, invitation.email);
          return json({ ok: true });
        });
        if (action === "resend") {
          if (invitation.status !== "pending" || invitation.expiresAt <= store.now()) return json({ error: "Create a new invitation; this one is no longer pending." }, 409);
          await invitationMail(invitation.id, invitation.email, workspace.name);
          store.audit(email, "invitation.resent", workspace.slug, invitation.email);
          return json({ ok: true });
        }
      }
      const match = /^\/api\/workspaces\/([a-z0-9-]+)(?:\/(people|invitations|members|suspend|resume|connect|providers))?$/.exec(path);
      if (match) {
        const slug = match[1], action = match[2];
        const workspace = requireWorkspace(slug);
        if (action === "connect" && request.method === "POST") {
          const input = z.object({ challenge: proofSchema, state: proofSchema }).parse(await request.json());
          if (!store.member(slug, email) || workspace.status !== "running") return json({ error: "Accept an invitation to this workspace before opening it." }, 403);
          const code = store.handoff(slug, email, input.challenge);
          const callback = new URL(`https://${workspace.host}/api/auth/hosted/callback`);
          callback.searchParams.set("state", input.state); callback.searchParams.set("code", code);
          return json({ url: callback.href });
        }
        canManage(slug, email);
        if (action === "people" && request.method === "GET") return json(store.people(slug));
        if (action === "invitations" && request.method === "POST") {
          const input = z.object({ email: emailSchema, role: roleSchema }).parse(await request.json());
          return await serial(async () => {
            canManage(slug, email);
            if (store.workspace(slug)?.status !== "running") return json({ error: "Wait until this workspace is ready before inviting people." }, 409);
            if (store.member(slug, input.email)) return json({ error: "This person is already a member. Change their role instead." }, 409);
            const invitation = store.invite(slug, input.email, input.role);
            store.audit(email, "invitation.created", slug, input.email);
            try { await invitationMail(invitation.id, invitation.email, workspace.name); }
            catch { return json({ invitation, error: "The invitation was saved, but email delivery failed. Use Resend after checking mail settings." }, 502); }
            return json({ invitation }, 201);
          });
        }
        if (action === "members" && ["POST", "DELETE"].includes(request.method)) {
          const input = z.object({ email: emailSchema, role: roleSchema.optional() }).parse(await request.json());
          return await serial(async () => {
            canManage(slug, email);
            const target = store.member(slug, input.email) ?? fail(404, "Member not found.");
            const removing = request.method === "DELETE";
            if (!removing && !input.role) fail(400, "Choose a role.");
            if (target.role === "admin" && (removing || input.role === "member") && store.people(slug).members.filter((person) => person.role === "admin").length === 1) fail(409, "Assign another workspace administrator first.");
            // Widening must be acknowledged by the runtime before it grants
            // portal administration. Narrowing remains central-first even if
            // the runtime is offline, so old grants cannot retain authority.
            const promoting = !removing && target.role === "member" && input.role === "admin";
            if (promoting) await syncMember(slug, target.email, "admin");
            store.revokeGrants(slug, target.email);
            // Removal takes effect centrally even if syncing the runtime fails.
            if (removing) store.db.prepare("DELETE FROM portal_member WHERE workspace = ? AND email = ?").run(slug, target.email);
            else store.db.prepare("UPDATE portal_member SET role = ? WHERE workspace = ? AND email = ?").run(input.role!, slug, target.email);
            store.audit(email, removing ? "member.removed" : "member.role.changed", slug, target.email);
            if (removing) await operate("POST", `/workspaces/${slug}/users`, { action: "remove", email: target.email });
            else if (!promoting) await syncMember(slug, target.email, input.role!);
            return json({ ok: true });
          });
        }
        if (!admin(email)) return json({ error: "Only a platform administrator can change hosting or provider access." }, 403);
        if (action === "providers" && request.method === "POST") {
          const input = z.object({ models: z.array(z.string()), openrouterModels: z.array(z.string()).optional() }).parse(await request.json());
          return await serial(async () => {
            const models = gateway.validateModels(input.models);
            const openrouterModels = gateway.validateModels(input.openrouterModels ?? gateway.access(slug, "openrouter"), "openrouter");
            if (!["running", "suspended"].includes(requireWorkspace(slug).status)) return json({ error: "Recover this workspace before changing model access." }, 409);
            const previous = gateway.access(slug, "openrouter");
            // Narrow first, widen only after the workspace catalog is written.
            // If syncing fails, removed permissions stay removed; a retry is safe.
            gateway.assign(slug, gateway.access(slug).filter(model => models.includes(model)));
            gateway.assign(slug, previous.filter(model => openrouterModels.includes(model)), "openrouter");
            store.audit(email, "provider.access.restricted", slug);
            if (input.openrouterModels !== undefined) await operate("POST", `/workspaces/${slug}/providers`, { models: openrouterModels });
            gateway.validateModels(models); gateway.validateModels(openrouterModels, "openrouter");
            gateway.assign(slug, models); gateway.assign(slug, openrouterModels, "openrouter");
            store.audit(email, "provider.access.changed", slug);
            return json({ models: gateway.access(slug), openrouterModels: gateway.access(slug, "openrouter") });
          });
        }
        if (["suspend", "resume"].includes(action ?? "") && request.method === "POST") return await serial(async () => {
          const expected = action === "suspend" ? "running" : "suspended";
          if (requireWorkspace(slug).status !== expected) return json({ error: "This workspace requires operator recovery before its hosting state can be changed." }, 409);
          if (action === "suspend") store.db.prepare("UPDATE portal_workspace SET status = 'suspended' WHERE slug = ?").run(slug);
          gateway.revalidate();
          await operate("POST", `/workspaces/${slug}/${action}`);
          if (action === "resume") store.db.prepare("UPDATE portal_workspace SET status = 'running' WHERE slug = ?").run(slug);
          store.audit(email, `workspace.${action}`, slug); return json({ ok: true });
        });
        if (!action && request.method === "DELETE") {
          const body = z.object({ confirm: z.string() }).parse(await request.json());
          if (body.confirm !== slug) return json({ error: "Type the workspace name to confirm." }, 400);
          return await serial(async () => {
            if (!["running", "suspended"].includes(requireWorkspace(slug).status)) return json({ error: "This workspace requires operator recovery; its data has not been removed." }, 409);
            store.db.prepare("UPDATE portal_workspace SET status = 'suspended' WHERE slug = ?").run(slug);
            gateway.revalidate();
            await operate("DELETE", `/workspaces/${slug}`, { keepData: true });
            store.db.prepare("UPDATE portal_workspace SET status = 'retained' WHERE slug = ?").run(slug);
            store.audit(email, "workspace.removed.data-retained", slug); return json({ ok: true });
          });
        }
      }
      const providerMatch = /^\/api\/providers(?:\/(anthropic|openrouter))?$/.exec(path);
      if (providerMatch) {
        if (!admin(email)) return json({ error: "Platform administrator access is required." }, 403);
        const provider = providerSchema.parse(providerMatch[1] ?? "anthropic");
        if (request.method === "GET") return json(providerMatch[1] ? gateway.status(provider) : { providers: [gateway.status(), gateway.status("openrouter")] });
        if (request.method === "POST") { const result = gateway.save(await request.json(), provider); store.audit(email, "provider.updated", undefined, provider); return json(result); }
      }
      if (path === "/api/activity" && request.method === "GET") {
        if (!admin(email)) return json({ error: "Platform administrator access is required." }, 403);
        return json({ activity: store.activity() });
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Check the form fields and try again." }, 400);
      const status = (error as { status?: number }).status;
      return json({ error: status ? (error as Error).message : "The request could not be completed. Check the portal log." }, status ?? 500);
    }
  }
  const invitationMail = (id: string, email: string, name: string) => sendMail({ to: email, subject: `You're invited to ${name}`, text: `You've been invited to ${name}. Sign in using this email address to accept:\n${config.url}/invite/${id}\n\nThis invitation expires in 7 days. It does not connect your email account to any bot.` });
  return { handle, auth, gateway, idle: () => tail };
}
