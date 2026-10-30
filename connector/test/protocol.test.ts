import { describe, expect, it } from "vitest";

import { cloudRequestSignature as homeSignature } from "../../server/cloud-home.ts";
import { cloudRequestSignature, summarizeHealth } from "../src/home-health.ts";
import { checkEnrollCode, checkEnrollResponse, checkHomeEnv, checkJob, checkTransferUrl, JOB_TYPES, REQUIRED_HOME_ENV } from "../src/protocol.ts";

const HOME = `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"a".repeat(64)}`;
const CONNECTOR = `ghcr.io/milind-soni/mausbot-connector@sha256:${"b".repeat(64)}`;
const env = {
  OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
  OMB_PUBLIC_URL: "https://acme.example.test", OMB_CLOUD_BOOTSTRAP_SECRET: "S".repeat(43),
};

describe("the connector protocol", () => {
  it("takes a job only with a valid id, a known type and exactly that type's arguments", () => {
    expect(checkJob({ id: "j1", type: "start", args: { image: HOME, env } })).toMatchObject({ ok: true, job: { id: "j1", type: "start" } });
    expect(checkJob({ id: "j2", type: "status" })).toEqual({ ok: true, job: { id: "j2", type: "status", args: {} } });
    expect(checkJob({ id: "j3", type: "shell", args: { command: "id" } })).toMatchObject({ ok: false, id: "j3", code: "unknown_job" });
    expect(checkJob({ id: "j4", type: "status", args: { verbose: true } })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(checkJob({ id: "j5", type: "update", args: { image: HOME, force: true } })).toMatchObject({ ok: false, code: "invalid_args", message: 'unknown argument "force"' });
    for (const bad of [null, [], "status", { type: "status" }, { id: "", type: "status" }, { id: "x".repeat(65), type: "status" }, { id: "a b", type: "status" }]) {
      expect(checkJob(bad)).toMatchObject({ ok: false, id: null, code: "invalid_job" });
    }
    expect(JOB_TYPES).toEqual(["start", "stop", "restart", "update", "status", "backup", "restore", "export-disk", "import-disk", "host-health", "self-update"]);
  });

  it("runs only our images, and only by digest: the home's for the home, the connector's for itself", () => {
    const image = (type: "start" | "update" | "self-update", value: string) => checkJob({ id: "j", type, args: type === "start" ? { image: value, env } : { image: value } }).ok;
    expect(image("start", HOME)).toBe(true);
    expect(image("update", HOME)).toBe(true);
    expect(image("self-update", CONNECTOR)).toBe(true);
    for (const value of [
      "ghcr.io/milind-soni/openmausbot-cloud-home:latest", "ghcr.io/milind-soni/openmausbot-cloud-home:v0.1.130",
      `ghcr.io/someone-else/openmausbot-cloud-home@sha256:${"a".repeat(64)}`, `docker.io/library/ubuntu@sha256:${"a".repeat(64)}`,
      `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"A".repeat(64)}`, `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"a".repeat(63)}`,
      `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"a".repeat(64)} --privileged`, `ghcr.io/milind-soni/openmausbot@sha256:${"a".repeat(64)}`,
    ]) {
      expect(image("start", value), value).toBe(false);
      expect(image("update", value), value).toBe(false);
    }
    expect(image("update", CONNECTOR)).toBe(false);
    expect(image("self-update", HOME)).toBe(false);
  });

  it("starts a home only with its contract, OMB_ settings the image does not own, and one-line values, and never echoes a value", () => {
    expect(checkHomeEnv(env)).toEqual({ ok: true, value: env });
    expect(checkHomeEnv({ ...env, OMB_COMPOSIO_BROKER_URL: "http://127.0.0.1:9", OMB_HIGHLEVEL_RELAY_URL: "off", OMB_CLOUD_TEAM_ID: "t1" }).ok).toBe(true);
    for (const name of REQUIRED_HOME_ENV) {
      const { [name]: _dropped, ...rest } = env;
      expect(checkHomeEnv(rest), name).toMatchObject({ ok: false, message: `env must set ${name}` });
    }
    const refused = (extra: Record<string, unknown>) => checkHomeEnv({ ...env, ...extra });
    for (const name of ["FLY_APP_NAME", "PATH", "NODE_OPTIONS", "HOME", "LD_PRELOAD", "omb_lower", "OMB_"]) expect(refused({ [name]: "x" }).ok, name).toBe(false);
    for (const name of ["OMB_CLOUD_EDGE_HOLD", "OMB_CLOUD_EDGE_BIN", "OMB_CLOUD_HARDEN", "OMB_DATA_DIR", "OMB_PORT", "OMB_CLOUD_SECRETS_FD"]) {
      expect(refused({ [name]: "x" }), name).toMatchObject({ ok: false, message: `env name ${name} is the image's own setting` });
    }
    const secret = "T0P-SECRET-VALUE";
    for (const value of [`${secret}\nOMB_CLOUD_HARDEN=0`, `${secret}\r`, `${secret}\0`, 42, null, "x".repeat(8193)]) {
      const result = refused({ OMB_CLOUD_X_TOKEN: value });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(refused({ OMB_CLOUD_ROLE: "admin" }).ok).toBe(false);
    expect(refused({ OMB_PUBLIC_URL: "http://acme.example.test" }).ok).toBe(false);
    expect(refused({ OMB_PUBLIC_URL: "https://acme.example.test/path" }).ok).toBe(false);
    expect(checkHomeEnv(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`OMB_X${i}`, "v"]))).ok).toBe(false);
    expect(checkHomeEnv([]).ok).toBe(false);
  });

  it("transfers only over https, or http to a test Admin on this machine, never with credentials in the address", () => {
    expect(checkTransferUrl("https://storage.example.test/disk.tar.gz?sig=abc")).toEqual({ ok: true, value: "https://storage.example.test/disk.tar.gz?sig=abc" });
    expect(checkTransferUrl("http://127.0.0.1:8123/disk").ok).toBe(true);
    for (const url of ["http://storage.example.test/disk", "file:///etc/shadow", "https://user:pass@storage.example.test/", "not a url", "ftp://x/y", 7]) {
      expect(checkTransferUrl(url).ok, String(url)).toBe(false);
    }
  });

  it("keeps an enrolment answer only when every field is the Admin's shape, and a code only as MausBot shows it", () => {
    const good = { serverId: "srv_1a2b", cloudId: "cloud_3c4d", agentToken: "ombs_" + "t".repeat(43) };
    expect(checkEnrollResponse(good)).toEqual({ ok: true, value: good });
    expect(checkEnrollResponse({ ...good, extra: 1 })).toEqual({ ok: true, value: good });
    for (const bad of [null, {}, { ...good, agentToken: "short" }, { ...good, serverId: "a/b" }, { ...good, cloudId: 3 }]) expect(checkEnrollResponse(bad).ok).toBe(false);
    expect(checkEnrollCode("MB-1A2B-3C4D").ok).toBe(true);
    for (const code of ["", "abc", "MB 1A2B", "MB-1A2B;rm -rf /", "x".repeat(200)]) expect(checkEnrollCode(code).ok, code).toBe(false);
  });

  it("signs a health read byte for byte as the Admin and the home do", () => {
    const secret = "K".repeat(43);
    for (const [method, target, body] of [["GET", "/api/cloud/health", ""], ["POST", "/api/cloud/pairing", "{\"label\":\"x\"}"], ["GET", "/api/cloud/box?x=1", ""]] as const) {
      expect(cloudRequestSignature(secret, "1793183627", "nonce-0123456789ab", method, target, body)).toBe(homeSignature(secret, "1793183627", "nonce-0123456789ab", method, target, body));
    }
  });

  it("reduces a health report to fixed fields, healthy only when it names the image the home should run", () => {
    const report = { v: 1, version: "0.1.130", image: HOME, box: { box: "bwrap", reason: null, checks: "32/32", failed: [], boxed: 3 }, secretish: "x" };
    expect(summarizeHealth(200, report, HOME, 5)).toEqual({ ok: true, version: "0.1.130", image: HOME, box: { box: "bwrap", checks: "32/32", failed: [] }, at: 5 });
    expect(summarizeHealth(200, report, `${HOME.slice(0, -1)}b`, 5).ok).toBe(false);
    expect(summarizeHealth(401, { error: "invalid_signature" }, HOME, 5)).toMatchObject({ ok: false, image: null, box: null });
    expect(summarizeHealth(0, null, HOME, 5).ok).toBe(false);
  });
});
