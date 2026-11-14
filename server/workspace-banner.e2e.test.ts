// A real Team Cloud with an owner and a member: the workspace's banner picture is changed by its Super admin only,
// seen by everyone signed in to the team, and never served to anyone who isn't. This computer's own server and My Cloud
// beside it: the desktop app's own page and a Cloud's owner change their own.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

/** Small pictures a real encoder made, each carrying a camera make and model, a colour profile and text (EXIF, ICC, and a
 * comment or XMP or text chunks). */
const sample = (name: string) => readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url));
const JPEG_WITH_METADATA = sample("banner-metadata.jpg"), PNG_WITH_METADATA = sample("banner-metadata.png");

const ADA = { email: "ada@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const BANNER = "/api/workspace/banner";

let fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", bob = "";

const banner = (token?: string) => fetch(`${team.base}${BANNER}`, { headers: { ...fx.edge, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
const put = (token: string, bytes: Buffer, type = "image/png") => team.as(token, "PUT", BANNER, new Uint8Array(bytes), { "content-type": type });

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-banner-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-2", name: "Acme" } });
  team = fx.team!;
  ada = (await team.pair(ADA)).token!;
  bob = (await team.pair(BOB)).token!;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
}, hostTimeout(60_000));

it("its Super admin sets the banner, a member sees it and can't change it, and nobody signed out gets it", async () => {
  expect((await banner(ada)).status, "none yet").toBe(404);
  const saved = await put(ada, PNG_WITH_METADATA);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.banner).toMatchObject({ version: expect.stringMatching(/^[\w-]{16}$/), width: 12, height: 6 });

  const seen = await banner(bob);
  expect([seen.status, seen.headers.get("content-type"), seen.headers.get("cache-control")]).toEqual([200, "image/png", "private, no-cache"]);
  const bytes = Buffer.from(await seen.arrayBuffer());
  expect(bytes.subarray(0, 8)).toEqual(PNG_WITH_METADATA.subarray(0, 8));
  expect(bytes.includes("Secret"), "the camera, the author and the profile stay behind").toBe(false);
  expect((await team.as(bob, "GET", "/api/config")).body.workspaceBanner).toEqual(saved.body.banner);

  for (const [who, token] of [["signed out", undefined], ["a made-up token", "omb_not-a-session"]] as const) {
    const refused = await banner(token);
    expect(refused.status, who).toBeGreaterThanOrEqual(400);
    expect(refused.headers.get("content-type"), who).not.toBe("image/png");
  }

  const changed = await put(bob, JPEG_WITH_METADATA, "image/jpeg");
  expect(changed.status, "a member sees it but doesn't change it").toBe(403);
  expect((await team.as(bob, "DELETE", BANNER)).status).toBe(403);
  expect((await banner(bob)).headers.get("content-type"), "the banner kept stays").toBe("image/png");
}, hostTimeout(60_000));

it("a picture that isn't one is refused plainly, and removing the banner leaves none", async () => {
  const refused = await team.as(ada, "PUT", BANNER, new Uint8Array(Buffer.from("<svg/>")), { "content-type": "image/svg+xml" });
  expect([refused.status, refused.body.refusal, refused.body.error]).toEqual([415, "format", "Use a PNG, JPEG or WebP picture."]);
  expect((await team.as(ada, "DELETE", BANNER)).status).toBe(200);
  expect((await banner(bob)).status).toBe(404);
  expect((await team.as(bob, "GET", "/api/config")).body.workspaceBanner ?? null).toBeNull();
}, hostTimeout(60_000));

/** A request as the desktop app's own page sends it to this computer's server: the window's session adds the owner's
 * header, and Chromium marks the page as the server's own. */
const ownPage = (path: string, init: RequestInit = {}) => fetch(`${fx.desktopBase}${path}`, { ...init, headers: { ...init.headers as Record<string, string>,
  "x-openmausbot-desktop-owner": fx.ownerCapability, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
  ...(init.method && init.method !== "GET" ? { origin: fx.desktopBase } : {}) } });
const pictureOf = async (send: (path: string) => Promise<Response>) => ((await (await send("/api/config")).json()) as { workspaceBanner?: unknown }).workspaceBanner ?? null;

it("this computer's own page: the person is its owner, keeps a picture on this computer's own server, and Remove clears it", async () => {
  const session = (await (await ownPage("/api/auth/session")).json()) as { kind: string; scopes: string[]; trust?: string };
  expect([session.kind, session.trust, session.scopes.includes("admin")], "the app's own page is this server's owner (useOwnerOrAdmin: true)")
    .toEqual(["loopback", undefined, true]);
  expect(await pictureOf(ownPage), "plain until the person picks one").toBeNull();

  const saved = await ownPage(BANNER, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array(PNG_WITH_METADATA) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const kept = ((await saved.json()) as { banner: unknown }).banner;
  expect(await pictureOf(ownPage), "every page of this computer hears of it").toEqual(kept);
  const shown = await ownPage(BANNER);
  expect([shown.status, shown.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect(Buffer.from(await shown.arrayBuffer()).includes("Secret"), "checked again by this computer's server: no camera, author or profile").toBe(false);

  const browser = await fetch(`${fx.desktopBase}${BANNER}`, { method: "DELETE", headers: { "sec-fetch-site": "same-origin", origin: fx.desktopBase } });
  expect(browser.status, "a browser on this computer is not its owner").toBe(401);
  expect(await pictureOf(ownPage)).toEqual(kept);
  expect((await ownPage(BANNER, { method: "DELETE" })).status).toBe(200);
  expect(await pictureOf(ownPage), "Remove: plain again").toBeNull();
  expect((await ownPage(BANNER)).status).toBe(404);
}, hostTimeout(60_000));

it("a solo Cloud's owner changes My Cloud's picture, and Remove clears it", async () => {
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${fx.cloudBase}${path}`, { ...init,
    headers: { ...init.headers as Record<string, string>, ...fx.edge, authorization: `Bearer ${fx.owner}` } });
  const session = (await (await asOwner("/api/auth/session")).json()) as { kind: string; scopes: string[] };
  expect([session.kind, session.scopes.includes("admin")], "the owner's own session (useOwnerOrAdmin: true)").toEqual(["session", true]);
  const saved = await asOwner(BANNER, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(JPEG_WITH_METADATA) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  expect(await pictureOf(asOwner)).toEqual(((await saved.json()) as { banner: unknown }).banner);
  expect(await pictureOf(ownPage), "My Cloud's picture stays on My Cloud").toBeNull();
  expect((await asOwner(BANNER, { method: "DELETE" })).status).toBe(200);
  expect(await pictureOf(asOwner)).toBeNull();
}, hostTimeout(60_000));
