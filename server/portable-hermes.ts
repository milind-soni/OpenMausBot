import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ResolvedSpawn } from "./env-path.ts";

// Portable Hermes v1.4.17's hermes.bat initializes embedded Python before running
// hermes_cli.main. Windows cannot spawn the batch file directly; ACP also needs
// stdout reserved for protocol messages, without the launcher's banner.
const BOOTSTRAP = `import os, runpy, shutil, sys
root = sys.argv.pop(1)
python_dir = os.path.join(root, "python_embedded")
packages = os.path.join(python_dir, "Lib", "site-packages")
env = os.environ
home = env.get("HERMES_HOME") or os.path.join(env.get("USERPROFILE", os.path.expanduser("~")), ".hermes")
env["HERMES_HOME"] = home
os.makedirs(home, exist_ok=True)
for target, sources in [(".env", [".env", ".env.example"]), ("config.yaml", ["cli-config.yaml", "cli-config.yaml.example"]), ("SOUL.md", ["assets/SOUL.md"])]:
    destination = os.path.join(home, target)
    if not os.path.exists(destination):
        for source in sources:
            source = os.path.join(root, source)
            if os.path.isfile(source):
                shutil.copyfile(source, destination)
                break
for key in ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"]:
    env.pop(key, None)
env["PATH"] = os.pathsep.join([python_dir, os.path.join(python_dir, "Scripts"), os.path.join(root, "node_modules", ".bin"), env.get("PATH", "")])
env["PIP_TARGET"] = packages
env["PYTHONPATH"] = packages
env["HERMES_PYTHON"] = sys.executable
env["HERMES_ROOT"] = root
env.setdefault("TERMINAL_CWD", root)
env["PYTHONIOENCODING"] = "utf-8"
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.path[:0] = [root, packages]
os.chdir(root)
runpy.run_module("hermes_cli.main", run_name="__main__")
`;

export function resolvePortableHermes(shim: string, text: string): ResolvedSpawn | null {
  if (basename(shim).toLowerCase() !== "hermes.bat") return null;
  const root = resolve(dirname(shim));
  if (!/^"%PYTHON_EXE%" -m hermes_cli\.main %\*\s*$/im.test(text)
    || !existsSync(join(root, "hermes_cli", "main.py"))) return null;
  return { command: join(root, "python_embedded", "python.exe"), args: ["-c", BOOTSTRAP, root] };
}
