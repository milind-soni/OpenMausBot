import { describe, expect, it } from "vitest";

import { CommandListReader, MAX_COMMANDS, MAX_COMMAND_BYTES, advertisedDefaultBranch, readCommandList, refusalBody, refusalMessage, refusedCommands } from "./git-push-guard.ts";

// The command lists git 2.50.1 sent at the head of its receive-pack POST (recorded through git's own http-backend):
// `git push <url> HEAD:refs/heads/bot/new`, `HEAD:main` and `--delete old`. The pack, when there is one, follows the flush.
const CAPS = " report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.50.1-Darwin";
const RECORDED = {
  create: `00b90000000000000000000000000000000000000000 4b06e618527a5d9eca7e35d39d2c6506608d9631 refs/heads/bot/new\u0000${CAPS}0000`,
  updateMain: `00b603f43c881a5f647a3b5f1aa28b223f922ce07bdb 4b06e618527a5d9eca7e35d39d2c6506608d9631 refs/heads/main\u0000${CAPS}0000`,
  deleteOld: `00b503f43c881a5f647a3b5f1aa28b223f922ce07bdb 0000000000000000000000000000000000000000 refs/heads/old\u0000${CAPS}0000`,
};
const bytes = (text: string) => Buffer.from(text, "latin1");
const PACK = Buffer.concat([bytes("PACK"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), Buffer.alloc(40, 7)]);

const pkt = (text: string) => `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")}${text}`;
const A = "1".repeat(40), B = "2".repeat(40), Z = "0".repeat(40);

/** Reads pkt-lines back: [band, text] for a side-band answer's packets. */
function packets(body: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  while (at < body.length) {
    const length = parseInt(body.subarray(at, at + 4).toString("latin1"), 16);
    if (length === 0) { at += 4; continue; }
    out.push(body.subarray(at + 4, at + length));
    at += length;
  }
  return out;
}

