import type { CdpSession, Params } from "./connection.ts";
import { DriverError } from "./errors.ts";

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";

export interface PendingDialog {
  type: DialogType;
  message: string;
  defaultPrompt: string;
  url: string;
  openedAt: number;
}

const DIALOG_TEXT_LIMIT = 4_000;
const TYPES: readonly DialogType[] = ["alert", "confirm", "prompt", "beforeunload"];

/** A tab's JavaScript dialog. It stays open until someone answers it; only an agent's own navigation answers a beforeunload. */
export class Dialogs {
  readonly #openListeners = new Set<(dialog: PendingDialog) => void>();
  readonly #closeListeners = new Set<(dialog: PendingDialog) => void>();
  #pending: { dialog: PendingDialog; session: CdpSession } | null = null;
  #acceptBeforeUnload = 0;

  get pending(): PendingDialog | null {
    return this.#pending?.dialog ?? null;
  }

  /** Frames in other renderers raise their dialogs on their own session. */
  watch(session: CdpSession): () => void {
    const clear = () => {
      if (this.#pending?.session === session) this.#closed();
    };
    const offs = [
      session.on("Page.javascriptDialogOpening", (params) => this.#opened(session, params)),
      session.on("Page.javascriptDialogClosed", clear),
      session.onDetach(clear),
    ];
    return () => {
      for (const off of offs) off();
      clear();
    };
  }

  onOpen(listener: (dialog: PendingDialog) => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  onClose(listener: (dialog: PendingDialog) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** Resolves when a dialog opens; never rejects. */
  nextOpen(): { opened: Promise<PendingDialog>; cancel: () => void } {
    let cancel = () => {};
    const opened = new Promise<PendingDialog>((resolve) => {
      cancel = this.onOpen(resolve);
    });
    return { opened, cancel };
  }

  async answer({ accept, promptText }: { accept: boolean; promptText?: string }): Promise<PendingDialog> {
    const pending = this.#pending;
    if (!pending) throw new DriverError("refused", "No dialog is open.");
    await pending.session.send("Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
    if (this.#pending === pending) this.#closed();
    return pending.dialog;
  }

  /** While `work` runs, a beforeunload the page raises is accepted: leaving was the agent's own choice. */
  async acceptingBeforeUnload<T>(work: () => Promise<T>): Promise<T> {
    this.#acceptBeforeUnload++;
    try {
      if (this.#pending?.dialog.type === "beforeunload") await this.answer({ accept: true });
      return await work();
    } finally {
      this.#acceptBeforeUnload--;
    }
  }

  #opened(session: CdpSession, params: Params): void {
    const type = TYPES.find((candidate) => candidate === params.type) ?? "alert";
    const dialog: PendingDialog = {
      type,
      message: String(params.message ?? "").slice(0, DIALOG_TEXT_LIMIT),
      defaultPrompt: String(params.defaultPrompt ?? "").slice(0, DIALOG_TEXT_LIMIT),
      url: String(params.url ?? "").slice(0, 2_048),
      openedAt: Date.now(),
    };
    this.#pending = { dialog, session };
    for (const listener of this.#openListeners) {
      try { listener(dialog); } catch {}
    }
    if (type === "beforeunload" && this.#acceptBeforeUnload > 0) void this.answer({ accept: true }).catch(() => {});
  }

  #closed(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    for (const listener of this.#closeListeners) {
      try { listener(pending.dialog); } catch {}
    }
  }
}
