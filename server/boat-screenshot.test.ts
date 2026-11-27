import { describe, expect, it } from "vitest";

import { PANEL_FRAME_QUALITY, PANEL_FRAME_WIDTH, panelShotCommand } from "./boat.ts";

describe("cloud panel frame capture", () => {
  it("captures at 1080p-class width and legible JPEG quality", () => {
    expect(PANEL_FRAME_WIDTH).toBe(1920);
    expect(PANEL_FRAME_QUALITY).toBe(85);
    const cmd = panelShotCommand();
    expect(cmd).toContain('scrot -o -p -q 85 "$f"');
    expect(cmd).toContain("x11grab -draw_mouse 1");
    expect(cmd).toContain("import -window root -quality 85");
    expect(cmd).toContain(`[ "$w" -gt 1920 ]`);
    expect(cmd).toContain("convert \"$f\" -resize 1920x -quality 85");
    expect(cmd).not.toContain("-thumbnail");
  });

  it("keeps the capture fallbacks and the success marker", () => {
    const cmd = panelShotCommand();
    expect(cmd).toMatch(/scrot .* \|\| import .* \|\| ffmpeg .*x11grab/);
    expect(cmd.indexOf('rm -f "$f"')).toBeGreaterThan(-1);
    expect(cmd.indexOf('rm -f "$f"')).toBeLessThan(cmd.indexOf("scrot"));
    expect(cmd).toContain('test -s "$f" && echo captured');
    expect(panelShotCommand({ width: 1280, quality: 75 })).toContain("convert \"$f\" -resize 1280x -quality 75");
  });
});
