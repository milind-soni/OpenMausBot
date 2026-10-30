import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { COPY_REFUSAL, createCloudMoveRoutes } from "./cloud-move-http.ts";

function answer() {
  const sent: { status?: number; body?: unknown } = {};
  const res = { writeHead: (status: number) => { sent.status = status; return res; }, end: (text: string) => { sent.body = JSON.parse(text); } };
  return { res: res as unknown as ServerResponse, sent };
}

it("answers every step of an older desktop's Copy this computer with the one thing to do, and nothing else", () => {
  const routes = createCloudMoveRoutes();
  for (const path of ["/api/cloud-move", "/api/cloud-move/upload", "/api/cloud-move/estimate", "/api/cloud-move/merge"]) {
    const { res, sent } = answer();
    expect(routes(res, path), path).toBe(true);
    expect(sent, path).toEqual({ status: 410, body: { error: COPY_REFUSAL } });
  }
  expect(COPY_REFUSAL).toBe("Update OpenMausBot to bring your bots here by itself.");
  for (const path of ["/api/cloud-moves", "/api/cloud-send/chats", "/api/workspace-backup/upload"]) expect(routes(answer().res, path), path).toBe(false);
});
