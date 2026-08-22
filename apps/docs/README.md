# OpenMausBot documentation

The public documentation site is a Next.js 16 + Fumadocs app. User-facing content lives in `content/docs`; the repository's top-level `docs` folder remains available for implementation notes and detailed platform records.

## Develop

From the repository root:

```bash
pnpm install
pnpm docs:dev
```

The site opens at `http://localhost:3000`.

## Verify

```bash
pnpm docs:build
pnpm --filter @openmausbot/docs types:check
pnpm --filter @openmausbot/docs lint
```

## Deploy to Vercel

This is a fully static site. Deploying it does not deploy the Electron app, local harness, credentials, agents, or user data.

Create a second Vercel project beside the existing `openmausbot.com` project:

1. Import the `milind-soni/OpenMausBot` repository.
2. Set **Root Directory** to `apps/docs`.
3. Keep the detected **Next.js** framework settings.
4. Set the production branch to `main` and deploy.
5. Add `docs.openmausbot.com` under **Settings → Domains**.

Vercel will build the static `out` directory, publish every push to `main`, and create preview URLs for documentation pull requests. Keep `openmausbot.com` on the existing marketing project and add a Docs link there after the new domain is live.
