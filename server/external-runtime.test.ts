import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeExternalRuntime, externalRuntimeIsActive } from "./external-runtime.ts";

const TOKEN = "fixture-external-runtime-secret-0123456789";
const ROTATED = "fixture-rotated-runtime-secret-0123456789";
const registration = (token = TOKEN) => ({ token, threadId: "original" });
const task = (threadId: string, archivedAt?: number) => ({ threadId, archivedAt });
let directory: string;
let file: string;
let bot: { id: string; threadId: string; hidden: boolean; tasks: ReturnType<typeof task>[] };
const lookup = (id: string) => id === bot.id ? bot : null;
const save = (value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const authorize = (token = TOKEN) => authorizeExternalRuntime(file, `Bearer ${token}`, lookup);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-runtime-auth-"));
  file = join(directory, "external-runtimes.json");
  bot = { id: "gateway", threadId: "original", hidden: false, tasks: [task("original")] };
  save({ gateway: registration() });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

describe("standing external-runtime authorization", () => {
  it("authorizes the explicitly bound conversation without retaining the secret", () => {
    const grant = authorize()!;
    expect(grant).toMatchObject({ botId: "gateway", threadId: "original" });
    expect(grant.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(grant)).not.toContain(TOKEN);
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(true);
  });

  it("does not allow an old captured capability after token rotation or removal", () => {
    const grant = authorize()!;
    save({ gateway: registration(ROTATED) });
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
    expect(authorize()).toBeNull();
    const next = authorize(ROTATED)!;
    expect(externalRuntimeIsActive(file, next, lookup)).toBe(true);
    save({});
    expect(externalRuntimeIsActive(file, next, lookup)).toBe(false);
  });

  it("keeps an explicit conversation binding across selection, task creation and list order", () => {
    save({ gateway: { token: TOKEN, threadId: "original" } });
    const grant = authorize()!;
    bot.tasks.unshift(task("newer"));
    bot.threadId = "newer";
    expect(authorize()?.threadId).toBe("original");
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(true);
    bot.tasks.reverse();
    expect(authorize()?.threadId).toBe("original");
  });

  it("rejects a bare token even when the bot has only one conversation", () => {
    const grant = authorize()!;
    save({ gateway: TOKEN });
    expect(authorize()).toBeNull();
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
    bot.tasks = [task("replacement")]; bot.threadId = "replacement";
    expect(authorize()).toBeNull();
  });

  it("does not adopt another task after the bound conversation is deleted", () => {
    save({ gateway: { token: TOKEN, threadId: "original" } });
    const grant = authorize()!;
    bot.tasks = [task("replacement")]; bot.threadId = "replacement";
    expect(authorize()).toBeNull();
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
  });

  it("revokes a captured grant when the same token is explicitly rebound", () => {
    save({ gateway: { token: TOKEN, threadId: "original" } });
    const grant = authorize()!;
    bot.tasks.push(task("other"));
    save({ gateway: { token: TOKEN, threadId: "other" } });
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
    expect(authorize()?.threadId).toBe("other");
  });

  it.each(["hidden", "archived", "archived-at-zero", "deleted"])("rejects a %s sender or conversation after authorization", reason => {
    const grant = authorize()!;
    if (reason === "hidden") bot.hidden = true;
    if (reason === "archived") bot.tasks[0].archivedAt = Date.now();
    if (reason === "archived-at-zero") bot.tasks[0].archivedAt = 0;
    if (reason === "deleted") bot.id = "another-bot";
    expect(authorize()).toBeNull();
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
  });

  it("rejects ambiguous duplicate tokens rather than choosing the first bot", () => {
    const grant = authorize()!;
    save({ gateway: registration(), anotherBot: registration() });
    expect(authorize()).toBeNull();
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
  });

  it.each([undefined, [`Bearer ${TOKEN}`], "", "Bearer short", `bearer ${TOKEN}`, `Bearer ${TOKEN} suffix`, `Bearer ${TOKEN}x`])("rejects malformed or incorrect bearer %j", header => {
    expect(authorizeExternalRuntime(file, header, lookup)).toBeNull();
  });

  it.each([null, [], { gateway: registration("short") }, { gateway: { token: TOKEN } }, { gateway: { token: TOKEN, threadId: "foreign" } }, { "bad/id": registration() }])("rejects invalid or foreign registration %j", value => {
    save(value);
    expect(authorize()).toBeNull();
  });

  it("fails closed for missing, malformed and oversized files", () => {
    const grant = authorize()!;
    writeFileSync(file, "{broken");
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
    save({ gateway: registration() }); truncateSync(file, 1_048_577);
    expect(authorize()).toBeNull();
    rmSync(file);
    expect(authorize()).toBeNull();
  });

  it.skipIf(process.platform === "win32")("rejects insecure permissions and symlinks instead of reading them", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const grant = authorize()!;
    chmodSync(file, 0o644);
    expect(authorize()).toBeNull();
    expect(externalRuntimeIsActive(file, grant, lookup)).toBe(false);
    expect(warning).toHaveBeenCalled();
    const target = join(directory, "private.json");
    writeFileSync(target, JSON.stringify({ gateway: registration() }), { mode: 0o600 });
    rmSync(file); symlinkSync(target, file);
    expect(authorize()).toBeNull();
  });

  it("rejects directories as credential files", () => {
    rmSync(file); mkdirSync(file, { mode: 0o700 });
    expect(authorize()).toBeNull();
  });
});
