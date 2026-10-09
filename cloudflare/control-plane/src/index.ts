import { z } from "zod";

import { accountSession, createAuth, deleteExpiredVerifications } from "./auth";
import { readConfig, type ControlPlaneConfig } from "./config";
import { errorResponse, HTTPError, json, preflight, secureResponse, withBoundedRequestBody } from "./http";
import { limitedOTPResponse } from "./otp-rate-limit";
import type { CloudflareFetch } from "./cloudflare-api";
import {
  cleanupEndpointForInstallation,
  deleteManagedEndpoint,
  getManagedEndpoint,
  provisionManagedEndpoint,
  sweepManagedEndpointCleanup,
} from "./endpoints";
import { capacityHealth, reportEndpointAccountProblems, scanTunnelCapacity } from "./tunnel-capacity";
import {
  createInstallation,
  installationSelf,
  listInstallations,
  revokeInstallation,
  rotateInstallationCredential,
} from "./installations";

const SIGN_IN_OTP_PATH = "/api/auth/sign-in/email-otp";
const ROTATE_ROUTE = /^\/v1\/installations\/([^/]+)\/credentials\/rotate$/;
const INSTALLATION_ROUTE = /^\/v1\/installations\/([^/]+)$/;

const BETTER_AUTH_ERROR_CODES = new Map([
  ["INVALID_EMAIL", "invalid_email"],
  ["INVALID_OTP", "invalid_otp"],
  ["OTP_EXPIRED", "otp_expired"],
  ["TOO_MANY_ATTEMPTS", "rate_limited"],
  ["USER_NOT_FOUND", "invalid_otp"],
  ["VALIDATION_ERROR", "invalid_request"],
]);
const betterAuthErrorSchema = z.object({ code: z.string() }).loose();

function authStatusErrorCode(status: number): string {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  return "request_failed";
}

async function canonicalAuthResponse(response: Response): Promise<Response> {
  if (response.status >= 500) return errorResponse(500, "internal_error");
  if (response.status < 400 || response.status > 499) return response;

  // Better Auth error bodies are dependency-owned and may contain prose or
  // change shape between releases (its rate limiter currently returns only a
  // `message`). Publish only OpenMausBot's stable, lowercase error contract.
  const payload: unknown = await response.json().catch(() => null);
  const parsed = betterAuthErrorSchema.safeParse(payload);
  const dependencyCode = parsed.success ? parsed.data.code : "";
  const code = BETTER_AUTH_ERROR_CODES.get(dependencyCode) ?? authStatusErrorCode(response.status);
  return errorResponse(response.status, code);
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: ControlPlaneConfig,
  requestId: string,
  cloudflareFetch: CloudflareFetch,
) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return preflight(request, config);

  if (url.pathname.startsWith("/api/auth/")) {
    const limited = await limitedOTPResponse(request, env);
    if (limited) return limited;
    const auth = createAuth(env, ctx, config, requestId);
    const response = await auth.handler(request);
    // Better Auth's inline expired-code cleanup is off (see auth.ts), so
    // sign-in sweeps after responding. It skips 429 and 5xx responses. Other
    // 4xx responses still sweep, including validation errors that never
    // reached Better Auth's cleanup; its per-IP sign-in limit bounds them. The
    // other email-otp routes that check a code no longer sweep; sign-in runs
    // often enough to keep the table bounded.
    if (
      request.method === "POST"
      && url.pathname === SIGN_IN_OTP_PATH
      && response.status !== 429
      && response.status < 500
    ) {
      ctx.waitUntil(deleteExpiredVerifications(auth).catch(() => {
        console.error(JSON.stringify({
          message: "expired verification sweep failed",
          requestId,
          errorCode: "auth_internal",
        }));
      }));
    }
    return canonicalAuthResponse(response);
  }

  const auth = createAuth(env, ctx, config, requestId);
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const session = await accountSession(request, auth);
    if (!session) throw new HTTPError(401, "unauthorized");
    return json({
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/installations") {
    return listInstallations(request, env, auth);
  }
  if (request.method === "POST" && url.pathname === "/v1/installations") {
    return createInstallation(request, env, auth);
  }
  if (request.method === "GET" && url.pathname === "/v1/installations/self") {
    return installationSelf(request, env);
  }
  if (url.pathname === "/v1/installations/self/endpoint") {
    if (request.method === "GET") return getManagedEndpoint(request, env);
    if (request.method === "POST") {
      return provisionManagedEndpoint(request, env, config, cloudflareFetch, requestId);
    }
    if (request.method === "DELETE") {
      return deleteManagedEndpoint(request, env, config, cloudflareFetch, requestId);
    }
  }

  const rotate = url.pathname.match(ROTATE_ROUTE);
  if (request.method === "POST" && rotate) {
    return rotateInstallationCredential(request, rotate[1], env, auth);
  }
  const installation = url.pathname.match(INSTALLATION_ROUTE);
  if (request.method === "DELETE" && installation) {
    const response = await revokeInstallation(request, installation[1], env, auth);
    ctx.waitUntil(cleanupEndpointForInstallation(
      env,
      config,
      installation[1],
      cloudflareFetch,
      requestId,
    ).catch(() => {
      console.error(JSON.stringify({
        message: "revoked installation endpoint cleanup scheduling failed",
        requestId,
        errorCode: "endpoint_internal",
      }));
    }));
    return response;
  }
  return errorResponse(404, "not_found");
}

