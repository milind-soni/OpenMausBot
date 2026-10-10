# Greenference

Greenference is a bring-your-own-key model provider. No Greenference CLI or
separate OMB subscription is required; Greenference bills inference on your
account.

## Connect

1. Create a personal API token at [Greenference → API tokens](https://greenference.com/dashboard/tokens).
2. In OMB, open **Settings → Connections → API keys** and save it in
   **Greenference API token**.
3. Choose **Greenference (API)** and a model from a bot's model selector.

On a self-hosted server you can instead set `GREENFERENCE_TOKEN` in the server
environment before starting OMB. Keep the token private, not in chat or source
control. Replacing or clearing the saved token refreshes the provider without
recreating your bots.

The terminal setup wizard also lists Greenference among its OpenAI-compatible
endpoints. That wizard uses the existing OpenAI-compatible connection and its
saved credentials, rather than creating a second connection automatically.

## What works

OMB uses Greenference's [Chat Completions API](https://greenference.com/docs/chat-completions)
at `https://llm.eu.greenference.com/v1`, with Bearer-token authentication.
Streaming replies, reported token usage, and function-tool calls run through
OMB's existing API-provider runtime. Agents, connected apps, custom MCP tools,
and authorized computer/browser tools use the same permissions as other API
providers; this integration adds no new approval layer.

The model selector reads the [live model catalog](https://greenference.com/docs/models),
including exact IDs and context windows. Unavailable and non-text-output
models are excluded. Image attachments and screenshots are sent as images only
when the selected model advertises image input; text-only models receive an
explicit note that they cannot see the image. Tool and vision support still
depend on the model you choose. The startup fallback is Qwen3.6 27B; a
successful catalog response replaces that fallback.

**The model list is public.** Settings' connection test proves catalog access,
not that the token is valid, funded, or permitted to use a specific model.
The first chat tests authenticated inference and shows the provider's error
if it fails. A successful public catalog check does not clear a previously
rejected token.

No Claude Code endpoint or Codex compatibility is promised. Greenference's
documented Responses API is a limited stateless subset, so this integration
uses Chat Completions instead.

## Verification

See [the isolated Greenference fixture](verification/greenference.md). The
automated tests use synthetic credentials and a local stand-in provider, not
a live paid account. Public catalog access was checked on 2026-10-08;
authenticated live inference still requires a real account test.
