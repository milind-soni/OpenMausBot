# Origin

Next.js 16 web app (`app/`, `components/`, `lib/`) with a Convex backend (`convex/`).

- The Convex schema (`convex/schema.ts`, `convex/*Tables.ts`) must keep every table and field the production deployment has, so existing data stays valid. Only add optional fields or new tables.
- The Next server is stateless (it runs on Vercel): no local files, sqlite or in-memory locks. Chat, attachments and call signaling go through session-checked Convex functions (`convex/workspaceChat.ts`, `convex/workspaceCalls.ts`); GitHub and MCP OAuth credentials, rate limits and leases go through the signed `/integrations` HTTP action (`ORIGIN_INTEGRATION_SECRET`, `lib/server-store.ts` → `convex/serverStore.ts`), where secrets are sealed with `ORIGIN_SEALING_KEY`.
- Develop against a local Convex deployment only. Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` before committing.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
