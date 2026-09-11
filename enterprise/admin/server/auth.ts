import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import type { PortalStore } from "./store.ts";

export interface Mail { to: string; subject: string; text: string }
export interface PortalConfig {
  url: string;
  secret: string;
  admins: string[];
  name: string;
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
}

export async function createPortalAuth(config: PortalConfig, store: PortalStore, sendMail: (mail: Mail) => Promise<void>) {
  const allowed = (email: string) => config.admins.includes(email.trim().toLowerCase()) || store.invited(email);
  const authOptions = {
    appName: config.name,
    baseURL: config.url,
    secret: config.secret,
    database: store.db,
    trustedOrigins: [config.url],
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(config.google ? { google: config.google } : {}),
      ...(config.github ? { github: config.github } : {}),
    },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    session: { expiresIn: 7 * 86400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: {
      cookiePrefix: "omb-admin",
      useSecureCookies: config.url.startsWith("https://"),
      // http.ts only forwards the adjacent Caddy proxy's sanitized IP over its private Unix socket.
      ipAddress: { ipAddressHeaders: ["x-omb-client-ip"] },
    },
    databaseHooks: {
      user: { create: { before: async (user) => {
        if (!allowed(user.email)) throw new APIError("FORBIDDEN", { message: "Ask your administrator for an invitation." });
        return { data: user };
      } } },
      session: { create: { before: async (session) => {
        const row = store.db.prepare('SELECT email FROM "user" WHERE id = ?').get(session.userId) as { email: string } | undefined;
        if (!row || !allowed(row.email)) throw new APIError("FORBIDDEN", { message: "Ask your administrator for an invitation." });
        return { data: session };
      } } },
    },
    plugins: [emailOTP({
      otpLength: 6, expiresIn: 600, allowedAttempts: 5, storeOTP: "hashed",
      async sendVerificationOTP({ email, otp, type }) {
        // A generic successful response for unknown emails avoids exposing the invitation list.
        if (type !== "sign-in" || !allowed(email)) return;
        await sendMail({ to: email, subject: `${config.name} sign-in code`, text: `Your sign-in code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.` });
      },
    })],
  } satisfies BetterAuthOptions;
  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();
  return betterAuth(authOptions);
}

export type PortalAuth = Awaited<ReturnType<typeof createPortalAuth>>;
