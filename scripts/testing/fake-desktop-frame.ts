// A small fake desktop screenshot (PNG) for fixtures: a wallpaper, a browser-like window whose page and pointer move
// with `tick`, and a taskbar. Each `seed` gets its own colors and layout, so a wall of them reads as different machines.
import { crc32, deflateSync } from "node:zlib";

const HUES = [210, 150, 28, 280, 340, 190, 95, 45, 260, 0, 170, 230];

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function fakeDesktopFrame(seed: number, tick: number, width = 480, height = 300): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  const fill = (x0: number, y0: number, w: number, h: number, [r, g, b]: [number, number, number]) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.floor(y0 + h)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.floor(x0 + w)); x++) {
        const at = (y * width + x) * 3;
        pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b;
      }
    }
  };
  const hue = HUES[seed % HUES.length];
  for (let y = 0; y < height; y++) fill(0, y, width, 1, hsl(hue, 0.55, 0.28 + 0.22 * (y / height)));
  const win = { x: 26 + (seed % 3) * 6, y: 18, w: width - 52, h: height - 58 };
  fill(win.x + 3, win.y + 4, win.w, win.h, hsl(hue, 0.4, 0.14));
  fill(win.x, win.y, win.w, win.h, [246, 247, 249]);
  fill(win.x, win.y, win.w, 20, [226, 229, 234]);
  [[255, 95, 87], [255, 189, 46], [40, 201, 64]].forEach((color, index) => fill(win.x + 8 + index * 11, win.y + 7, 7, 7, color as [number, number, number]));
  fill(win.x + 52, win.y + 4, win.w - 64, 12, [255, 255, 255]);
  fill(win.x + 58, win.y + 8, 60 + (seed % 5) * 14, 4, [170, 176, 186]);
  const accent = hsl(hue, 0.7, 0.5);
  const page = { x: win.x + 14, y: win.y + 32 };
  const layout = seed % 4;
  if (layout === 0) {
    fill(page.x, page.y, win.w - 28, 46, accent);
    fill(page.x + 10, page.y + 12, 140, 8, [255, 255, 255]);
    fill(page.x + 10, page.y + 26, 90, 6, [235, 240, 255]);
  } else if (layout === 1) {
    for (let row = 0; row < 7; row++) for (let column = 0; column < 4; column++) {
      fill(page.x + column * ((win.w - 28) / 4), page.y + row * 16, (win.w - 28) / 4 - 2, 14, row === 0 ? accent : [232, 235, 240]);
    }
  } else if (layout === 2) {
    const bars = [40, 70, 55, 90, 65, 80, 50];
    bars.forEach((value, index) => {
      const grow = ((tick + index * 3) % 10) * 3;
      fill(page.x + 10 + index * 52, page.y + 120 - value - grow, 34, value + grow, index % 2 ? accent : hsl(hue, 0.5, 0.7));
    });
  } else {
    fill(page.x, page.y, 120, 120, hsl((hue + 40) % 360, 0.6, 0.6));
    fill(page.x + 30, page.y + 30, 60, 60, [255, 255, 255]);
  }
  const lines = 4 + (tick % 6);
  for (let line = 0; line < lines; line++) {
    const top = page.y + (layout === 2 ? 128 : layout === 1 ? 118 : 62) + line * 11;
    fill(page.x + (layout === 3 ? 134 : 0), top, 80 + ((seed * 37 + line * 53) % 180), 5, [190, 195, 204]);
  }
  const progress = ((tick * 9 + seed * 13) % 100) / 100;
  fill(win.x + 14, win.y + win.h - 16, win.w - 28, 6, [222, 226, 232]);
  fill(win.x + 14, win.y + win.h - 16, (win.w - 28) * progress, 6, accent);
  const pointer = { x: win.x + 40 + ((tick * 23 + seed * 41) % (win.w - 80)), y: win.y + 40 + ((tick * 17 + seed * 29) % (win.h - 80)) };
  for (let row = 0; row < 12; row++) fill(pointer.x, pointer.y + row, Math.max(1, Math.floor(row * 0.7)), 1, [20, 20, 24]);
  fill(0, height - 22, width, 22, [24, 26, 32]);
  for (let icon = 0; icon < 6; icon++) fill(12 + icon * 24, height - 17, 14, 12, icon === seed % 6 ? accent : [90, 96, 110]);

  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
