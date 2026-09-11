import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { createPortal } from "../server/portal.ts";
import { PortalStore } from "../server/store.ts";
import { portalHttpServer } from "../server/http.ts";
import type { Mail } from "../server/auth.ts";

export async function launchFixture() {
  const directory = mkdtempSync(join(tmpdir(), "omb-admin-fixture-"));
  const db = new DatabaseSync(join(directory, "admin.sqlite"));
  const store = new PortalStore(db);
  const mails: Mail[] = [], calls: { method: string; path: string; body?: unknown }[] = [];
  const upstream: Request[] = [];
  const faults = { fleet: false, mail: false, licensed: true };
  const behavior: { beforeFleet?: (method: string, path: string, body?: unknown) => Promise<void>; onMail?: (mail: Mail) => void } = {};
  const fleetWorkspaces = new Set<string>();
  let portal: Awaited<ReturnType<typeof createPortal>>;
  const server = portalHttpServer({ url: "http://127.0.0.1:1", webDir: resolve(import.meta.dirname, "../dist/web"), handle: (request) => portal.handle(request) });
  // Discover a disposable port, then re-create the host-checked server with that exact origin.
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  portal = await createPortal({
    config: { url, secret: randomBytes(48).toString("base64url"), admins: ["operator@example.test"], name: "OpenMausBot" },
    store, licensed: () => faults.licensed,
    sendMail: async (mail) => { if (faults.mail) throw new Error("Fixture mail unavailable"); mails.push(mail); behavior.onMail?.(mail); },
    fleet: async (method, path, body) => {
      calls.push({ method, path, body });
      await behavior.beforeFleet?.(method, path, body);
      if (faults.fleet) return { status: 500, body: { error: "fixture-private-error-never-send" } };
      if (method === "GET" && path === "/workspaces") return { status: 200, body: { domain: "example.test", workspaces: [...fleetWorkspaces].map((slug) => ({ slug })) } };
      if (method === "POST" && path === "/workspaces") fleetWorkspaces.add((body as { slug: string }).slug);
      return { status: 200, body: { ok: true } };
    },
    providerFetch: async (input, init) => {
      upstream.push(new Request(input, init));
      return Response.json({ content: [{ type: "text", text: "Fixture response" }] });
    },
  });
  const http = portalHttpServer({ url, webDir: resolve(import.meta.dirname, "../dist/web"), handle: portal.handle });
  await new Promise<void>((done) => http.listen(port, "127.0.0.1", done));
  class Client {
    cookies = new Map<string, string>();
    async request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
      const response = await fetch(`${url}${path}`, {
        method, redirect: "manual",
        headers: { origin: url, "content-type": "application/json", cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0], index = pair.indexOf("=");
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    }
    async login(email: string) {
      const sent = await this.request("/api/auth/email-otp/send-verification-otp", "POST", { email, type: "sign-in" });
      if (!sent.ok) throw new Error(`Fixture sign-in start failed: ${await sent.text()}`);
      const mail = mails.findLast((message) => message.to === email && message.subject.includes("sign-in code"));
      const otp = /code is (\d{6})/.exec(mail?.text ?? "")?.[1];
      if (!otp) throw new Error("Fixture did not receive a code");
      const verified = await this.request("/api/auth/sign-in/email-otp", "POST", { email, otp });
      if (!verified.ok) throw new Error(`Fixture sign-in failed: ${await verified.text()}`);
    }
  }
  return { url, directory, db, store, portal, mails, calls, faults, behavior, upstream, client: () => new Client(),
    close: async () => { await portal.idle(); portal.gateway.close(); http.closeAllConnections(); await new Promise<void>((done) => http.close(() => done())); db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
