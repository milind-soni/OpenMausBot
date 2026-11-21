# OpenCode

`server/model-catalog/catalog.ts` adapts the models.dev cache and refresh logic
of OpenCode's `packages/core/src/models-dev.ts` (lines 160-258) at commit
`2fa3363c924c5c3e367b84a87ae478296a0ed59b`, https://github.com/anomalyco/opencode,
MIT License, Copyright (c) 2025 opencode. The full license text is in
[LICENSE](LICENSE) and at the top of the adapted file.

`server/browser/cookies/` (the sign-in import from installed browsers) adapts OpenCode
desktop's `packages/gui-plugins/src/browser/profile/` at commit `5ca87b9`: the browser
table and key lookups of `sources.ts`, the Chromium decryption of `chromium.ts`, the
readers of `firefox.ts` and `safari.ts`, the database copies of `database.ts` and the
cookie shape of `cookie.ts`. Same license; each adapted file names its source at the top.
