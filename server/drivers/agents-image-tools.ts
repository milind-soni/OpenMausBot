import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const IMAGE_PROMPT_MAX_CHARS = 4000;
export const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(["generate_image", "edit_image"]);

export async function callImageTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(name === "edit_image" ? "/api/internal/images/edit" : "/api/internal/images/generate", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, ...args }),
  });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The image was not generated. Try again shortly."), isError: true };
}

export const IMAGE_TOOL_DEFINITIONS = [
  {
    name: "edit_image",
    description:
      "Change an existing image from a text instruction, optionally guided by a markup PNG: marks (circles, arrows, scribbles) drawn on a transparent background at the image's exact size, which point at where to change. Both files are paths in your working folder. The result is attached to your reply when the turn ends. Needs a GPT-Image-2.6 model on OpenAI.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: IMAGE_PROMPT_MAX_CHARS, description: "What to change, in English. Refer to the marks if there is a markup." },
        image: { type: "string", minLength: 1, maxLength: 1000, description: "Path of the PNG, JPEG or WebP to change." },
        markup: { type: "string", minLength: 1, maxLength: 1000, description: "Path of a transparent PNG with the marks, the same size as the image." },
      },
      required: ["prompt", "image"],
    },
  },
  {
    name: "generate_image",
    description:
      "Create one image from a text description with the person's image provider; it is attached to your reply when the turn ends, so do not describe or link it again. Write the prompt in English, concrete and visual. Name a provider only when the person asked for that one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: IMAGE_PROMPT_MAX_CHARS, description: "What the image shows: subject, setting, style, lighting." },
        aspect: { type: "string", enum: ["1:1", "16:9", "9:16"], description: "Shape; square when omitted." },
        format: { type: "string", enum: ["gif"], description: "gif makes an animated GIF; only GPT-Image-2.6 models on OpenAI can." },
        frames: { type: "integer", minimum: 2, maximum: 16, description: "GIF frame count; 9 when omitted." },
        frameDurationMs: { type: "integer", minimum: 20, maximum: 2000, description: "GIF milliseconds per frame; 200 when omitted." },
        provider: { type: "string", enum: ["openai", "xai", "gemini", "openrouter", "higgsfield", "custom"], description: "Only when the person named one; it must be their base or backup." },
      },
      required: ["prompt"],
    },
  },
];
