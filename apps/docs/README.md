# Edu Bot documentation

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

The changelog reads published Edu Bot releases from GitHub and caches the result for five minutes.

## Deploy to Vercel

This deploys only the public documentation. It does not deploy the Electron app,
local harness, credentials, agents, or user data. The changelog page uses Next.js
incremental regeneration so published releases appear without a source commit.

Create a Vercel project for the documentation:

1. Import the `EduardoMoraga/edu-bot` repository.
2. Set **Root Directory** to `apps/docs`.
3. Keep the detected **Next.js** framework settings.
4. Set the production branch to `main` and deploy.
5. Set `DOCS_SITE_URL` to the deployed site's public URL to enable sitemap links.

For an immediate changelog refresh after each desktop release, create a Vercel
Deploy Hook for the production branch and save it in the GitHub repository as
the `DOCS_DEPLOY_HOOK_URL` Actions secret. Without the optional hook, the next
normal docs deployment still pulls the current published releases.

Vercel will build the Next.js docs app, publish every push to `main`, and create
preview URLs for documentation pull requests.
