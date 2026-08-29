import { afterEach, describe, expect, it } from "vitest";

import {
  captureDesktopJpeg,
  desktopJpegDataUrl,
  startLocalScreenServer,
} from "./local-screen-server.mjs";

let stop;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe("private local screen server", () => {
  it("uses the primary display for both the Windows renderer and companion frame paths", async () => {
    const fallback = Buffer.alloc(700, 1);
    const primary = Buffer.alloc(800, 2);
    let requested;
    const frame = await captureDesktopJpeg({
      getSources: async (options) => {
        requested = options;
        return [
          { display_id: "1", thumbnail: { isEmpty: () => false, toJPEG: () => fallback } },
          { display_id: "2", thumbnail: { isEmpty: () => false, toJPEG: () => primary } },
        ];
      },
      getPrimaryDisplayId: () => 2,
    });

    expect(requested).toEqual({ types: ["screen"], thumbnailSize: { width: 1280, height: 800 } });
    expect(frame).toEqual(primary);
    expect(desktopJpegDataUrl(frame)).toBe(`data:image/jpeg;base64,${primary.toString("base64")}`);
  });

  it("serves only an authenticated, non-cacheable JPEG frame", async () => {
    const frame = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(600), Buffer.from([0xff, 0xd9])]);
    const server = await startLocalScreenServer({ capture: async () => frame });
    stop = server.close;

    expect((await fetch(server.url)).status).toBe(401);
    expect((await fetch(server.url.replace("/frame", "/other"), {
      headers: { authorization: `Bearer ${server.token}` },
    })).status).toBe(404);

    const response = await fetch(server.url, { headers: { authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(frame);
  });
});
