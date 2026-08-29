const zlib = require("node:zlib");

function unreadBadgeLabel(count) {
  if (count > 99) return "99+";
  return String(count);
}

const DIGITS = Object.freeze({
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
});

let crcTable = null;

function pngCrc(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function badgePng(label) {
  // Render at 2x and let nativeImage downsample to the 32px Windows overlay.
  // This keeps the round edge and small numerals clean without a canvas or a
  // native image dependency in the packaged main process.
  const width = 64;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  const put = (x, y, [red, green, blue, alpha]) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = alpha;
  };

  const center = 31.5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      if (distance <= 29) put(x, y, distance >= 25.5 ? [21, 32, 21, 255] : [168, 207, 69, 255]);
    }
  }

  const scale = label.length === 1 ? 6 : label.length === 2 ? 4 : 3;
  const glyphWidth = 5 * scale;
  const gap = scale;
  const textWidth = label.length * glyphWidth + (label.length - 1) * gap;
  const textHeight = 7 * scale;
  const startX = Math.round((width - textWidth) / 2);
  const startY = Math.round((height - textHeight) / 2);
  [...label].forEach((character, characterIndex) => {
    const glyph = DIGITS[character];
    if (!glyph) return;
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((cell, columnIndex) => {
        if (cell !== "1") return;
        for (let yy = 0; yy < scale; yy += 1) {
          for (let xx = 0; xx < scale; xx += 1) {
            put(
              startX + characterIndex * (glyphWidth + gap) + columnIndex * scale + xx,
              startY + rowIndex * scale + yy,
              [16, 23, 15, 255],
            );
          }
        }
      });
    });
  });

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (width * 4 + 1);
    raw[target] = 0;
    pixels.copy(raw, target + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

function unreadBadgeDataUrl(count) {
  const label = unreadBadgeLabel(count);
  return `data:image/png;base64,${badgePng(label).toString("base64")}`;
}

module.exports = { unreadBadgeDataUrl, unreadBadgeLabel };
