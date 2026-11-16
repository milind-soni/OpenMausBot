import { describe, expect, it } from "vitest";
import { buildFileTree, visibleTreeRows } from "./fileTree";

const files = ["Documents/b.md", "Documents/a.md", "readme.md", "tmp/affinity-mcp/render-10.jpg", "tmp/affinity-mcp/render-2.jpg", "output/pdf/x.pdf", "output/y.pdf"].map((path) => ({ path }));

describe("buildFileTree", () => {
  it("sorts folders first, compacts single-folder chains and counts files", () => {
    const tree = buildFileTree(files);
    expect(tree.map((n) => [n.type, n.name, n.type === "folder" ? n.fileCount : null])).toEqual([
      ["folder", "Documents", 2], ["folder", "output", 2], ["folder", "tmp/affinity-mcp", 2], ["file", "readme.md", null],
    ]);
    const tmp = tree[2];
    expect(tmp.type === "folder" && tmp.path).toBe("tmp/affinity-mcp");
    expect(tmp.type === "folder" && tmp.children.map((c) => c.name)).toEqual(["render-2.jpg", "render-10.jpg"]);
  });
  it("lists only rows inside expanded folders", () => {
    const tree = buildFileTree(files);
    expect(visibleTreeRows(tree, () => false).map((r) => r.node.name)).toEqual(["Documents", "output", "tmp/affinity-mcp", "readme.md"]);
    const open = visibleTreeRows(tree, (p) => p === "output");
    expect(open.map((r) => [r.node.name, r.depth])).toEqual([["Documents", 0], ["output", 0], ["pdf", 1], ["y.pdf", 1], ["tmp/affinity-mcp", 0], ["readme.md", 0]]);
    expect(open[2].parentPath).toBe("output");
  });
});
