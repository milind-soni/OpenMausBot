import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isDeviceSource } from "./previewSource";
import { PreviewCanvas } from "../components/PreviewCanvas";
import { PreviewFrame } from "../components/PreviewFrame";
import type { PreviewSource } from "./mobilePreviewUrl";

describe("web-only device previews", () => {
  it("accepts websites and project HTML only, including null and future unknown file types", () => {
    expect(isDeviceSource(null)).toBe(false);
    expect(isDeviceSource(undefined)).toBe(false);
    expect(isDeviceSource({kind: "url"} as PreviewSource)).toBe(true);
    for (const fileType of ["html", "markdown", "pdf", "image", "unknown"]) {
      expect(isDeviceSource({kind: "file", fileType} as PreviewSource)).toBe(fileType === "html");
    }
  });
  it.each(["markdown", "pdf", "image"] as const)("ignores saved device dimensions, scale and bezel for %s", fileType => {
    const html = renderToStaticMarkup(createElement(PreviewFrame, {
      source: {kind:"file", fileType, projectId:"test",filePath:"sample"},
      width: 393, height: 852, scale: 0.25, showDeviceBezel: true,
    }));
    expect(html).toContain('data-preview-file-viewer="true"');
    expect(html).toContain("width:100%;height:100%");
    expect(html).not.toContain("393px");
    expect(html).not.toContain("852px");
    expect(html).not.toContain("scale(0.25)");
    expect(html).not.toContain("border-[3px]");
  });
  it("refuses to apply Canvas layout, rotation or synchronization to a file", () => {
    const html = renderToStaticMarkup(createElement(PreviewCanvas, {
      source: {kind:"file",fileType:"markdown",projectId:"test",filePath:"sample.md"},
      selectedSizeIds:["phone-small","desktop"],rotatedById:{"phone-small":true},
      customSize:{width:300,height:400},initialTransform:{x:1,y:2,k:0.1},
      scrollSync:true,onToggleScrollSync:()=>{},onToggleRotateArtboard:()=>{},onFocusSingleSize:()=>{},onShareArtboard:()=>{},
    }));
    expect(html.match(/data-preview-file-viewer/g)).toHaveLength(1);
    expect(html).not.toContain("Sync scroll");
    expect(html).not.toContain("Snapshot");
    expect(html).not.toContain("scale(0.1)");
  });

});
