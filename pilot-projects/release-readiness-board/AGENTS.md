# Agent Instructions

This repository is a deterministic, non-production UI fixture.

- Default write scope: `app/**` and `tests/**`.
- Never add network calls, credentials, authentication, analytics, databases, uploads, or production data.
- Do not install or change dependencies unless the Owner explicitly authorizes it.
- Preserve existing assertions; add or update tests for visible behavior changes.
- Run `node --test tests/source-contract.test.mjs` before producing a candidate.
- Keep each task bounded and report changed files, verification evidence, and remaining work.
