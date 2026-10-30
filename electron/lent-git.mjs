// A lent folder that is a GitHub repository (docs/files.md, "Git repositories"): its origin, branch and commit, read from
// .git's own files, so nothing runs in the folder and this computer needs no git. Only a github.com remote counts.
import fs from "node:fs";
import path from "node:path";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH = /^[\w./-]{1,200}$/;

/** "owner/name" for a github.com remote (https, ssh or git@github.com:), else null. A user or token in it is dropped. */
export function githubRepo(url) {
  const match = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
  const repo = match?.[1];
  return repo && REPO.test(repo) && !repo.split("/").some((part) => part === "." || part === "..") ? repo : null;
}

/** remote "origin"'s url in a git config file's text. */
export function originUrl(config) {
  let origin = false;
  for (const raw of String(config).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { origin = /^\[remote\s+"origin"\]$/i.test(line); continue; }
    const url = origin ? /^url\s*=\s*(.+)$/i.exec(line)?.[1] : null;
    if (url) return url.trim().replace(/^"(.*)"$/, "$1");
  }
  return null;
}

/**
 * `{ repo, branch, head }` when `folder` is a git repository (its own .git folder, not a worktree's or submodule's link)
 * whose origin is on GitHub, else null. `branch` is null when HEAD is detached, `head` when its commit can't be read.
 */
export function lentGit(folder) {
  const dir = path.join(folder, ".git");
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
    const repo = githubRepo(originUrl(fs.readFileSync(path.join(dir, "config"), "utf8")));
    if (!repo) return null;
    const headText = fs.readFileSync(path.join(dir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(refs\/heads\/\S+)$/.exec(headText)?.[1] ?? null;
    const branch = ref ? ref.slice("refs/heads/".length) : null;
    if (branch !== null && (!BRANCH.test(branch) || branch.split("/").some((part) => part === "" || part === "." || part === ".."))) return { repo, branch: null, head: null };
    let head = ref ? null : SHA.test(headText) ? headText : null;
    if (ref) {
      try { head = fs.readFileSync(path.join(dir, ...ref.split("/")), "utf8").trim(); } catch {}
      if (!head || !SHA.test(head)) {
        head = null;
        try {
          for (const line of fs.readFileSync(path.join(dir, "packed-refs"), "utf8").split(/\r?\n/)) {
            const [sha, name] = line.trim().split(" ");
            if (name === ref && SHA.test(sha ?? "")) { head = sha; break; }
          }
        } catch {}
      }
    }
    return { repo, branch, head };
  } catch { return null; }
}
