// Folder tree for the project file picker. Folders sort before files, and a
// chain of folders that each hold a single folder is compacted into one row
// ("tmp/affinity-mcp"), as in VS Code's explorer.

export interface FileTreeFolder<F> {
  type: "folder";
  name: string;
  /** Full folder path from the project root; the expand/collapse key. */
  path: string;
  children: FileTreeNode<F>[];
  fileCount: number;
}
export interface FileTreeFile<F> {
  type: "file";
  name: string;
  path: string;
  file: F;
}
export type FileTreeNode<F> = FileTreeFolder<F> | FileTreeFile<F>;

export function buildFileTree<F extends { path: string }>(files: F[]): FileTreeNode<F>[] {
  const root: FileTreeFolder<F> = { type: "folder", name: "", path: "", children: [], fileCount: 0 };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let folder = root;
    for (const part of parts) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let next = folder.children.find((c): c is FileTreeFolder<F> => c.type === "folder" && c.name === part);
      if (!next) {
        next = { type: "folder", name: part, path, children: [], fileCount: 0 };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ type: "file", name, path: file.path, file });
  }
  const finish = (folder: FileTreeFolder<F>): FileTreeFolder<F> => {
    folder.children = folder.children.map((c) => (c.type === "folder" ? finish(c) : c));
    folder.fileCount = folder.children.reduce((n, c) => n + (c.type === "folder" ? c.fileCount : 1), 0);
    folder.children.sort((a, b) =>
      a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    // Compact single-folder chains.
    while (folder.path && folder.children.length === 1 && folder.children[0].type === "folder") {
      const only = folder.children[0];
      folder.name = `${folder.name}/${only.name}`;
      folder.path = only.path;
      folder.children = only.children;
    }
    return folder;
  };
  return finish(root).children;
}

export interface VisibleTreeRow<F> {
  node: FileTreeNode<F>;
  depth: number;
  parentPath: string | null;
}

/** Flatten the rows currently on screen, honouring which folders are expanded. */
export function visibleTreeRows<F>(nodes: FileTreeNode<F>[], isExpanded: (path: string) => boolean, depth = 0, parentPath: string | null = null): VisibleTreeRow<F>[] {
  const rows: VisibleTreeRow<F>[] = [];
  for (const node of nodes) {
    rows.push({ node, depth, parentPath });
    if (node.type === "folder" && isExpanded(node.path)) rows.push(...visibleTreeRows(node.children, isExpanded, depth + 1, node.path));
  }
  return rows;
}
