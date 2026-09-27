// This program runs ONLY inside the assigned remote computer. It receives a
// short-lived model capability, never a provider or infrastructure credential.
import { gzipSync } from "node:zlib";

export const CODING_RUNNER = String.raw`
import base64, gzip, json, os, pathlib, signal, subprocess, sys, threading, time, urllib.request
p = json.loads(base64.b64decode(sys.argv[1]))
root = pathlib.Path.home() / '.nation-coding' / p['project']
root.mkdir(parents=True, exist_ok=True)
run = root / '.runs' / p['id']
run.mkdir(parents=True, exist_ok=False)
os.chmod(run, 0o700)
stopped = threading.Event()
proc = None
def alive():
    if time.time() >= p['expires'] / 1000: return False
    try:
        req = urllib.request.Request(p['url'] + '/lease', headers={'Authorization': 'Bearer ' + p['token']})
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status == 200
    except Exception: return False
def kill():
    if proc is not None:
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
def watch():
    while not stopped.wait(2):
        if not alive():
            stopped.set()
            kill()
            return
if not alive():
    print(json.dumps({'status': 'cancelled', 'text': 'Coding task authorization ended.'}))
    sys.exit(0)
home = root / '.runtime'
home.mkdir(exist_ok=True)
env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'HOME': str(pathlib.Path.home()),
       'CODEX_HOME': str(home), 'NATION_TASK_TOKEN': p['token'], 'LANG': 'C.UTF-8'}
config = '\n'.join(['model_provider = "nation"', 'approval_policy = "never"', 'model = ' + json.dumps(p['model']),
    '[features]', 'daemon_auto_start = false', 'plugins = false', 'apps = false',
    '[model_providers.nation]', 'name = "NATION"', 'wire_api = "responses"',
    'base_url = ' + json.dumps(p['url']), 'env_key = "NATION_TASK_TOKEN"',
    'request_max_retries = 0', 'stream_max_retries = 0'])
(home / 'config.toml').write_text(config)
os.chmod(home / 'config.toml', 0o600)
args = ['codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
        '--cd', str(root), '--output-last-message', str(run / 'answer.txt'), '-']
# No credentials or caller-selected executable, model URL, or shell arguments.
prompt = 'You are a NATION developer agent. Work only on the requested project. Inspect existing work before edits. Run relevant tests and report actual results. Do not push, publish, delete projects, or send messages unless the user explicitly authorized it. The project persists between tasks.\n\n' + p['prompt']
try:
    with open(run / 'events.jsonl', 'w') as log:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=log, stderr=log, env=env, cwd=root, start_new_session=True)
        threading.Thread(target=watch, daemon=True).start()
        proc.communicate(prompt.encode(), timeout=max(1, p['expires']/1000-time.time()))
    code = proc.returncode
except subprocess.TimeoutExpired:
    stopped.set(); kill(); proc.wait(); code = 124
except Exception:
    kill(); code = 1
finally:
    cancelled = stopped.is_set()
    stopped.set()
    kill() # reap any shell descendants even after the CLI exits
answer = run / 'answer.txt'
text = answer.read_text()[-18000:] if answer.exists() else 'Coding task did not produce a final answer. Inspect the project before retrying.'
print(json.dumps({'status': 'cancelled' if cancelled else 'completed' if code == 0 else 'failed',
                  'text': text.replace(p['token'], '[redacted]'), 'project': p['project']}))
`;

export function codingCommand(input: { id: string; project: string; prompt: string; model: string; url: string; token: string; expires: number }): string {
  const program = gzipSync(CODING_RUNNER).toString("base64");
  const payload = Buffer.from(JSON.stringify(input)).toString("base64");
  // Both interpolated values are base64, not caller-supplied shell fragments.
  return `python3 -c 'import base64,gzip; exec(gzip.decompress(base64.b64decode("${program}")))' '${payload}'`;
}
