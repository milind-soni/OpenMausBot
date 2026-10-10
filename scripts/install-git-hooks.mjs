// Point git at the repo's hooks (scripts/git-hooks) once, on `pnpm install`.
// Never fails the install: no git, no repo (an npm tarball, a Docker build),
// CI, or a read-only checkout all mean "nothing to do", and a hook that
// cannot be installed must not block installing the app.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooks = join(root, "scripts", "git-hooks");

if (process.env.CI || process.env.OMB_SKIP_HOOKS || !existsSync(join(root, ".git")) || !existsSync(hooks)) {
  process.exit(0);
}
try {
  const current = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (current === "scripts/git-hooks") process.exit(0);
} catch {
  // unset: fall through and set it
}
try {
  execFileSync("git", ["config", "core.hooksPath", "scripts/git-hooks"], { cwd: root, stdio: "ignore" });
  console.log("git hooks: core.hooksPath -> scripts/git-hooks (pre-push runs lint, typecheck, i18n:check; OMB_SKIP_HOOKS=1 or --no-verify to skip)");
} catch {
  // a checkout we cannot configure: the hook is a convenience, not a gate
}
