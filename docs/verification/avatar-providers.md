# Avatar image providers

Run the real profile avatar card and server against a disposable home and a
loopback-only fake Images API. Do not enter real provider keys or select
**Generate avatar** with a configured cloud provider during this check.

```sh
node --experimental-strip-types scripts/verify-avatar-providers.ts
```

Open the printed `previewUrl`. The page shows the fake API's `imageBase`.
Use **Custom**, that base URL, and `fixture/image` as the model. Leave the
key blank and save. Generate an avatar: the fake API returns a valid one-pixel
PNG; the real server stores it and the real avatar component must load it.

Check the following through the UI:

1. OpenAI is initially selected and requires its own key. Grok shows its own
   key field and the shared-key/API-billing explanation.
2. A configured custom connection collapses to **Connection settings**.
   Editing its URL, model, or key disables generation until saved.
3. Save a disposable fake custom key, then try saving a replacement alongside
   a URL containing userinfo (for example `https://u:p@router.example/v1`).
   The validation error must preserve the saved connection and key.
4. Use the fake API's origin with `/error` instead of `/v1`, save, and generate.
   The UI must show `Custom image generation failed (HTTP 401)` without the
   upstream body or its deliberately echoed test authorization value.
5. Use `/url-only` instead of `/v1`. Generation must explain that `b64_json`
   is required; the server must not fetch the provider-returned URL.
6. Restore `/v1`, choose **Remove saved key**, and generate again. This must
   work without authorization. Switch OpenAI → Custom and confirm the saved
   URL/model remain available. Save, reload, and confirm provider and avatar
   persist.

The preview's `/__fixture/requests` endpoint reports only the path, model, and
whether authorization was present. Keep that output alongside the printed
server log path and browser results. For the one-pixel fixture image, check
the rendered image's `complete` and `naturalWidth === 1`; it is not an art-quality
test. The fixture does not prove paid provider access or native desktop secure
storage; payload/credential mapping tests cover those contracts offline.

```sh
pnpm exec vitest run server/avatar-image.test.ts server/generated-image.test.ts server/config.test.ts shared/image-generation.test.ts electron/workspace-credentials.test.mjs electron/diagnostics.test.mjs
pnpm exec vitest run server/index.test.ts -t 'avatar|image key'
pnpm build
```

Stop the foreground fixture with Ctrl-C. It stops only its own server and
removes its disposable home; the server log remains for evidence.

## Verified 2026-09-09

Against the isolated launcher, all six UI checks above passed. The generated attachment loaded with `complete: true` and
`naturalWidth: 1`. Invalid-URL verification additionally read only the fixture's
saved configuration and confirmed both the old endpoint and old key remained.
Reload retained the custom provider and saved avatar.

The local image API recorded:

```json
[
  {"path":"/v1/images/generations","model":"fixture/image","authorized":false},
  {"path":"/error/images/generations","model":"fixture/image","authorized":true},
  {"path":"/url-only/images/generations","model":"fixture/image","authorized":true},
  {"path":"/v1/images/generations","model":"fixture/image","authorized":false}
]
```

The six focused unit/credential suites passed 192 tests; the server API filter
passed three tests (197 unrelated tests skipped). Production build and focused
lint passed. No paid image call or live user credential/data was used. The
launcher prints the retained log location for each run; this run's log was
`server-1788943811891-57352.log`.
