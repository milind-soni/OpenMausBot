import { nativeImage } from "electron";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { unreadBadgeDataUrl } = require("../electron/unread-badge.cjs");

const image = nativeImage.createFromDataURL(unreadBadgeDataUrl(7));
if (image.isEmpty()) {
  console.error("taskbar badge did not decode into a native image");
  setImmediate(() => process.exit(1));
} else {
  const size = image.getSize();
  console.log(`taskbar badge decoded ${size.width}x${size.height}`);
  setImmediate(() => process.exit(size.width === 64 && size.height === 64 ? 0 : 1));
}
