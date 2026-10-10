// The Active Threads popover geometry contract, as a ui-smoke leg: a sibling
// of approval-ui-smoke.cjs, run by scripts/smoke-approval-modes.cjs (its --ui
// group, or --sidebar-attention-only alone; --capture-only writes the PNG
// evidence without asserting, for before/after composites on other trees).
// The disposable fake-engine server holds one bot whose settled reply is
// never read - the unread state the cross-bot attention list collects - and
// the real Sidebar is mounted at each density through the shared preview
// fixture. The popover must keep its 16px inset in the row densities: in
// compact a static w-72 (288px) crossed the window edge by 32px
// (272 < 16 + 288) and the OS clipped the title row, which is the reported
// field bug. In the avatar column the header's actions stack vertically, so
// the menu must anchor to the Active Threads button itself: anchored to the
// action cluster it opened below the + button instead, the reported
// avatar-view bug.
//
// Determinism: the popover opens the instant the button is clicked, but its
// rows exist only once the store's first /api/bots fetch lands in the page,
// so openAndMeasure waits for a populated menu before it measures - geometry
// is always taken from the popover the field bug is about.
const { BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

// The popover anchors right-0 to the header's action cluster, so every
// anchored menu's right edge sits this far inside the sidebar's outer edge:
// px-4 ends the cluster 16px inside the sidebar's usable width, and the
// sidebar's own border-r adds one more pixel. (A left-edge "sidebarLeft + 16"
// model is never executable: every anchored menu, healthy comfortable
// included, measures 15px from the sidebar's left edge.)
const HEADER_ACTION_INSET_PX = 16; // px-4 on the header's action cluster
const SIDEBAR_BORDER_RIGHT_PX = 1; // border-r on the sidebar itself
const POPOVER_RIGHT_INSET_PX = HEADER_ACTION_INSET_PX + SIDEBAR_BORDER_RIGHT_PX;

module.exports = async function verifySidebarAttentionUi({ root, url, api, until }) {
  const captureOnly = process.argv.includes("--capture-only");
  const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
  const bot = (await api("/api/bots", "POST", { name: "Sidebar attention fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  // One owner turn: when it settles, the thread nobody has opened is marked
  // unread, so the attention list has exactly one row to anchor the popover.
  await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Reply once, then stay idle" });
  await until(async () => (await api("/api/bots?messages=0")).body.bots.find((candidate) => candidate.id === bot.id)
    ?.tasks.find((task) => task.threadId === bot.threadId)?.unread === true);
  const preview = await mountPreview({ info: { url } }, {
    entry: "/scripts/testing/sidebar-attention-preview.tsx",
    route: "/__sidebar-attention-preview.html",
    title: "Isolated sidebar attention",
    logLevel: "silent",
  });
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  const evaluate = (js) => window.webContents.executeJavaScript(js).catch((error) => { throw new Error(`${error.message}: ${js}`); });
  const evidence = join(root, ".omb-scratch/verify-evidence/sidebar-attention");
  mkdirSync(evidence, { recursive: true });
  const attentionButton = `[...document.querySelectorAll('button[aria-label]')].find((button) => button.getAttribute('aria-label') === 'Active Threads')`;
  const sidebarAtWidth = (width) => `(() => { const sidebar = document.querySelector('[data-sidebar]'); return sidebar ? Math.abs(sidebar.getBoundingClientRect().width - ${width}) < 1 : false; })()`;
  const openAndMeasure = async () => {
    await until(async () => await evaluate(`Boolean(${attentionButton})`));
    await evaluate(`${attentionButton}.click(); true`);
    const measured = await until(async () => await evaluate(`(() => {
      const title = [...document.querySelectorAll('span')].find((node) => node.textContent.trim() === 'Active Threads' && node.closest('div.absolute'));
      if (!title) return null;
      const menu = title.closest('div.absolute');
      const button = ${attentionButton};
      const sidebar = document.querySelector('[data-sidebar]');
      const rect = menu.getBoundingClientRect();
      const rows = [...menu.querySelectorAll('button')].filter((button) => (button.getAttribute('aria-label') || '').includes('Sidebar attention fixture')).length;
      // The empty popover exists before the store's first /api/bots fetch
      // lands; measuring it would pin the geometry to the empty menu. Wait
      // for the populated menu the field bug is actually about.
      if (rows === 0) return null;
      return JSON.stringify({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        titleLeft: title.getBoundingClientRect().left,
        buttonLeft: button.getBoundingClientRect().left,
        buttonBottom: button.getBoundingClientRect().bottom,
        sidebarLeft: sidebar.getBoundingClientRect().left,
        rows,
      });
    })()`));
    return JSON.parse(measured);
  };
  try {
    const results = {};
    // Compact must shrink the menu to w-60 (240px); comfortable keeps w-72
    // (288px). Both sit 16px inside the sidebar: popover width + px-4 anchor
    // equal the sidebar's own width plus the shared 16px inset.
    for (const [density, sidebarPixels, menuWidth] of [["compact", 272, 240], ["comfortable", 320, 288]]) {
      await window.loadURL(`${preview.previewUrl}?density=${density}`);
      await until(async () => await evaluate(sidebarAtWidth(sidebarPixels)) === true);
      const measured = await openAndMeasure();
      writeFileSync(join(evidence, `${density}.png`), (await window.webContents.capturePage()).toPNG());
      results[density] = measured;
      if (!captureOnly) {
        assert.equal(measured.rows, 1, `the ${density} menu must show the one unread thread: ${JSON.stringify(measured)}`);
        assert.ok(Math.abs((measured.left + measured.width) - (measured.sidebarLeft + sidebarPixels - POPOVER_RIGHT_INSET_PX)) <= 0.5,
          `the ${density} menu must anchor 16px inside the sidebar's usable width (px-4 plus the sidebar's 1px border-r): ${JSON.stringify(measured)}`);
        assert.ok(measured.left >= -0.5,
          `the ${density} menu must not spill past the window's left edge: ${JSON.stringify(measured)}`);
        assert.ok(Math.abs(measured.width - menuWidth) <= 0.5,
          `the ${density} menu must be ${menuWidth}px wide: ${JSON.stringify(measured)}`);
        assert.ok(measured.titleLeft >= -0.5,
          `the ${density} title must start inside the window: ${JSON.stringify(measured)}`);
      }
    }
    // The avatar column anchors the menu to the Active Threads button
    // itself: left-0 on the button's left edge and top directly under it
    // (top-full + mt-1). Anchored to the cluster the menu opened a full
    // button-plus-gap lower - under the + button - which is the reported
    // avatar-view bug.
    await window.loadURL(`${preview.previewUrl}?density=icons`);
    await until(async () => await evaluate(sidebarAtWidth(80)) === true);
    const icons = await openAndMeasure();
    writeFileSync(join(evidence, "icons.png"), (await window.webContents.capturePage()).toPNG());
    results.icons = icons;
    if (!captureOnly) {
      assert.equal(icons.rows, 1, `the icons menu must show the one unread thread: ${JSON.stringify(icons)}`);
      assert.ok(Math.abs(icons.left - icons.buttonLeft) <= 0.5,
        `the icons menu must align its left edge with the Active Threads button: ${JSON.stringify(icons)}`);
      assert.ok(Math.abs(icons.top - (icons.buttonBottom + 4)) <= 0.5,
        `the icons menu must open directly below the Active Threads button, not below the cluster: ${JSON.stringify(icons)}`);
      assert.ok(icons.left >= -0.5,
        `the icons menu must not spill past the window's left edge: ${JSON.stringify(icons)}`);
      assert.ok(Math.abs(icons.width - 288) <= 0.5,
        `the icons menu must be 288px wide: ${JSON.stringify(icons)}`);
      assert.ok(icons.titleLeft >= -0.5,
        `the icons title must start inside the window: ${JSON.stringify(icons)}`);
    }
    console.log(JSON.stringify({ captureOnly, ...results, evidence }));
  } finally {
    window.destroy();
    await preview.close();
  }
};
