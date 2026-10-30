// Reads the home's health the way the Admin does: a GET of /api/cloud/health signed with the home's bootstrap secret,
// through the edge on the server's loopback, under the home's public name (the edge answers no other).
import { createHash, createHmac, randomBytes } from "node:crypto";
import { request } from "node:http";

import type { HomeHealth } from "./protocol.ts";

export const HEALTH_PATH = "/api/cloud/health";

/** Must match server/cloud-home.ts cloudRequestSignature (the connector test holds them equal). */
export function cloudRequestSignature(secret: string, timestamp: string, nonce: string, method: string, target: string, body: Buffer | string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\n${method}\n${target}\n${bodyHash}`).digest("base64url");
}

export function signedHeaders(secret: string, method: string, target: string, body = "", now = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  const nonce = randomBytes(18).toString("base64url");
  return {
    "x-omb-cloud-timestamp": timestamp,
    "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudRequestSignature(secret, timestamp, nonce, method, target, body)}`,
  };
}

export interface HealthTarget {
  port: number;
  publicHost: string;
  secret: string;
}

export type HealthRead = (target: HealthTarget) => Promise<{ status: number; report: Record<string, unknown> | null }>;

export const readHealth: HealthRead = (target) => new Promise((resolve) => {
  const req = request({
    host: "127.0.0.1",
    port: target.port,
    method: "GET",
    path: HEALTH_PATH,
    timeout: 10_000,
    headers: { host: target.publicHost, ...signedHeaders(target.secret, "GET", HEALTH_PATH) },
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      let report: Record<string, unknown> | null = null;
      try { report = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { report = null; }
      resolve({ status: res.statusCode ?? 0, report });
    });
    res.on("error", () => resolve({ status: 0, report: null }));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => resolve({ status: 0, report: null }));
  req.end();
});

const text = (value: unknown, max = 200) => (typeof value === "string" && value.length <= max ? value : null);

/** The fixed fields of a health report; `ok` once it answers and names the image the home should run. */
export function summarizeHealth(status: number, report: Record<string, unknown> | null, expectedImage: string | null, at = Date.now()): HomeHealth {
  const box = report && typeof report.box === "object" && report.box !== null ? report.box as Record<string, unknown> : null;
  const image = text(report?.image, 300);
  return {
    ok: status === 200 && report !== null && (expectedImage === null || image === expectedImage),
    version: text(report?.version, 40),
    image,
    box: box ? {
      box: text(box.box, 40),
      checks: text(box.checks, 20),
      failed: Array.isArray(box.failed) ? box.failed.filter((id): id is string => typeof id === "string" && id.length <= 80).slice(0, 64) : [],
    } : null,
    at,
  };
}

/** The home's public name, which the edge answers for. */
export function publicHost(env: Record<string, string>): string {
  return new URL(env.OMB_PUBLIC_URL).hostname;
}
