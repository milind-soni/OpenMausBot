import { describe, expect, it } from "vitest";

import { MAX_CUT_TEXT, RfbClientFilter, RfbProtocolError } from "./rfb-filter.ts";

const HANDSHAKE = Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"), Buffer.from([1, 0])]);
const key = (down: boolean, keysym: number) => { const message = Buffer.alloc(8); message[0] = 4; message[1] = down ? 1 : 0; message.writeUInt32BE(keysym, 4); return message; };
const qemuKey = (down: boolean, keysym: number, keycode: number) => { const message = Buffer.alloc(12); message[0] = 255; message.writeUInt16BE(down ? 1 : 0, 2); message.writeUInt32BE(keysym, 4); message.writeUInt32BE(keycode, 8); return message; };
const pointer = (mask: number, x: number, y: number) => { const message = Buffer.alloc(6); message[0] = 5; message[1] = mask; message.writeUInt16BE(x, 2); message.writeUInt16BE(y, 4); return message; };
const cutText = (text: string) => { const bytes = Buffer.from(text, "latin1"); const head = Buffer.alloc(8); head[0] = 6; head.writeInt32BE(bytes.length, 4); return Buffer.concat([head, bytes]); };
const updateRequest = () => Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const setEncodings = (encodings: number[]) => { const message = Buffer.alloc(4 + 4 * encodings.length); message[0] = 2; message.writeUInt16BE(encodings.length, 2); encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + 4 * index)); return message; };
const desktopSize = () => { const message = Buffer.alloc(8 + 16); message[0] = 251; message.writeUInt16BE(800, 2); message.writeUInt16BE(600, 4); message[6] = 1; return message; };

function filter(allowed: { value: boolean }) {
  let inputs = 0;
  const gate = new RfbClientFilter({ allowInput: () => allowed.value, onInput: () => { inputs++; } });
  return { gate, inputs: () => inputs };
}

