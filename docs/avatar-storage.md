# Avatar attachment lifecycle

Bot avatars intentionally reuse the image attachment store. Uploads and
generated images therefore get the same size checks, owner-only filesystem
permissions, immutable serving URL, and raster-only MIME allowlist as message
images.

## Image provider setup

Open a bot's profile, find **Avatar → Generate with AI**, and choose an
**Image provider**. The selected connection is shared by all bot avatars.
Save the connection, optionally describe the image, then choose **Generate
avatar**. The image provider is independent of the bot's chat engine.

- **OpenAI** is the default for existing installations. Save an OpenAI API
  key to use `gpt-image-2` for a low-quality 1024 × 1024 WebP draft. See the
  [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
  and [GPT Image 2 reference](https://developers.openai.com/api/docs/models/gpt-image-2).
- **Grok (xAI)** uses `grok-imagine-image-2.0` with a square aspect ratio and
  base64 output. Save an xAI API key, or reuse the Grok key already configured
  in Settings. Changing or removing this key also affects other Grok features.
  See the [xAI image generation guide](https://docs.x.ai/developers/model-capabilities/images/generation).
- **Custom** accepts a compatible Images API. Enter its **Base URL**, its
  **Image model** ID, and an optional API key, then choose **Save connection**.
  Use the model ID supported by that gateway, including any provider prefix
  it requires. OpenMausBot sends only the custom key to this connection.

Direct OpenAI and Grok generation require their respective API keys and API
access. Signing into a ChatGPT, Codex, or Grok subscription does not configure
these keys. Grok subscription billing and xAI API billing are also separate;
see [xAI's account FAQ](https://docs.x.ai/developers/faq/accounts#if-i-already-have-an-account-for-grok-can-i-use-the-same-account-for-api-access).

### Custom gateway compatibility

For a local gateway such as OmniRoute, a base URL might be
`http://127.0.0.1:20128/v1`. OpenMausBot appends `/images/generations`; pasting
that complete endpoint is also accepted. `localhost` and `127.0.0.1` refer to
the machine running the OpenMausBot server, including when you open the app
remotely. Public endpoints require HTTPS. HTTP is supported for local/private
endpoints. URLs must not contain embedded credentials, query parameters, or
fragments.

The gateway must accept a synchronous OpenAI-style Images API request with
`model`, `prompt`, `size: "1024x1024"`, `n: 1`, and
`response_format: "b64_json"`. Its JSON response must contain
`data[0].b64_json` with raw base64-encoded PNG, JPEG, or WebP bytes. Chat API
compatibility alone is insufficient; URL-only responses, redirects, and
asynchronous job responses are not supported. Each decoded image is limited
to 10 MiB, the response to 15 MiB, and generation to two minutes.

Leave the custom key blank when initially configuring a keyless gateway. If a
custom key was saved previously, choose **Remove saved key** to make the
connection keyless; a blank field otherwise preserves the saved key. OpenAI
and xAI keys are never used as fallbacks for custom connections.

## Deferred cleanup

Replacing or removing an avatar does **not** delete the prior file yet. The
current attachment record has no provenance: the same generated filename can
be referenced by a bot profile, by one or more persisted messages, or by both.
Deleting a file merely because no current bot uses it could break a historical
message, so broad "unreferenced file" cleanup is not reference-safe.

A future bounded cleanup may delete only files recorded as avatar-owned at
creation time. Before deleting one candidate it must still verify that:

1. no bot has that `avatarUrl`;
2. no active or archived task/room message references its stored path; and
3. the filename belongs to the avatar-owned registry, not the legacy shared
   attachment pool.

Cleanup should process a small fixed number of candidates per run and retain a
grace period. Until that provenance registry exists, retaining an old avatar is
the safe non-destructive behavior.