export function createWorker(cloudflareFetch: CloudflareFetch = fetch) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        let healthConfig: ControlPlaneConfig;
        try {
          healthConfig = readConfig(env);
        } catch {
          return secureResponse(errorResponse(503, "misconfigured"), request, null, requestId);
        }
        // `ok` keeps meaning "this Worker is correctly configured"; desktops
        // gate hosted sign-in on it. Provider capacity is reported beside it
        // so a full quota never hides sign-in, recovery, or local pairing.
        const capacity = await capacityHealth(env, healthConfig, ctx).catch(() => null);
        return secureResponse(json({
          ok: true,
          service: "openmausbot-control-plane",
          ...(capacity === null ? {} : { capacity }),
        }), request, null, requestId);
      }

      let config: ControlPlaneConfig | null = null;
      try {
        config = readConfig(env);
        const origin = request.headers.get("origin");
        if (origin && !config.allowedOrigins.has(origin)) {
          return secureResponse(errorResponse(403, "origin_not_allowed"), request, config, requestId);
        }
        const boundedRequest = await withBoundedRequestBody(request);
        return secureResponse(
          await route(boundedRequest, env, ctx, config, requestId, cloudflareFetch),
          request,
          config,
          requestId,
        );
      } catch (error) {
        if (error instanceof HTTPError) {
          return secureResponse(errorResponse(error.status, error.code), request, config, requestId);
        }
        console.error(JSON.stringify({ message: "request failed", requestId }));
        return secureResponse(errorResponse(500, "internal_error"), request, config, requestId);
      }
    },
    scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
      const requestId = crypto.randomUUID();
      ctx.waitUntil((async () => {
        let config: ControlPlaneConfig;
        try {
          config = readConfig(env);
        } catch {
          console.error(JSON.stringify({
            message: "managed endpoint cleanup sweep failed",
            requestId,
            errorCode: "misconfigured",
          }));
          return;
        }
        // The scan only marks idle rows; the sweep below performs every
        // deletion through the ownership-verified path. A failed scan must
        // never block cleanup that is already queued. Both act on each
        // endpoint's own Cloudflare account.
        try {
          await scanTunnelCapacity(env, config, cloudflareFetch, requestId);
        } catch {
          console.error(JSON.stringify({
            message: "managed endpoint tunnel scan failed",
            requestId,
            errorCode: "endpoint_internal",
          }));
        }
        try {
          await sweepManagedEndpointCleanup(env, config, cloudflareFetch, requestId);
        } catch {
          console.error(JSON.stringify({
            message: "managed endpoint cleanup sweep failed",
            requestId,
            errorCode: "endpoint_internal",
          }));
        }
        try {
          await reportEndpointAccountProblems(env, config, requestId);
        } catch {
          console.error(JSON.stringify({
            message: "managed endpoint account check failed",
            requestId,
            errorCode: "endpoint_internal",
          }));
        }
      })());
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
