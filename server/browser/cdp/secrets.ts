import { DriverError } from "./errors.ts";
import { valueInWorld } from "./evaluate.ts";
import type { FrameTree } from "./frames.ts";

// Hidden inputs included: multi-step sign-ins carry the password forward in them.
const FIELD_VALUES = `(() => {
  const values = [];
  const visit = (root) => {
    for (const field of root.querySelectorAll("input, textarea")) if (field.value) values.push(field.value);
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  return values;
})()`;

export const SECRET_ON_PAGE = "A saved password is still on this page; submit it or navigate first.";

/** Every field value in every frame, read in the isolated world; values are compared here and dropped. */
export async function fieldValues(frames: FrameTree): Promise<string[]> {
  const perFrame = await Promise.all(frames.all().map((frame) => valueInWorld<string[]>(frames, frame.id, FIELD_VALUES).catch(() => [])));
  return perFrame.flat().filter((value): value is string => typeof value === "string");
}

/**
 * After a saved secret is typed, evaluation and screenshots stay refused until
 * the document it was typed into is gone and no field in any frame still holds it.
 */
export class SecretGuard {
  #held: { values: string[]; documents: Map<string, string | null> } | null = null;

  get armed(): boolean {
    return this.#held !== null;
  }

  arm(frames: FrameTree, values: readonly string[]): void {
    const documents = new Map(frames.all().map((frame) => [frame.id, frame.loaderId] as const));
    const kept = values.filter((value) => value.length > 0);
    if (!kept.length) return;
    this.#held = { values: [...new Set([...(this.#held?.values ?? []), ...kept])], documents };
  }

  /** True while the secret may still be read from the page; clears itself once it cannot. */
  async present(frames: FrameTree): Promise<boolean> {
    const held = this.#held;
    if (!held) return false;
    const documentAlive = [...held.documents].some(([frameId, loaderId]) => {
      const frame = frames.get(frameId);
      return frame !== undefined && frame.loaderId === loaderId;
    });
    if (documentAlive) return true;
    const values = await fieldValues(frames);
    if (values.some((value) => held.values.some((secret) => value.includes(secret)))) return true;
    if (this.#held === held) this.#held = null;
    return false;
  }

  async refuseWhilePresent(frames: FrameTree): Promise<void> {
    if (await this.present(frames)) throw new DriverError("secret-on-page", SECRET_ON_PAGE);
  }

  /** True for a value a snapshot must mask. */
  holds(value: string): boolean {
    return this.#held?.values.some((secret) => value.includes(secret)) ?? false;
  }
}
