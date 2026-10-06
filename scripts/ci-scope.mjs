import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function selectCiScope(files) {
  let runtime = false;
  if (!Array.isArray(files) || files.length === 0) return { runtime: true };
  for (const file of files) {
    if (typeof file !== "string" || file.split("/").some((part) => !part || part === "." || part === "..")) {
      return { runtime: true };
    }
    if (/^(?:[^/]+\.md|docs\/.+\.md|\.github\/FUNDING\.yml)$/.test(file)) continue;
    runtime = true;
  }
  return { runtime };
}

// macOS runners are the scarce ones (five at a time for the whole account),
// and only a couple of test blocks are macOS-only, so a PR runs the suite on
// Linux and Windows. Main pushes, merge groups and manual runs add macOS, and
// every PR still runs the macOS smokes.
const ALL_OS = ["macos-latest", "ubuntu-latest", "windows-latest"];
const PR_OS = ["ubuntu-latest", "windows-latest"];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let scope = { runtime: true };
  let vitestOs = ALL_OS;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      const base = pr?.base?.sha;
      const head = pr?.head?.sha;
      if (![base, head].every((sha) => typeof sha === "string" && /^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(sha))) {
        throw new Error("Missing or invalid pull request commit SHAs");
      }
      // Disabling rename detection retains both old and new paths, including deletions.
      const diff = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!diff || !diff.endsWith("\0")) throw new Error("Empty or invalid changed-path output");
      scope = selectCiScope(diff.slice(0, -1).split("\0"));
      vitestOs = PR_OS;
    } catch (error) {
      console.warn(`CI scope: using all checks because the pull request diff is unavailable: ${error.message}`);
    }
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `runtime=${scope.runtime}\nvitest_os=${JSON.stringify(vitestOs)}\n`,
  );
}