describe("the push guard's command list", () => {
  it("reads git's recorded command lists, with the pack behind them untouched", () => {
    const create = readCommandList(Buffer.concat([bytes(RECORDED.create), PACK]), false);
    expect(create).toEqual({ state: "done", commands: [{ old: Z, new: "4b06e618527a5d9eca7e35d39d2c6506608d9631", ref: "refs/heads/bot/new" }], capabilities: CAPS.trim().split(" ") });
    expect(readCommandList(bytes(RECORDED.updateMain), true)).toMatchObject({ state: "done", commands: [{ ref: "refs/heads/main" }] });
    expect(readCommandList(bytes(RECORDED.deleteOld), true)).toMatchObject({ state: "done", commands: [{ new: Z, ref: "refs/heads/old" }] });
  });

  it("waits for more while a line or the flush has not arrived, and refuses a body that ends first", () => {
    const whole = bytes(RECORDED.create);
    for (const cut of [0, 3, 4, 100, whole.length - 4, whole.length - 1]) {
      expect(readCommandList(whole.subarray(0, cut), false)).toEqual({ state: "more" });
      expect(readCommandList(whole.subarray(0, cut), true).state).toBe("bad");
    }
  });

  it("reads a list fed in pieces once each: a 1 MiB list in 100-byte pieces costs about what it costs at once", () => {
    const a = "a".repeat(40), b = "b".repeat(40);
    let body = pkt(`${a} ${b} refs/heads/x0\u0000report-status\n`);
    for (let i = 1; Buffer.byteLength(body) < 1000 * 1024 && i < MAX_COMMANDS; i++) body += pkt(`${a} ${b} refs/heads/x${i}\n`);
    const whole = Buffer.from(`${body}0000`, "latin1");
    const started = performance.now();
    const reader = new CommandListReader();
    let verdict = reader.feed(Buffer.alloc(0));
    for (let at = 0; at < whole.length; at += 100) verdict = reader.feed(whole.subarray(at, at + 100));
    // Re-reading everything on each piece took about 15 s here; one pass over the pieces takes well under a second.
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(verdict).toMatchObject({ state: "done" });
    expect((verdict as { commands: unknown[] }).commands.length).toBe(readCommandList(whole, true).state === "done" ? (readCommandList(whole, true) as { commands: unknown[] }).commands.length : -1);
  });

  it("refuses more commands than it takes, and a list longer than it takes without its end", () => {
    const many = Buffer.from(`${Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => pkt(`${A} ${B} refs/heads/b${i}`)).join("")}0000`, "latin1");
    expect(readCommandList(many, true)).toEqual({ state: "bad", reason: "the push updates too many refs at once" });
    const reader = new CommandListReader();
    let verdict = reader.feed(Buffer.from(pkt(`${A} ${B} refs/heads/x\u0000report-status`), "latin1"));
    // Lines too long for MAX_COMMANDS to be reached first.
    const piece = Buffer.from(pkt(`${A} ${B} refs/heads/${"y".repeat(4000)}`).repeat(10), "latin1");
    let sent = 0;
    while (verdict.state === "more" && sent < 2 * MAX_COMMAND_BYTES) { verdict = reader.feed(piece); sent += piece.length; }
    expect(verdict).toEqual({ state: "bad", reason: "the push updates too many refs at once" });
    expect(sent).toBeGreaterThan(MAX_COMMAND_BYTES);
  });

  it("takes git's flush-only probe as a push of nothing, and shallow lines before the commands", () => {
    expect(readCommandList(bytes("0000"), true)).toEqual({ state: "done", commands: [], capabilities: [] });
    const shallow = `${pkt(`shallow ${A}`)}${pkt(`${A} ${B} refs/heads/x\u0000report-status`)}0000`;
    expect(readCommandList(bytes(shallow), true)).toMatchObject({ state: "done", commands: [{ ref: "refs/heads/x" }] });
  });

  it("refuses what it cannot read: a signed push, a line that is no command, a ref outside refs/, a second capability list, a list too long", () => {
    expect(readCommandList(bytes(`${pkt("push-cert\u0000report-status")}0000`), true)).toEqual({ state: "bad", reason: "signed pushes are not taken here" });
    expect(readCommandList(bytes(`${pkt("hello world")}0000`), true).state).toBe("bad");
    expect(readCommandList(bytes(`${pkt(`${A} ${B} HEAD`)}0000`), true).state).toBe("bad");
    expect(readCommandList(bytes(`${pkt(`${A} ${B} refs/heads/a\u0000x`)}${pkt(`${A} ${B} refs/heads/b\u0000y`)}0000`), true).state).toBe("bad");
    expect(readCommandList(bytes("zzzz"), false).state).toBe("bad");
    expect(readCommandList(bytes("0003"), false).state).toBe("bad");
    const long = Buffer.from(pkt(`${A} ${B} refs/heads/${"x".repeat(200)}`).repeat(Math.ceil(MAX_COMMAND_BYTES / 250) + 1), "latin1");
    expect(readCommandList(long, false)).toEqual({ state: "bad", reason: "the push updates too many refs at once" });
  });
});

