// What an older desktop's Copy this computer and Bring newer chats ask for: the move to My Cloud carries everything by
// itself, so each of their steps is answered with the one thing to do.
import type { ServerResponse } from "node:http";

export const CLOUD_MOVE_PREFIX = "/api/cloud-move";
export const COPY_REFUSAL = "Update OpenMausBot to bring your bots here by itself.";

export function createCloudMoveRoutes() {
  return (res: ServerResponse, path: string): boolean => {
    if (path !== CLOUD_MOVE_PREFIX && !path.startsWith(`${CLOUD_MOVE_PREFIX}/`)) return false;
    res.writeHead(410, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: COPY_REFUSAL }));
    return true;
  };
}
