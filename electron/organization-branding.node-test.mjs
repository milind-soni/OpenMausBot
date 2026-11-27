import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseOrganizationBranding } from "./organization-branding.mjs";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
const icon = { id: randomUUID(), name: "Support", image };
const empty = { logo: null, icons: [] };
test("optional branding accepts bounded raster data and copies only known fields", () => {
  assert.deepEqual(parseOrganizationBranding({ logo: image, icons: [{ ...icon, ignored: true }], ignored: true }), { logo: image, icons: [icon] });
  for (const value of [null, undefined, {}, { logo: null, icons: null }]) assert.deepEqual(parseOrganizationBranding(value), empty);
});
test("branding never forwards external URLs, SVG, invalid pixels or excessive payloads", () => {
  for (const logo of ["https://tracker.invalid/logo", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,PHN2Zy8+", `${image}${"A".repeat(96 * 1024)}`]) assert.deepEqual(parseOrganizationBranding({ logo, icons: [] }), empty);
  const bytes = Buffer.from(image.slice(22), "base64"); bytes.writeUInt32BE(100000, 20);
  assert.deepEqual(parseOrganizationBranding({ logo: `data:image/png;base64,${bytes.toString("base64")}`, icons: [] }), empty);
  assert.deepEqual(parseOrganizationBranding({ logo: null, icons: [icon, icon] }), empty);
  assert.deepEqual(parseOrganizationBranding({ logo: null, icons: Array.from({ length: 25 }, () => ({ ...icon, id: randomUUID() })) }), empty);
  assert.deepEqual(parseOrganizationBranding({ logo: null, icons: [{ ...icon, image: "https://tracker.invalid/icon" }] }), empty);
});