describe("what the push guard refuses", () => {
  const read = (text: string) => { const list = readCommandList(bytes(text), true); if (list.state !== "done") throw new Error(list.state); return list.commands; };

  it("lets a new branch through and refuses the default branch and a delete", () => {
    expect(refusedCommands(read(RECORDED.create), "refs/heads/main")).toEqual([]);
    expect(refusedCommands(read(RECORDED.updateMain), "refs/heads/main")).toEqual([{ ref: "refs/heads/main", reason: "the default branch is protected here; push to a new branch" }]);
    expect(refusedCommands(read(RECORDED.deleteOld), "refs/heads/main")).toEqual([{ ref: "refs/heads/old", reason: "deleting a ref is not allowed here; push to a new branch" }]);
  });

  it("protects the default branch it learned, and main and master when it learned none", () => {
    expect(refusedCommands(read(RECORDED.updateMain), "refs/heads/trunk")).toEqual([]);
    expect(refusedCommands([{ old: A, new: B, ref: "refs/heads/trunk" }], "refs/heads/trunk")).toHaveLength(1);
    for (const ref of ["refs/heads/main", "refs/heads/master"]) expect(refusedCommands([{ old: A, new: B, ref }], null)).toHaveLength(1);
    expect(refusedCommands([{ old: A, new: B, ref: "refs/heads/feature" }], null)).toEqual([]);
  });

  it("lets a new tag through but refuses moving or deleting one, and anything outside branches and tags", () => {
    expect(refusedCommands([{ old: Z, new: B, ref: "refs/tags/v2" }], "refs/heads/main")).toEqual([]);
    expect(refusedCommands([{ old: A, new: B, ref: "refs/tags/v1" }], "refs/heads/main")).toEqual([{ ref: "refs/tags/v1", reason: "moving a tag is not allowed here; push a new tag" }]);
    expect(refusedCommands([{ old: A, new: Z, ref: "refs/tags/v1" }], "refs/heads/main")[0]!.reason).toContain("deleting a ref");
    for (const ref of ["refs/pull/1/head", "refs/notes/commits", "refs/remotes/origin/x", "refs/heads"]) {
      expect(refusedCommands([{ old: Z, new: B, ref }], "refs/heads/main"), ref).toEqual([{ ref, reason: "only branches and new tags may be pushed here; push to a new branch" }]);
    }
  });

  it("refuses every update of a push in which one is refused", () => {
    expect(refusedCommands([{ old: Z, new: B, ref: "refs/heads/ok" }, { old: A, new: Z, ref: "refs/tags/v1" }], "refs/heads/main")).toEqual([
      { ref: "refs/heads/ok", reason: "not applied: another update in this push was refused" },
      { ref: "refs/tags/v1", reason: "deleting a ref is not allowed here; push to a new branch" },
    ]);
  });
});

describe("the push guard's answers", () => {
  it("reports each refused ref on side band 1 and the bot's message on side band 2, as receive-pack would", () => {
    const refused = [{ ref: "refs/heads/main", reason: "the default branch is protected here; push to a new branch" }];
    const message = refusalMessage(refused, "refs/heads/main");
    expect(message).toContain("Push your work to a new branch");
    expect(message).toContain("(main)");
    const [progress, report] = packets(refusalBody({ capabilities: ["report-status-v2", "side-band-64k"], refused, message }));
    expect(progress![0]).toBe(2);
    expect(progress!.subarray(1).toString()).toBe(`${message}\n`);
    expect(report![0]).toBe(1);
    expect(packets(report!.subarray(1)).map((line) => line.toString())).toEqual(["unpack ok\n", "ng refs/heads/main the default branch is protected here; push to a new branch\n"]);
  });

  it("answers without side bands when none was asked, and an unreadable push as a failed unpack", () => {
    const plain = refusalBody({ capabilities: ["report-status"], refused: [{ ref: "refs/heads/x", reason: "no\nnewlines" }], message: "m" });
    expect(packets(plain).map((line) => line.toString())).toEqual(["unpack ok\n", "ng refs/heads/x no newlines\n"]);
    expect(packets(refusalBody({ capabilities: [], refused: [], message: "This push was refused: x." })).map((line) => line.toString())).toEqual(["unpack This push was refused: x.\n"]);
  });
});

describe("the default branch from an upload-pack ref list", () => {
  // `git upload-pack --advertise-refs` (protocol v0) over HTTP, as git 2.50.1 sends it, with the service line first.
  const advertised = `001e# service=git-upload-pack\n0000${pkt(`8c3fc07a2f7618abbd057b9ce868923c48acc74d HEAD\u0000multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-done symref=HEAD:refs/heads/trunk object-format=sha1 agent=git/2.50.1\n`)}${pkt("8c3fc07a2f7618abbd057b9ce868923c48acc74d refs/heads/trunk\n")}0000`;

  it("is HEAD's symref, read from the first ref line only", () => {
    expect(advertisedDefaultBranch(bytes(advertised))).toBe("refs/heads/trunk");
    expect(advertisedDefaultBranch(bytes(advertised.slice(0, 60)))).toBe("more");
  });

  it("is none for an empty repository's list or anything else", () => {
    expect(advertisedDefaultBranch(bytes(`001e# service=git-upload-pack\n0000${pkt(`${Z} capabilities^{}\u0000multi_ack object-format=sha1\n`)}0000`))).toBeNull();
    expect(advertisedDefaultBranch(bytes("<html>"))).toBeNull();
  });
});