describe("RFB client filter", () => {
  it("passes the handshake, forcing a shared session", () => {
    const { gate } = filter({ value: false });
    const exclusive = Buffer.from(HANDSHAKE);
    exclusive[13] = 0;
    expect([...gate.feed(exclusive)]).toEqual([...HANDSHAKE.subarray(0, 13), 1]);
  });

  it("passes each step of the handshake as soon as it is whole, since the server answers each before the next", () => {
    const { gate } = filter({ value: false });
    expect(gate.feed(HANDSHAKE.subarray(0, 5)).length).toBe(0);
    expect(gate.feed(HANDSHAKE.subarray(5, 12)).toString("latin1")).toBe("RFB 003.008\n");
    expect([...gate.feed(HANDSHAKE.subarray(12, 13))]).toEqual([1]);
    expect([...gate.feed(Buffer.from([0]))]).toEqual([1]);
  });

  it("refuses a version or security type it cannot frame", () => {
    expect(() => filter({ value: true }).gate.feed(Buffer.from("RFB 003.003\n", "latin1"))).toThrow(RfbProtocolError);
    const vncAuth = Buffer.from(HANDSHAKE);
    vncAuth[12] = 2;
    expect(() => filter({ value: true }).gate.feed(vncAuth)).toThrow(RfbProtocolError);
  });

  it("drops pointer, key, clipboard and resize messages from a viewer without control, and keeps the picture flowing", () => {
    const { gate, inputs } = filter({ value: false });
    gate.feed(HANDSHAKE);
    const picture = Buffer.concat([setEncodings([7, 16, 0, -223]), updateRequest()]);
    const out = gate.feed(Buffer.concat([pointer(1, 10, 20), key(true, 0x61), picture, qemuKey(true, 0x62, 48), cutText("secret"), desktopSize()]));
    expect(out.equals(picture)).toBe(true);
    expect(inputs()).toBe(0);
  });

  it("passes the same input once its viewer holds control", () => {
    const { gate, inputs } = filter({ value: true });
    gate.feed(HANDSHAKE);
    const input = Buffer.concat([pointer(1, 10, 20), pointer(0, 10, 20), key(true, 0x61), key(false, 0x61), cutText("hello")]);
    expect(gate.feed(input).equals(input)).toBe(true);
    expect(inputs()).toBe(5);
  });

  it("frames messages split across chunks at any byte", () => {
    const allowed = { value: true };
    const { gate } = filter(allowed);
    const stream = Buffer.concat([HANDSHAKE, setEncodings([7, 0]), key(true, 0x61), key(false, 0x61), cutText("abc"), updateRequest()]);
    const out: Buffer[] = [];
    for (let at = 0; at < stream.length; at++) out.push(gate.feed(stream.subarray(at, at + 1)));
    const joined = Buffer.concat(out);
    const expected = Buffer.from(stream);
    expected[13] = 1;
    expect(joined.equals(expected)).toBe(true);
  });

  it("applies a change of control to the very next message", () => {
    const allowed = { value: true };
    const { gate } = filter(allowed);
    gate.feed(HANDSHAKE);
    expect(gate.feed(key(true, 0x61)).length).toBe(8);
    allowed.value = false;
    // The held key is let go once, then nothing more gets through.
    expect([...gate.feed(key(true, 0x62))]).toEqual([...key(false, 0x61)]);
    expect(gate.feed(key(true, 0x63)).length).toBe(0);
  });

  it("lets go of held keys and buttons when asked", () => {
    const { gate } = filter({ value: true });
    gate.feed(HANDSHAKE);
    gate.feed(Buffer.concat([key(true, 0x61), qemuKey(true, 0x62, 48), pointer(1, 30, 40)]));
    expect(gate.holding).toBe(true);
    expect([...gate.release()]).toEqual([...key(false, 0x61), ...qemuKey(false, 0x62, 48), ...pointer(0, 30, 40)]);
    expect(gate.holding).toBe(false);
    expect(gate.release().length).toBe(0);
  });

  it("sizes the display as the picture view sizes the page, the screens in it too, within limits, and reports the size", () => {
    const sizes: Array<[number, number]> = [];
    const gate = new RfbClientFilter({ allowInput: () => true, onResize: (width, height) => { sizes.push([width, height]); } });
    gate.feed(HANDSHAKE);
    const out = gate.feed(desktopSize());
    expect(sizes).toEqual([[1280, 960]]);
    const phone = Buffer.from(desktopSize());
    phone.writeUInt16BE(400, 2);
    phone.writeUInt16BE(750, 4);
    const fitted = gate.feed(phone);
    expect([fitted.readUInt16BE(2), fitted.readUInt16BE(4), fitted.readUInt16BE(16), fitted.readUInt16BE(18)]).toEqual([1280, 2400, 1280, 2400]);
    const huge = Buffer.from(desktopSize());
    huge.writeUInt16BE(9000, 2);
    huge.writeUInt16BE(3000, 4);
    gate.feed(huge);
    expect(sizes.at(-1)).toEqual([2560, 2560]);
    expect(out.length).toBe(24);
  });

  it("swallows the keyboard's ways into DevTools and printing, presses and releases alike, and keeps the page's own shortcuts", () => {
    const { gate } = filter({ value: true });
    gate.feed(HANDSHAKE);
    const CONTROL = 0xffe3, SHIFT = 0xffe1;
    const chord = (modifiers: number[], keysym: number) => Buffer.concat([...modifiers.map((m) => key(true, m)), key(true, keysym), key(false, keysym), ...[...modifiers].reverse().map((m) => key(false, m))]);
    const modifiersOnly = (modifiers: number[]) => Buffer.concat([...modifiers.map((m) => key(true, m)), ...[...modifiers].reverse().map((m) => key(false, m))]);
    expect(gate.feed(Buffer.concat([key(true, 0xffc9), key(false, 0xffc9)])).length).toBe(0);
    for (const letter of [0x49, 0x69, 0x4a, 0x6a]) expect(gate.feed(chord([CONTROL, SHIFT], letter)).equals(modifiersOnly([CONTROL, SHIFT])), letter.toString(16)).toBe(true);
    for (const letter of [0x70, 0x50]) expect(gate.feed(chord([CONTROL], letter)).equals(modifiersOnly([CONTROL]))).toBe(true);
    expect(gate.feed(qemuKey(true, 0xffc9, 88)).length).toBe(0);
    expect(gate.feed(qemuKey(false, 0xffc9, 88)).length).toBe(0);
    // Ctrl+U underlines and Ctrl+Shift+C copies in editors and terminals; the policy already blocks page source and DevTools.
    const ordinary = Buffer.concat([chord([CONTROL], 0x63), chord([SHIFT], 0x49), chord([CONTROL], 0x75), chord([CONTROL, SHIFT], 0x43), key(true, 0x75), key(false, 0x75)]);
    expect(gate.feed(ordinary).equals(ordinary)).toBe(true);
    expect(gate.holding).toBe(false);
  });

  it("ends the stream on a message it cannot frame or an oversized clipboard", () => {
    const unknown = filter({ value: true }).gate;
    unknown.feed(HANDSHAKE);
    expect(() => unknown.feed(Buffer.from([99, 0, 0, 0]))).toThrow(RfbProtocolError);
    const huge = filter({ value: false }).gate;
    huge.feed(HANDSHAKE);
    const head = Buffer.alloc(8);
    head[0] = 6;
    head.writeInt32BE(-(MAX_CUT_TEXT + 1), 4);
    expect(() => huge.feed(head)).toThrow(RfbProtocolError);
    const qemuAudio = filter({ value: true }).gate;
    qemuAudio.feed(HANDSHAKE);
    expect(() => qemuAudio.feed(Buffer.from([255, 1]))).toThrow(RfbProtocolError);
  });
});
