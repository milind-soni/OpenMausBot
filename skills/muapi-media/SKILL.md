---
name: muapi-media
description: "Generate or edit images and short videos with the MuAPI MCP server (tools named muapi_*). Use when the person names MuAPI: to make an image or video with it, or to connect it."
---

# MuAPI media generation

MuAPI runs image and video models behind one MCP server. If its tools (`muapi_image_generate`, `muapi_video_generate`
and the rest) are not available and the person wants MuAPI, tell them how to connect it: add an MCP
server at `https://api.muapi.ai/mcp` with the header `Authorization: Bearer <key>`, where the key comes from
https://muapi.ai/access-keys. Never ask for the key in the chat and never write it into a file or message.

## Process

1. Take the subject, style, aspect ratio, how many outputs and, for video, the length and any input image from the
   request, with sensible defaults for anything left out.
2. Call `search_models` to shortlist models for the job and check the parameters a model lists before relying on a feature.
3. Image: `muapi_image_generate`; to edit a supplied image, `muapi_upload_image` then `muapi_image_edit`.
   Video: `muapi_video_generate`; to animate a still, `muapi_upload_image` then `muapi_video_from_image`.
4. Keep to what the person asked for, and say in your reply which model, prompt, count or length and expected cost
   you used.
5. Poll `muapi_predict_result` until the job finishes, check the output against the brief, and return the files with
   the prompt, model and request id. Offer one refinement at a time.

## Guardrails

- One paid generation at a time; never retry a failed paid call on your own.
- Never call `muapi_account_topup`, `muapi_keys_create` or `muapi_keys_delete` unless the person asks for exactly that.
- Check `muapi_account_balance` only when asked about credits or when a call fails for balance.
- Do not imply a generated clip shows a real person or event.
