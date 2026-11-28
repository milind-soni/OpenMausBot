import assert from "node:assert/strict";
import { test } from "node:test";

import { createLendingIndicator } from "./lending-indicator.mjs";

function harness(TrayOverride = null) {
  const trays = [];
  class Tray {
    constructor(image) { this.image = image; trays.push(this); }
    setToolTip() {}
    setTitle() {}
    setContextMenu() {}
    on() {}
    setImage(image) { this.image = image; }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; }
  }
  const nativeImage = { createFromPath: (file) => ({ file, resize: ({ width, height }) => ({ file, width, height }) }) };
  const indicator = createLendingIndicator({ Tray: TrayOverride ?? Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage, iconPath: "old.png",
    onPause: () => {}, onResume: () => {}, onActivity: () => {}, onTerminal: () => {}, device: "PC" });
  return { indicator, trays };
}

test("a new app icon reaches the lending tray, and a tray made later starts with it", () => {
  const { indicator, trays } = harness();
  indicator.update({ clouds: ["My Cloud"] });
  assert.equal(trays.length, 1);
  assert.equal(trays[0].image.file, "old.png");
  assert.equal(trays[0].image.width, 18);

  indicator.setIcon("new.png");
  assert.equal(trays[0].image.file, "new.png");
  assert.equal(trays[0].image.width, 18);

  indicator.update({ clouds: [] });
  assert.equal(trays[0].isDestroyed(), true);
  indicator.update({ clouds: ["My Cloud"] });
  assert.equal(trays.length, 2);
  assert.equal(trays[1].image.file, "new.png");
});

test("a borrowed Linux tray without its own image leaves the picture to the system tray", () => {
  class Borrowed {
    setToolTip() {}
    setTitle() {}
    setContextMenu() {}
    on() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  const { indicator } = harness(Borrowed);
  indicator.update({ clouds: ["My Cloud"] });
  assert.doesNotThrow(() => indicator.setIcon("new.png"));
});
