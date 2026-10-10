// The panel frame is what a person watches the bot through, so its size and
// quality are pinned: a 1024px, quality-70 double encode made page text
// unreadable in the panel and in the chat's image viewer.
import { describe, expect, it } from "vitest";

import { PANEL_FRAME_QUALITY, PANEL_FRAME_WIDTH, panelShotCommand } from "./boat.ts";

describe("cloud panel frame capture", () => {
  it("captures at 1080p-class width and legible JPEG quality", () => {
    expect(PANEL_FRAME_WIDTH).toBe(1920);
    expect(PANEL_FRAME_QUALITY).toBe(85);
    const cmd = panelShotCommand();
    // the pointer is part of the frame: watching the bot means seeing its cursor
    expect(cmd).toContain('scrot -o -p -q 85 "$f"');
    expect(cmd).toContain("x11grab -draw_mouse 1");
    expect(cmd).toContain("import -window root -quality 85");
    expect(cmd).toContain(`[ "$w" -gt 1920 ]`);
    expect(cmd).toContain("convert \"$f\" -resize 1920x -quality 85");
    // -thumbnail's fast resample is for icons, not for reading a page
    expect(cmd).not.toContain("-thumbnail");
  });

  it("keeps the capture fallbacks and the success marker", () => {
    const cmd = panelShotCommand();
    expect(cmd).toMatch(/scrot .* \|\| import .* \|\| ffmpeg .*x11grab/);
    // the previous frame is gone before capturing, so a failed capture cannot
    // hand back yesterday's screen as "captured"
    expect(cmd.indexOf('rm -f "$f"')).toBeGreaterThan(-1);
    expect(cmd.indexOf('rm -f "$f"')).toBeLessThan(cmd.indexOf("scrot"));
    expect(cmd).toContain('test -s "$f" && echo captured');
    // downscale only when the display is wider than the target
    expect(panelShotCommand({ width: 1280, quality: 75 })).toContain("convert \"$f\" -resize 1280x -quality 75");
  });
});
