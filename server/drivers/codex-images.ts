// Codex runs in the bot box, where the server's data folder is an empty tmpfs, so it cannot open a `localImage` path
// under attachments/. The server reads the file and sends an `image` input with a data URL instead: codex-cli 0.160.1
// and 0.164.0 accept it on turn/start and pass it to the model unchanged as `input_image`. Security invariant: never
// bind the attachments folder into the box to make a path readable; it holds every conversation's files.
import { readFile } from "node:fs/promises";

import type { TurnImageInput } from "../contracts.ts";

export type CodexImageInput = { type: "image"; url: string };

export async function codexImageInputs(images: readonly TurnImageInput[] | undefined): Promise<CodexImageInput[]> {
  return Promise.all((images ?? []).map(async (image) => ({
    type: "image" as const,
    url: `data:${image.mime};base64,${(await readFile(image.path)).toString("base64")}`,
  })));
}

const INLINE_IMAGE = /^data:image\/[\w.+-]+;base64,/;

/** Codex echoes the turn's input back in userMessage items; a native log keeps each inline image's size, never its bytes. */
export function withoutInlineImages<T>(value: T): T {
  if (typeof value === "string") {
    return (INLINE_IMAGE.test(value) ? `[inline image omitted · ${value.length} chars]` : value) as T;
  }
  if (!value || typeof value !== "object") return value;
  let changed = false;
  const scrub = (item: unknown) => {
    const next = withoutInlineImages(item);
    if (next !== item) changed = true;
    return next;
  };
  const next = Array.isArray(value)
    ? value.map(scrub)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return (changed ? next : value) as T;
}
