import { randomUUID } from "node:crypto";

export interface DesktopUpdateRequest { type: "openmausbot:update"; requestId: string; action: "state" | "check" | "install"; version?: string }
export interface DesktopUpdateState { status: string; version?: string; installMode?: string; message?: string }

export class DesktopUpdateBridge {
  private pending = new Map<string, { resolve: (state: DesktopUpdateState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private send: (message: DesktopUpdateRequest) => boolean;
  constructor(send: (message: DesktopUpdateRequest) => boolean) { this.send = send; }
  request(action: DesktopUpdateRequest["action"], version?: string): Promise<DesktopUpdateState> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("The desktop updater did not respond.")); }, action === "check" ? 15 * 60_000 : 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      let sent = false;
      try { sent = this.send({ type: "openmausbot:update", requestId, action, version }); } catch { /* A parent may exit between availability and send. */ }
      if (!sent) {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error("Desktop updater unavailable"));
      }
    });
  }
  receive(value: unknown): boolean {
    if (!value || typeof value !== "object" || !("type" in value) || value.type !== "openmausbot:update-result") return false;
    const msg = value as { requestId?: string; error?: string; state?: DesktopUpdateState };
    const pending = this.pending.get(msg.requestId ?? "");
    if (!pending) return true;
    clearTimeout(pending.timer); this.pending.delete(msg.requestId!);
    if (msg.error || !msg.state || typeof msg.state.status !== "string") pending.reject(new Error(msg.error || "Invalid updater response"));
    else pending.resolve(msg.state);
    return true;
  }
}
