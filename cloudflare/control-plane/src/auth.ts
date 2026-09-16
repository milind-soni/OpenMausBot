import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";

import type { ControlPlaneConfig } from "./config";
import { sendOTPEmail } from "./email";

export function createAuth(
  env: Env,
  ctx: ExecutionContext,
  config: ControlPlaneConfig,
  requestId: string,
) {
  return betterAuth({
    appName: "Astra",
    baseURL: config.authBaseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [...config.allowedOrigins],
    logger: { disabled: true },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: true,
      ipAddress: {
        // Cloudflare writes this header at the edge. Do not trust a client-
        // supplied x-forwarded-for chain for rate limits or session metadata.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      database: { generateId: "uuid" },
      backgroundTasks: {
        handler(promise) {
          ctx.waitUntil(promise);
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: false,
        rateLimit: { window: 60, max: 5 },
        async sendVerificationOTP(input) {
          await sendOTPEmail({
            async send(message) {
              await env.EMAIL.send(message);
            },
          }, config.emailFrom, input, requestId);
        },
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

export type ControlPlaneAuth = ReturnType<typeof createAuth>;

export async function accountSession(request: Request, auth: ControlPlaneAuth) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].startsWith("omb_install_")) return null;

  return auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${match[1]}` }),
  });
}
