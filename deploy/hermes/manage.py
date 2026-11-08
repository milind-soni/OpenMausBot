#!/usr/bin/env python3
"""Pinned Hermes deployment for a dedicated Hetzner Linux/systemd host.

Prerequisites: administrator-installed python3 (3.11+), git, curl, bash, tar,
runuser, useradd, pgrep, systemd/systemd-run; upstream PM provisions pinned tools.
Install provisions separate non-login origin-hermes and origin-hermes-build users.
When deploying these supervisor assets over an older installation, first create
the missing builder:
  sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin origin-hermes-build
No root agent, sudo rule, SSH key, provider cloud key or Docker socket is granted.
Chat slash commands deliberately use the non-WhatsApp principal
`origin-local-maintenance-only` as sole admin: upstream EMPTY admin lists mean
unrestricted commands, not deny-all. No real WhatsApp sender matches this ID.

Operator sequence from this directory (these commands mutate the target host):
  sudo python3 manage.py install
  sudo python3 /opt/origin-hermes-admin/manage.py configure
  sudo python3 /opt/origin-hermes-admin/manage.py login
  sudo python3 /opt/origin-hermes-admin/manage.py pair-whatsapp
  sudo systemctl enable --now origin-hermes.service
  sudo python3 /opt/origin-hermes-admin/manage.py health
  sudo systemctl enable --now origin-hermes-update-check.timer

login requires the gateway already stopped and launches native `hermes model`
in the isolated service account's protected default-profile mount namespace. Select
ChatGPT or Codex Subscription, authorize the displayed device code yourself,
and choose an actual model from that account. This is a SEPARATE Hetzner Hermes
login; existing native coding CLI credentials on NixOS/Mac are never copied.
No additional coding CLI API key is needed. Anthropic Hermes OAuth can require
paid Max extra credits, not included Claude Code Max quota. No fallback is enabled
by default. `chat-policy --file POLICY.json [--allow-paid]` accepts
{"model":{"provider":"openai-codex","default":"ACCOUNT_MODEL_ID"},
 "fallback_providers":[]} with exact user-chosen providers/models; it changes
Hermes CHAT only, never Origin coding harness/account/model policy.

pair-whatsapp requires a human risk acknowledgement and QR scan. Select self-chat
for your existing personal phone. WhatsApp > Settings > Linked Devices > Link a
Device. No Business conversion or Meta API is involved. This is the officially
DOCUMENTED HERMES Baileys path, NOT an official Meta-supported bot API: personal
account restriction/ban and protocol-breakage risks remain. Pairing/session keys
stay private. Prefer a dedicated number if that risk is unacceptable.
https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp
https://hermes-agent.nousresearch.com/docs/integrations/providers

Deploy runtime_repair.py alongside this supervisor. The reviewed WhatsApp repair
is hash-guarded and applied only to a newly built immutable stage, never live
node_modules. For a deployment whose gateway is already stopped:
  sudo python3 /opt/origin-hermes-admin/manage.py repair-offline --release /opt/origin-hermes-admin/release.json --maintenance
This requires the SAME upstream pin and no service-user processes. It probes
the candidate before activation, retains the previous runtime, never changes
private HOME, and leaves the gateway stopped. Interrupted activation uses
`recover --maintenance`; offline recovery also leaves HOME and gateway untouched.

The daily timer checks only by default. Administrator opt-in:
  sudo python3 /opt/origin-hermes-admin/manage.py enable-auto-updates
  sudo python3 /opt/origin-hermes-admin/manage.py disable-auto-updates
Enable requires configured, authenticated health and an explicit managed chat
model (`chat-policy` above). It snapshots the reviewed current pin and policy;
changing either requires disable, review, and re-enable. The agent cannot opt in.
Only newer same-minor stable releases within the reviewed compatibility line
qualify. The explicitly reviewed cache-bounding and compaction-window algorithm
modules listed in AUTOMATIC_RUNTIME_FILES may update; ALL other runtime modules
(including agent_init.py/file_safety.py), gateway/auth/config/tool-dispatch,
installer/PM/dependency and filesystem-mode changes require administrator review.
Official upstream runtime is trusted after opt-in: the credential-free candidate
effective-policy probe and rollback reduce risk, not prove future code safe.
Quarantine is root-only and persistent;
inspect /opt/origin-hermes-admin/quarantine/ before an explicit manual retry.
  sudo python3 /opt/origin-hermes-admin/manage.py update --release APPROVED.json --maintenance
Candidates stage with an empty isolated home and no access to live credentials
BEFORE downtime. Fresh authenticated health and explicit idle activity, confirmed
drain, stopped service and a read-back backup precede activation and preflight.
The dedicated account uses its private DATA as the native default profile.
A read-only install index binds there; its root-owned symlinks retain original
PM paths and HERMES_RUNTIME_DIR selects the original immutable tool store.
The data root itself is bind-mounted against replacement. Only PM locks/leases
are writable in runtime storage. Native owner maintenance uses the same mounts
with the gateway stopped. No --force, --replace or deprecated standalone flag
is used. Hidden build probes and historical profile aliases are never served.
The managed WhatsApp bridge_script also points into the immutable release; its
npm dependencies are staged and stamped before startup, never installed live.
Staging is retained intact across rollback for explicit administrator retry.
For existing supervised stages, stop the idle gateway, deploy manage.py,
runtime_repair.py and the service unit, run repair-offline with the current pin,
then daemon-reload and start the service. Index entries retain rollback stages.
Rollback requires a validated supervised stage; unprepared legacy installs are
not eligible for automatic activation or recovery.
Deploy the reviewed managed-config baseline/bridge_script setting as administrator
while retaining the explicitly chosen chat model; missing policy fails preflight.
Failed health restores old home and release; failed rollback leaves the service
stopped and journal/backups retained. `recover --maintenance` replays rollback
after a supervisor crash; never run `hermes update` in chat. Backups contain
credentials: root-only local storage, not encrypted off-host; no retention pruning.
Automatic health additionally checks local native OAuth expiry. Health checks
fresh gateway/PID, connected WhatsApp and authorized Origin MCP tools/list,
never an LLM prompt, login or pairing.
It cannot prove provider acceptance or chat generation; human smoke remains required.
"""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
import getpass
import gzip
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import stat
import sys
import time
import urllib.parse
import urllib.request

from runtime_repair import apply_repair, repair_id, validate_repair

ASSETS = Path(__file__).resolve().parent
ADMIN = Path('/opt/origin-hermes-admin')
BASE = Path('/opt/origin-hermes')
HOME = Path('/var/lib/origin-hermes')
DATA = HOME / '.hermes'
MANAGED = Path('/etc/origin-hermes')
BACKUPS = Path('/var/backups/origin-hermes')
JOURNAL = BACKUPS / 'maintenance.json'
SERVICE = 'origin-hermes.service'
USER = 'origin-hermes'
REPOSITORY = 'https://github.com/NousResearch/hermes-agent.git'
API = 'https://api.github.com/repos/NousResearch/hermes-agent'
AUTO_POLICY = ADMIN / 'automatic-updates.json'
QUARANTINE = ADMIN / 'quarantine'
UPDATE_STATE = Path('/var/lib/origin-hermes-updates/latest.json')
ADMIN_UID = 0
# Default-deny executable changes. These reviewed algorithm modules do not
# construct tool surfaces, authorize files/accounts, or control gateway idleness.
# In particular agent_init.py, file_safety.py and ALL unlisted modules stay pinned.
AUTOMATIC_RUNTIME_FILES = frozenset({
    'agent/cache_bounds.py',
    'agent/context_compressor_window.py',
})


class CompatibilityReviewRequired(ValueError):
    """A published release exceeds the explicitly reviewed automatic scope."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect refused')


def request(url, data=None, headers=None, with_headers=False):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(url, data=data, headers={'User-Agent': 'origin-hermes-supervisor/1', **(headers or {})})
    with opener.open(req, timeout=30) as response:
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise ValueError('Response too large')
        return (body, dict(response.headers)) if with_headers else body


def atomic(path, content, mode=0o600, owner=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.new')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
    os.fchmod(fd, mode)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        if owner:
            os.chown(temporary, owner.pw_uid, owner.pw_gid)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def save(path, value, **kwargs):
    atomic(path, json.dumps(value, indent=2) + '\n', **kwargs)


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def as_user(args, **kwargs):
    # Never forward the administrator's cloud, model, SSH or integration secrets.
    return run(['runuser', '-u', USER, '--', 'env', '-i', 'HOME=' + str(HOME),
                'USER=' + USER, 'LOGNAME=' + USER, 'PATH=/usr/local/bin:/usr/bin:/bin',
                'HERMES_HOME=' + str(DATA), 'HERMES_MANAGED_DIR=' + str(MANAGED),
                'TERM=' + os.environ.get('TERM', 'xterm-256color'), *args], **kwargs)


def hermes(*args):
    destination = (BASE / 'current').resolve(strict=True)
    return runtime_run(destination, [destination / '.hermes/bin/hermes', *args],
                       interactive=sys.stdin.isatty())


def root_required():
    if os.geteuid() != 0:
        raise ValueError('This operation requires the deployment administrator, not the Hermes agent')


def manifest(path):
    value = json.loads(path.read_text())
    if not re.fullmatch(r'v\d+\.\d+\.\d+', value['tag']):
        raise ValueError('Only explicit stable semantic release tags are allowed')
    if not all(re.fullmatch('[0-9a-f]{40}', value[k]) for k in ('commit', 'installerGitBlob')):
        raise ValueError('Full commit and installer Git blob pins are required')
    if value.get('repository') != REPOSITORY:
        raise ValueError('Only the reviewed official upstream repository is allowed')
    return value


def trusted(path):
    """Administrator-controlled path, including every parent; never follow links."""
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Administrator path ownership/permissions changed')


def version(pin):
    return tuple(int(part) for part in pin['tag'][1:].split('.'))


def source_tree(commit):
    resolved = json.loads(request(API + '/git/commits/' + commit))
    tree = resolved.get('tree', {}).get('sha', '')
    if resolved.get('sha') != commit or not re.fullmatch('[0-9a-f]{40}', tree):
        raise ValueError('Immutable upstream source tree missing')
    value = json.loads(request(API + '/git/trees/' + tree + '?recursive=1'))
    if value.get('truncated') is not False or value.get('sha') != tree:
        raise ValueError('Complete immutable upstream source tree unavailable')
    return {item['path']: (item['mode'], item['type'], item['sha'])
            for item in value['tree'] if item['type'] != 'tree'}


def compatible(pin, baseline):
    if version(pin)[:2] != version(baseline)[:2]:
        raise CompatibilityReviewRequired('Major/minor changes require administrator review')
    old, new = source_tree(baseline['commit']), source_tree(pin['commit'])
    if new.get('scripts/install.sh') != ('100755', 'blob', pin['installerGitBlob']):
        raise CompatibilityReviewRequired('Installer changes require administrator review')
    for name in old.keys() | new.keys():
        if old.get(name) == new.get(name):
            continue
        inert = name.startswith(('docs/', 'tests/')) or name in ('README.md', 'CHANGELOG.md')
        runtime = name in AUTOMATIC_RUNTIME_FILES and name in old and name in new
        if not (inert or runtime) or any(entry is not None and entry[:2] != ('100644', 'blob')
                            for entry in (old.get(name), new.get(name))):
            raise CompatibilityReviewRequired('Source or permission change requires administrator review')


def policy_digest():
    digest = hashlib.sha256()
    for path in (MANAGED / 'config.yaml', MANAGED / '.env', ADMIN / 'managed-config.json',
                 ADMIN / 'manage.py', ADMIN / 'runtime_repair.py'):
        trusted(path)
        digest.update(str(path).encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def quarantine(pin):
    QUARANTINE.mkdir(mode=0o700, exist_ok=True)
    trusted(QUARANTINE)
    save(QUARANTINE / (pin['commit'] + '.json'),
         {'release': pin, 'failedAt': datetime.now(timezone.utc).isoformat()})


def automatic_policy(enabled):
    root_required()
    trusted(ADMIN)
    if not enabled:
        AUTO_POLICY.unlink(missing_ok=True)
        print('Automatic application disabled; daily metadata checks remain available.')
        return
    preflight()
    health()
    native_auth_health()
    pwd.getpwnam(USER + '-build')
    previous = (BASE / 'current').resolve(strict=True)
    validate_stage(previous)
    trusted(previous / 'origin-release.json')
    pin = manifest(previous / 'origin-release.json')
    release_metadata(pin)
    save(AUTO_POLICY, {'enabled': True, 'baseline': pin, 'policyDigest': policy_digest()})
    run(['systemctl', 'enable', '--now', 'origin-hermes-update-check.timer'])
    print('Restricted daily stable updates enabled: only reviewed cache/compaction algorithms '
          'and inert documentation/tests may change automatically. This is NOT an always-latest '
          'guarantee; other stable patches require administrator review.')


def release_metadata(pin):
    release = json.loads(request(API + '/releases/tags/' + pin['tag']))
    if release.get('draft') is not False or release.get('prerelease') is not False or release.get('tag_name') != pin['tag']:
        raise ValueError('Release is not published stable')
    commit = json.loads(request(API + '/commits/' + pin['tag']))
    if commit.get('sha') != pin['commit']:
        raise ValueError('Release tag does not match reviewed immutable commit')


def stage_run(release_root, args, network=True, **kwargs):
    """No live home, managed credentials, host writes or privileged installer."""
    build_home = release_root / 'build-home'
    return run(['systemd-run', '--quiet', '--wait', '--pipe', '--collect',
                '--unit=origin-hermes-stage-' + str(time.time_ns()),
                '--property=User=' + USER + '-build', '--property=Group=' + USER + '-build',
                '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict',
                '--property=ProtectHome=yes', '--property=PrivateTmp=yes',
                '--property=PrivateDevices=yes', '--property=ProtectProc=invisible',
                '--property=PrivateNetwork=' + ('no' if network else 'yes'),
                '--property=CapabilityBoundingSet=', '--property=RestrictSUIDSGID=yes',
                '--property=InaccessiblePaths=' + str(HOME) + ' ' + str(MANAGED),
                '--property=ReadWritePaths=' + str(release_root),
                '--property=WorkingDirectory=' + str(build_home),
                '--property=RuntimeMaxSec=1800',
                '--property=CPUQuota=200%', '--property=MemoryMax=2G',
                '--property=TasksMax=256', '--property=Nice=10',
                '/usr/bin/env', '-i', 'HOME=' + str(build_home), 'USER=' + USER + '-build',
                'LOGNAME=' + USER + '-build', 'PATH=/usr/local/bin:/usr/bin:/bin',
                'HERMES_HOME=' + str(build_home / '.hermes/profiles/.origin-probe'),
                'HERMES_MANAGED_DIR=' + str(build_home / 'managed'), *args], **kwargs)


def stage_root(pin):
    return BASE / 'releases' / (pin['commit'] + '-supervised-3-' + repair_id())


def install_release(pin):
    release_metadata(pin)
    release_root = stage_root(pin)
    destination = release_root / 'source'
    if release_root.exists():
        validate_stage(destination)
        if manifest(destination / 'origin-release.json') != pin:
            raise ValueError('Existing stage does not match the requested immutable release')
        receipt = json.loads((release_root / 'origin-stage.json').read_text())
        if receipt.get('repair', {}).get('id') != repair_id():
            raise ValueError('Cached stage does not contain the reviewed runtime repair')
        return destination
    release_root.mkdir(mode=0o755)
    release_root.chmod(0o755)
    account = pwd.getpwnam(USER + '-build')
    os.chown(release_root, account.pw_uid, account.pw_gid)
    build_home = release_root / 'build-home'
    build_home.mkdir(mode=0o755)
    build_home.chmod(0o755)
    os.chown(build_home, account.pw_uid, account.pw_gid)
    source = request('https://raw.githubusercontent.com/NousResearch/hermes-agent/' + pin['commit'] + '/scripts/install.sh')
    digest = hashlib.sha1(b'blob ' + str(len(source)).encode() + b'\0' + source).hexdigest()
    if digest != pin['installerGitBlob']:
        raise ValueError('Pinned upstream installer content mismatch')
    installer = ADMIN / ('installer-' + pin['commit'] + '.sh')
    atomic(installer, source.decode(), mode=0o644)
    try:
        stage_run(release_root, ['bash', installer, '--channel', 'stable', '--commit', pin['commit'],
                  '--dir', destination, '--hermes-home', build_home / '.hermes/profiles/.origin-probe',
                  '--non-interactive', '--skip-browser', '--skip-computer-use'])
        for ref in ('HEAD', pin['tag'] + '^{commit}'):
            sha = stage_run(release_root, ['git', '-C', destination, 'rev-parse', ref],
                            capture_output=True, text=True).stdout.strip()
            if sha != pin['commit']:
                raise ValueError('Installed source/version differs from immutable stable release')
        if not (destination / '.hermes/bin/hermes').is_file():
            raise ValueError('Installer did not publish the pinned launcher')
        tool_env = json.loads(stage_run(release_root, [destination / '.hermes/bin/hermes', 'pm', 'env', 'node', 'npm'],
                                        capture_output=True, text=True).stdout)
        tool_path = tool_env.get('PATH')
        if not isinstance(tool_path, str) or not tool_path:
            raise ValueError('PM did not publish its pinned Node PATH')
        stage_run(release_root, ['env', 'PATH=' + tool_path + ':/usr/bin:/bin',
                  'npm', 'ci', '--omit=dev', '--prefix', destination / 'scripts/whatsapp-bridge'])
    finally:
        installer.unlink(missing_ok=True)
    # All build processes must exit before root freezes or writes their output.
    builder = subprocess.run(['pgrep', '-u', str(account.pw_uid)], capture_output=True)
    if builder.returncode != 1:
        raise ValueError('Builder activity remains; refusing privileged staging operations')
    freeze_stage(release_root)
    stage_directory(destination, release_root)
    repair = apply_repair(destination)
    save(destination / 'origin-release.json', pin, mode=0o644)
    prepare_runtime(destination)
    save(release_root / 'origin-stage.json',
         {'layout': 3, 'commit': pin['commit'], 'repair': repair}, mode=0o644)
    validate_stage(destination)
    return destination


def candidate_policy_probe(destination):
    """Execute real candidate config readers, without credentials or network."""
    validate_stage(destination)
    release_root = destination.parent
    build_home = release_root / 'build-home'
    # No privileged write follows a builder-controlled intermediate link.
    # This check precedes even copying the managed configuration into staging.
    profile = release_root / 'probe-data'
    managed = build_home / 'managed'
    for directory in (build_home, profile, managed):
        stage_directory(directory, release_root)
    atomic(managed / 'config.yaml', (MANAGED / 'config.yaml').read_text(), mode=0o644)
    managed_env = (MANAGED / '.env').read_text()
    allowed = {'WHATSAPP_ENABLED', 'WHATSAPP_MODE', 'WHATSAPP_ALLOWED_USERS',
               'WHATSAPP_ALLOW_ALL_USERS', 'WHATSAPP_GROUP_POLICY', 'WHATSAPP_GROUP_ALLOWED_USERS',
               'WHATSAPP_DM_POLICY', 'HERMES_YOLO_MODE'}
    if any(line.partition('=')[0] not in allowed for line in managed_env.splitlines() if line.strip()):
        raise ValueError('Unreviewed managed environment cannot enter credential-free staging')
    atomic(managed / '.env', managed_env, mode=0o644)
    # Deliberate hostile user overrides must lose to the administrator layer.
    save(profile / 'config.yaml', {
        'platform_toolsets': {'whatsapp': ['terminal', 'file']},
        'auth': {'adopt_external_logins': True}, 'approvals': {'mode': 'yolo'},
        'model': {'provider': 'unapproved', 'default': 'unapproved'},
        'fallback_providers': [{'provider': 'unapproved', 'model': 'unapproved'}]},
        mode=0o644)
    atomic(profile / '.env',
           'WHATSAPP_ALLOW_ALL_USERS=true\nWHATSAPP_ALLOWED_USERS=19999999999\n'
           'HERMES_YOLO_MODE=true\nORIGIN_MCP_URL=https://origin.invalid/mcp\n'
           'ORIGIN_MCP_TOKEN=synthetic-policy-probe\n', mode=0o644)
    probe = """
import json, os, re, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from hermes_constants import get_default_hermes_root
from pm.environments import selected_venv, store_root
root = Path(sys.argv[1]).parent
expected_root = root / 'build-home/.hermes'
if get_default_hermes_root().resolve() != expected_root.resolve():
    raise SystemExit(1)
for executable_root in (selected_venv(Path(sys.argv[1])), store_root(Path(sys.argv[1])), Path(sys.executable)):
    if not executable_root.resolve().is_relative_to(root.resolve()):
        raise SystemExit(1)
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv(load_external_secrets=False)
from hermes_cli.config import load_config
managed = Path(os.environ['HERMES_MANAGED_DIR'])
expected = json.loads(re.sub(r'\\$\\{([A-Z0-9_]+)\\}', lambda m: os.environ[m[1]],
                             (managed / 'config.yaml').read_text()))
actual = load_config()
def matches(wanted, value):
    if isinstance(wanted, dict) and wanted:
        return isinstance(value, dict) and all(k in value and matches(v, value[k]) for k, v in wanted.items())
    return type(wanted) is type(value) and wanted == value
if not matches(expected, actual):
    raise SystemExit(1)
for line in (managed / '.env').read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep and os.environ.get(key) != value:
        raise SystemExit(1)
from gateway.platforms.whatsapp_common import resolve_whatsapp_bridge_dir
if resolve_whatsapp_bridge_dir().resolve() != (Path(sys.argv[1]) / 'scripts/whatsapp-bridge').resolve():
    raise SystemExit(1)
from hermes_cli.main_platform_setup import _whatsapp_has_identity
import tempfile
with tempfile.TemporaryDirectory() as temporary:
    session = Path(temporary)
    credentials = session / 'creds.json'
    for value in ({}, {'registered': True}, {'me': {}}, {'me': {'id': ' '}}):
        credentials.write_text(json.dumps(value))
        if _whatsapp_has_identity(session):
            raise SystemExit(1)
    credentials.write_text('not valid json')
    if _whatsapp_has_identity(session):
        raise SystemExit(1)
    credentials.write_text(json.dumps({'registered': False, 'me': {'id': 'synthetic@s.whatsapp.net'}}))
    if not _whatsapp_has_identity(session):
        raise SystemExit(1)
print('origin-effective-policy-ok')
"""
    # The upstream PM selector is stdlib-only and pinned by compatible(). Run
    # its selected interpreter, not the host interpreter's dependency set.
    bootstrap = ("import os,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); "
                 "from pm.environments import project_python; p=str(project_python(Path(sys.argv[1]))); "
                 "os.execv(p,[p,'-c',sys.argv[2],sys.argv[1]])")
    result = stage_run(destination.parent, ['python3', '-c', bootstrap, destination, probe],
                       network=False, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if result.stdout.strip() != 'origin-effective-policy-ok':
        raise ValueError('Candidate effective-policy probe did not confirm the reviewed contract')


def stage_directory(path, root):
    """Verify every directory component without following intermediate links."""
    relative = path.relative_to(root)
    if '..' in relative.parts:
        raise ValueError('Staging path escapes its immutable root')
    current = root
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        info = current.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != ADMIN_UID
                or info.st_mode & 0o022 or info.st_mode & 0o005 != 0o005):
            raise ValueError('Staging directory is not immutable administrator-owned storage')


def freeze_stage(root):
    # chown -h never follows links. chmod walks actual directories only.
    run(['chown', '-hR', 'root:root', root])
    for folder, directories, files in os.walk(root, followlinks=False):
        Path(folder).chmod(0o755)
        for name in files:
            path = Path(folder) / name
            info = path.lstat()
            if stat.S_ISREG(info.st_mode):
                path.chmod(0o755 if info.st_mode & 0o111 else 0o644)
            elif not stat.S_ISLNK(info.st_mode):
                raise ValueError('Unexpected special file in staged runtime')
    # Validate critical ancestors before root creates any files through them.
    for relative in ('build-home', 'build-home/.hermes',
                     'build-home/.hermes/profiles', 'build-home/.hermes/profiles/.origin-probe', 'source'):
        stage_directory(root / relative, root)


def runtime_state(destination):
    key = hashlib.sha256(str(destination.resolve()).encode()).hexdigest()[:16]
    return destination.parent / 'build-home/.hermes/installs' / key


def runtime_index(destination, create=False):
    """Protected indirection preserves native PM's canonical absolute paths."""
    trusted(BASE)
    if create:
        validate_stage(destination)
    target = runtime_state(destination)
    stage_directory(target, destination.parent)
    index = BASE / 'runtime-installs'
    if create and not index.exists() and not index.is_symlink():
        index.mkdir(mode=0o755)
        index.chmod(0o755)
    stage_directory(index, BASE)
    entry = index / target.name
    if create and not entry.exists() and not entry.is_symlink():
        entry.symlink_to(target)
    info = entry.lstat()
    if (not stat.S_ISLNK(info.st_mode) or info.st_uid != ADMIN_UID
            or os.readlink(entry) != str(target)):
        raise ValueError('Runtime install index does not select the immutable stage')
    return index


def validate_runtime_projection(destination):
    index = runtime_index(destination)
    projected = DATA / 'installs'
    # These configured paths contain no mountinfo escape characters. Checking
    # mountinfo is necessary: ismount() cannot reliably identify same-fs binds.
    mounts = {line.split()[4] for line in Path('/proc/self/mountinfo').read_text().splitlines()}
    if (str(DATA) not in mounts or str(projected) not in mounts
            or not os.path.samefile(index, projected)
            or not os.statvfs(projected).f_flag & os.ST_RDONLY):
        raise ValueError('Default-profile data and install index are not protected mounts')


def runtime_locks(destination):
    state_root = runtime_state(destination)
    return (state_root / '.install.lock', state_root / 'pm-runtime/.prepare.lock')


def runtime_lease_roots(destination):
    state_root = runtime_state(destination)
    return (state_root / 'environments', state_root / 'pm-runtime/generations')


def prepare_runtime_locks(destination):
    """Prepare a frozen unpublished stage, or repair it with the service stopped."""
    root = destination.parent
    account = pwd.getpwnam(USER)
    for lock in runtime_locks(destination):
        stage_directory(lock.parent, root)
        # Replacing the final component cannot follow its prior symlink.
        atomic(lock, '', owner=account)
    for generations in runtime_lease_roots(destination):
        stage_directory(generations, root)
        for marker in generations.glob('**/.lease-managed'):
            stage_directory(marker.parent, root)
            leases = marker.parent / '.leases'
            if leases.exists() or leases.is_symlink():
                info = leases.lstat()
                if (not stat.S_ISDIR(info.st_mode) or
                        info.st_uid not in (ADMIN_UID, account.pw_uid) or info.st_mode & 0o022):
                    raise ValueError('Runtime lease directory is not trusted')
                shutil.rmtree(leases)
            leases.mkdir(mode=0o700)
            os.chown(leases, account.pw_uid, account.pw_gid)
            leases.chmod(0o700)


def prepare_runtime(destination):
    """Keep code, tools and facts immutable; hide the disposable build probe.

    Live commands use the dedicated default data root. Their mount namespace
    projects a protected install index while HERMES_RUNTIME_DIR selects the
    original tool-store path; neither changes the installed dependency facts.
    """
    root = destination.parent
    bridge = destination / 'scripts/whatsapp-bridge'
    stage_directory(bridge / 'node_modules', root)
    if (bridge / 'package.json').is_symlink():
        raise ValueError('Bridge package manifest is not immutable regular data')
    # Upstream _ensure_bridge_deps uses this exact SHA-256 prefix. Stamping the
    # already npm-ci-installed tree avoids any runtime npm installation.
    atomic(bridge / 'node_modules/.hermes-pkg-hash',
           hashlib.sha256((bridge / 'package.json').read_bytes()).hexdigest()[:16], mode=0o644)
    build_home = root / 'build-home'
    profiles = build_home / '.hermes/profiles'
    stage_directory(profiles, root)
    # Exercise the same supported custom-profile root resolution as the live
    # data link, but target disposable credential-free data outside native HOME.
    probe = profiles / '.origin-probe'  # Hidden from upstream served-profile discovery.
    stage_directory(probe, root)
    probe_data = root / 'probe-data'
    if probe_data.exists() or probe_data.is_symlink():
        raise ValueError('Builder supplied the reserved probe-data path')
    probe.rename(probe_data)
    probe.symlink_to(probe_data)
    managed = build_home / 'managed'
    if not managed.exists():
        managed.mkdir(mode=0o755)
        managed.chmod(0o755)
    stage_directory(managed, root)
    atomic(build_home / '.gitconfig', '[safe]\n\tdirectory = ' + str(destination) + '\n', mode=0o644)
    prepare_runtime_locks(destination)


def validate_stage(destination):
    root = destination.parent
    trusted(root)
    for relative in ('source', 'build-home', 'build-home/.hermes',
                     'build-home/.hermes/installs',
                     'build-home/.hermes/profiles', 'probe-data', 'build-home/managed'):
        stage_directory(root / relative, root)
    probe = root / 'build-home/.hermes/profiles/.origin-probe'
    if not probe.is_symlink() or os.readlink(probe) != str(root / 'probe-data'):
        raise ValueError('Probe profile escaped its isolated data directory')
    receipt = json.loads((root / 'origin-stage.json').read_text())
    commit = manifest(destination / 'origin-release.json')['commit']
    if receipt.get('layout') == 2:
        if receipt != {'layout': 2, 'commit': commit}:
            raise ValueError('Incomplete legacy stage')
    elif receipt.get('layout') == 3:
        if set(receipt) != {'layout', 'commit', 'repair'} or receipt['commit'] != commit:
            raise ValueError('Incomplete repaired stage')
        validate_repair(destination, receipt['repair'])
    else:
        raise ValueError('Incomplete or unsupported cached stage')
    bridge = destination / 'scripts/whatsapp-bridge'
    stage_directory(bridge / 'node_modules', root)
    package = bridge / 'package.json'
    stamp = bridge / 'node_modules/.hermes-pkg-hash'
    if package.is_symlink() or stamp.is_symlink() or stamp.read_text().strip() != hashlib.sha256(package.read_bytes()).hexdigest()[:16]:
        raise ValueError('Immutable bridge dependencies are not prepared')
    state_root = runtime_state(destination)
    stage_directory(state_root, root)
    facts = state_root / 'facts.json'
    if facts.is_symlink():
        raise ValueError('Runtime facts must be immutable regular data')
    environment = Path(json.loads(facts.read_text())['packages']['venv']['environment'])
    if not environment.is_relative_to(state_root / 'environments'):
        raise ValueError('Runtime environment escaped the immutable install')
    stage_directory(environment, root)
    coordinator = root / 'build-home/.hermes/profiles/coordinator'
    account = pwd.getpwnam(USER)
    locks = runtime_locks(destination)
    lease_roots = runtime_lease_roots(destination)
    for lock in locks:
        info = lock.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != account.pw_uid or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Runtime lock permissions changed')
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            item = Path(folder) / name
            info = item.lstat()
            if item in locks:
                continue
            if (name == '.leases' and (item.parent / '.lease-managed').is_file() and
                    any(item.is_relative_to(generations) for generations in lease_roots)):
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid or info.st_mode & 0o077:
                    raise ValueError('Runtime lease permissions changed')
                directories.remove(name)
                continue
            if info.st_uid != ADMIN_UID:
                raise ValueError('Executable runtime ownership changed')
            if stat.S_ISLNK(info.st_mode):
                if item == coordinator and os.readlink(item) == str(DATA):
                    continue  # Historical stage metadata, never the live runtime home.
                target = item.resolve(strict=True)
                if target in locks or (target.is_relative_to(state_root) and '.leases' in target.relative_to(state_root).parts):
                    raise ValueError('Executable symlink points into mutable lock/lease storage')
                if target.is_relative_to(root):
                    stage_directory(target if target.is_dir() else target.parent, root)
                    if target.lstat().st_uid != ADMIN_UID or target.lstat().st_mode & 0o022:
                        raise ValueError('Runtime symlink targets mutable data')
                if not target.is_relative_to(root):
                    trusted(target)
                    if not any(target.is_relative_to(system) for system in (Path('/usr'), Path('/lib'), Path('/lib64'))):
                        raise ValueError('Runtime symlink escapes immutable code/system storage')
            elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or info.st_mode & 0o6022:
                raise ValueError('Executable runtime permissions changed')
            elif stat.S_ISDIR(info.st_mode) and info.st_mode & 0o005 != 0o005:
                raise ValueError('Runtime directory is not traversable by the service account')
            elif stat.S_ISREG(info.st_mode) and not info.st_mode & 0o004:
                raise ValueError('Runtime file is not readable by the service account')


def runtime_environment(destination):
    state_environment = {
        'XDG_STATE_HOME': str(HOME / '.local/state'),
        'HERMES_GATEWAY_LOCK_DIR': str(HOME / '.local/state/hermes/gateway-locks'),
    }
    validate_stage(destination)
    build_home = destination.parent / 'build-home'
    return {'HOME': str(build_home), 'HERMES_HOME': str(DATA),
            'HERMES_RUNTIME_DIR': str(build_home / '.hermes/tools'), **state_environment}


def runtime_run(destination, args, *, interactive=False, **kwargs):
    """Owner maintenance shares the gateway's protected default-profile layout."""
    root_required()
    require_offline()
    index = runtime_index(destination, create=True)
    if DATA.is_symlink() or not DATA.is_dir() or (DATA / 'installs').is_symlink():
        raise ValueError('Private runtime mountpoints must not be symlinks')
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'USER': USER, 'LOGNAME': USER,
                   'TERM': os.environ.get('TERM', 'xterm-256color'),
                   'HERMES_MANAGED_DIR': str(MANAGED), 'HERMES_SUPERVISED_CHILD': '1',
                   'PYTHONDONTWRITEBYTECODE': '1', **runtime_environment(destination)}
    return run(['systemd-run', '--quiet', '--wait', '--collect',
                '--pty' if interactive else '--pipe',
                '--unit=origin-hermes-maintenance-' + str(time.time_ns()),
                '--property=User=' + USER, '--property=Group=' + USER,
                '--property=UMask=0077', '--property=NoNewPrivileges=yes',
                '--property=ProtectSystem=strict', '--property=ProtectHome=yes',
                '--property=PrivateTmp=yes', '--property=PrivateDevices=yes',
                '--property=CapabilityBoundingSet=', '--property=RestrictSUIDSGID=yes',
                '--property=ReadWritePaths=' + str(HOME) + ' ' + str(runtime_state(destination).parent),
                '--property=BindPaths=' + str(DATA),
                '--property=BindReadOnlyPaths=' + str(index) + ':' + str(DATA / 'installs'),
                '--property=WorkingDirectory=' + str(HOME), '--property=RuntimeMaxSec=1800',
                '--property=MemoryMax=2G', '--property=CPUQuota=100%', '--property=TasksMax=128',
                '/usr/bin/env', '-i', *[key + '=' + value for key, value in environment.items()],
                *args], **kwargs)


def gateway():
    if os.geteuid() != pwd.getpwnam(USER).pw_uid or os.geteuid() == 0:
        raise ValueError('Gateway must run as the unprivileged service account')
    destination = (BASE / 'current').resolve(strict=True)
    validate_runtime_projection(destination)
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'USER': USER, 'LOGNAME': USER,
                   'HERMES_MANAGED_DIR': str(MANAGED), 'HERMES_SUPERVISED_CHILD': '1',
                   'PYTHONDONTWRITEBYTECODE': '1', **runtime_environment(destination)}
    os.execve(destination / '.hermes/bin/hermes',
              [str(destination / '.hermes/bin/hermes'), 'gateway', 'run', '--external-supervisor'],
              environment)


def activate(destination):
    # Services are stopped throughout activation/recovery. Keep a separate
    # root-owned runtime pointer so systemd paths need no lexical ".." traversal.
    runtime = BASE / 'current-runtime'
    runtime_index(destination, create=True)
    pending_runtime = BASE / 'current-runtime.new'
    pending_runtime.unlink(missing_ok=True)
    pending_runtime.symlink_to(destination.parent / 'build-home/.hermes')
    os.replace(pending_runtime, runtime)
    temporary = BASE / 'current.new'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(destination)
    os.replace(temporary, BASE / 'current')


def install():
    if (BASE / 'current').exists() or HOME.exists():
        raise ValueError('Existing deployment/home found; refusing to overwrite')
    for binary in ('git', 'curl', 'bash', 'tar', 'runuser', 'useradd', 'systemctl', 'systemd-run', 'pgrep'):
        if not shutil.which(binary):
            raise ValueError('Missing prerequisite: ' + binary)
    try:
        pwd.getpwnam(USER)
    except KeyError:
        run(['useradd', '--system', '--user-group', '--home-dir', HOME, '--create-home', '--shell', '/usr/sbin/nologin', USER])
    try:
        pwd.getpwnam(USER + '-build')
    except KeyError:
        run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir',
             '/nonexistent', '--shell', '/usr/sbin/nologin', USER + '-build'])
    account = pwd.getpwnam(USER)
    HOME.mkdir(mode=0o700, exist_ok=True)
    os.chown(HOME, account.pw_uid, account.pw_gid)
    HOME.chmod(0o700)
    DATA.mkdir(mode=0o700)
    os.chown(DATA, account.pw_uid, account.pw_gid)
    for directory in (BASE, BASE / 'releases', ADMIN, MANAGED):
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        directory.chmod(0o755)
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ('manage.py', 'runtime_repair.py', 'release.json', 'managed-config.json'):
        shutil.copyfile(ASSETS / name, ADMIN / name)
        (ADMIN / name).chmod(0o644)
    save(MANAGED / 'config.yaml', json.loads((ASSETS / 'managed-config.json').read_text()), mode=0o644)
    destination = install_release(manifest(ASSETS / 'release.json'))
    activate(destination)
    for name in ('origin-hermes.service', 'origin-hermes-update-check.service', 'origin-hermes-update-check.timer'):
        shutil.copyfile(ASSETS / name, Path('/etc/systemd/system') / name)
        (Path('/etc/systemd/system') / name).chmod(0o644)
    run(['systemctl', 'daemon-reload'])
    print('Pinned release installed. Configure, log in and pair manually before enabling service; see --help.')


def configure():
    if (DATA / '.env').exists() and 'ORIGIN_MCP_TOKEN=' in (DATA / '.env').read_text():
        raise ValueError('Origin credentials already configured; rotate them explicitly')
    url = input('Exact Origin HTTPS MCP URL (from Origin integration settings): ').strip()
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('HTTPS MCP URL without credentials/query/fragment required')
    token = getpass.getpass('Per-owner scoped Origin MCP token (not controller/worker/integration secret): ').strip()
    if not token or not re.fullmatch(r'[A-Za-z0-9._~-]+', token):
        raise ValueError('Invalid bearer token')
    phone = input('Your personal WhatsApp number: country code + digits, WITHOUT plus: ').strip()
    if not re.fullmatch(r'[1-9][0-9]{6,14}', phone):
        raise ValueError('Phone must be 7-15 digits with country code')
    account = pwd.getpwnam(USER)
    atomic(DATA / '.env', 'ORIGIN_MCP_URL=' + url + '\nORIGIN_MCP_TOKEN=' + token + '\n', owner=account)
    atomic(MANAGED / '.env', '\n'.join([
        'WHATSAPP_ENABLED=true', 'WHATSAPP_MODE=self-chat', 'WHATSAPP_ALLOWED_USERS=' + phone,
        'WHATSAPP_ALLOW_ALL_USERS=false', 'WHATSAPP_GROUP_POLICY=pairing',
        'WHATSAPP_GROUP_ALLOWED_USERS=', 'WHATSAPP_DM_POLICY=allowlist',
        'HERMES_YOLO_MODE=false', '']) , mode=0o640)
    os.chown(MANAGED / '.env', 0, account.pw_gid)
    print('Owner-only self-chat configured. Native provider login and human QR pairing are still required.')


def service_pid():
    result = run(['systemctl', 'show', SERVICE, '--property=MainPID', '--value'], capture_output=True, text=True)
    return int(result.stdout.strip())


def state(expected='running', idle=False):
    value = json.loads((DATA / 'gateway_state.json').read_text())
    stamp = datetime.fromisoformat(value['updated_at'].replace('Z', '+00:00')).timestamp()
    if not -5 <= time.time() - stamp <= 120:
        raise ValueError('Gateway heartbeat missing or stale; idleness/health unknown')
    if value.get('gateway_state') != expected or value.get('pid') != service_pid() or value.get('pid', 0) <= 0:
        raise ValueError('Gateway state/PID does not match supervised process')
    if idle and (type(value.get('active_agents')) is not int or value['active_agents'] != 0
                 or 'active_work' not in value or value['active_work'] not in (None, [])):
        raise ValueError('Gateway has active or unknown work')
    return value


def health():
    preflight()
    value = state()
    platform = value.get('platforms', {}).get('whatsapp', {})
    if platform.get('state') != 'connected':
        raise ValueError('WhatsApp is not connected; pair manually or investigate gateway logs')
    # JSON-RPC request uses the actual MCP protocol, not an invented health route.
    env = {}
    for line in (DATA / '.env').read_text().splitlines():
        key, separator, text = line.partition('=')
        if separator:
            env[key] = text
    endpoint = urllib.parse.urlsplit(env['ORIGIN_MCP_URL'])
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError('Origin health requires the configured credential-free HTTPS endpoint')
    headers = {'Authorization': 'Bearer ' + env['ORIGIN_MCP_TOKEN'], 'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26'}
    _, initialized_headers = request(env['ORIGIN_MCP_URL'], json.dumps({
        'jsonrpc': '2.0', 'id': 0, 'method': 'initialize',
        'params': {'protocolVersion': '2025-03-26', 'capabilities': {},
                   'clientInfo': {'name': 'origin-hermes-health', 'version': '1'}}}).encode(),
        headers, with_headers=True)
    for key, value in initialized_headers.items():
        if key.lower() == 'mcp-session-id':
            headers['Mcp-Session-Id'] = value
    request(env['ORIGIN_MCP_URL'], json.dumps({
        'jsonrpc': '2.0', 'method': 'notifications/initialized'}).encode(), headers)
    body = request(env['ORIGIN_MCP_URL'], json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}).encode(), headers)
    # Origin's stateless MCP endpoint may encode the response as JSON or SSE.
    if body.lstrip().startswith(b'{'):
        reply = json.loads(body)
    else:
        messages = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
        reply = next((item for item in messages if item.get('id') == 1), {})
    names = {tool['name'] for tool in reply.get('result', {}).get('tools', [])}
    required = {'get_workspace', 'start_execution_run', 'get_execution_run', 'cancel_execution_run'}
    if not required <= names:
        raise ValueError('Origin MCP authorization/tool availability health check failed')
    print('Gateway heartbeat, WhatsApp connection and Origin MCP tools are healthy; LLM not exercised.')


def native_auth_health():
    # Read native Hermes state locally; never refresh, import another CLI's
    # credentials, request model output, pair a phone or start an OAuth login.
    config = json.loads((MANAGED / 'config.yaml').read_text())
    model = config.get('model', {})
    if model.get('provider') != 'openai-codex' or not model.get('default') or config.get('fallback_providers'):
        raise ValueError('Automatic health requires an explicit managed Codex model without fallbacks')
    auth = DATA / 'auth.json'
    if auth.is_symlink() or auth.stat().st_mode & 0o077:
        raise ValueError('Native auth must be private and machine-local')
    tokens = json.loads(auth.read_text())['providers']['openai-codex']['tokens']
    if not tokens.get('refresh_token'):
        raise ValueError('Native OAuth is not configured')
    payload = tokens['access_token'].split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    expiry = claims.get('exp')
    if type(expiry) not in (int, float) or expiry <= time.time() + 300:
        raise ValueError('Native OAuth validity unknown or expiring; human/native maintenance required')


def drain():
    state(idle=True)
    marker = DATA / '.drain_request.json'
    if marker.exists():
        raise ValueError('Existing drain belongs to another maintenance owner')
    # Pinned upstream gateway/drain_control.py contract, consumed every second.
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    pid1_start = Path('/proc/1/stat').read_text().rsplit(')', 1)[1].split()[19]
    save(marker, {'action': 'drain', 'requested_at': datetime.now(timezone.utc).isoformat(),
                  'principal': 'origin-supervised-maintenance', 'epoch': boot + ':' + pid1_start,
                  'suppress_notification': True}, owner=pwd.getpwnam(USER))
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                state(expected='draining', idle=True)
                return
            except ValueError:
                time.sleep(1)
        raise ValueError('Gateway did not acknowledge an idle drain; update refused')
    except BaseException:
        marker.unlink(missing_ok=True)
        raise


def require_offline():
    # Offline repair must not stop an active gateway or an interactive login.
    active = subprocess.run(
        ['systemctl', 'show', SERVICE, '--property=ActiveState', '--value'],
        capture_output=True, text=True, check=True).stdout.strip()
    if active not in ('inactive', 'failed') or service_pid() != 0:
        raise ValueError('Offline repair requires an already stopped gateway')
    result = subprocess.run(['pgrep', '-u', str(pwd.getpwnam(USER).pw_uid)], capture_output=True)
    if result.returncode != 1:
        raise ValueError('Service-user activity must stop before offline repair')


def repair_offline(pin, maintenance):
    if not maintenance:
        raise ValueError('Explicit --maintenance authorization is required')
    if JOURNAL.exists():
        raise ValueError('Interrupted maintenance exists; use recover --maintenance first')
    require_offline()
    previous = (BASE / 'current').resolve(strict=True)
    validate_stage(previous)
    if manifest(previous / 'origin-release.json') != pin:
        raise ValueError('Offline repair cannot change the upstream release')
    policy_before = policy_digest()
    destination = install_release(pin)
    candidate_policy_probe(destination)
    require_offline()
    if policy_digest() != policy_before:
        raise ValueError('Policy changed during offline staging')
    journal = {'previous': str(previous), 'target': pin, 'automatic': False, 'mode': 'offline-repair'}
    save(JOURNAL, journal)
    try:
        activate(destination)
        preflight()
        require_offline()
        if policy_digest() != policy_before:
            raise ValueError('Policy changed during offline activation')
        JOURNAL.unlink()
        print('Reviewed runtime repair activated; gateway remains stopped; previous release retained.')
    except BaseException:
        rollback(journal)
        raise


def stopped():
    run(['systemctl', 'stop', SERVICE])
    if service_pid() != 0:
        raise ValueError('Gateway process still running')
    result = subprocess.run(['pgrep', '-u', str(pwd.getpwnam(USER).pw_uid)], capture_output=True)
    if result.returncode != 1:
        raise ValueError('Other Hermes-user processes may hold state; stop them before maintenance')


def backup():
    folder = BACKUPS / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + str(os.getpid()))
    folder.mkdir(mode=0o700)
    archive = folder / 'home.tar.gz'
    # GNU tar archives symlinks as links; never dereference service-controlled paths.
    run(['tar', '--create', '--gzip', '--file', archive, '--directory', HOME, '.'])
    archive.chmod(0o600)
    with gzip.open(archive, 'rb') as f:
        while f.read(1024 * 1024):
            pass  # Read to EOF, checking gzip CRC before any upgrade begins.
    with archive.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
        os.fsync(f.fileno())
    save(folder / 'receipt.json', {'sha256': digest, 'archive': str(archive), 'home': str(HOME)})
    return archive, digest


def rollback(journal):
    if journal.get('mode') == 'offline-repair':
        # This path never changes HOME or starts an unauthenticated gateway.
        require_offline()
        previous = Path(journal['previous'])
        validate_stage(previous)
        activate(previous)
        JOURNAL.unlink()
        print('Previous immutable runtime restored; gateway remains stopped; private HOME untouched.')
        return
    try:
        validate_stage(Path(journal['previous']))
        stopped()
        if 'archive' in journal:
            archive = Path(journal['archive'])
            with archive.open('rb') as f:
                if hashlib.file_digest(f, 'sha256').hexdigest() != journal['sha256']:
                    raise ValueError('Backup hash mismatch; service left stopped')
            failed_home = HOME.with_name(HOME.name + '.failed-' + str(time.time_ns()))
            HOME.rename(failed_home)
            account = pwd.getpwnam(USER)
            HOME.mkdir(mode=0o700)
            os.chown(HOME, account.pw_uid, account.pw_gid)
            # Extraction is unprivileged. Root never follows archive paths or symlinks.
            with archive.open('rb') as f:
                as_user(['tar', '--extract', '--gzip', '--no-same-owner', '--file', '-', '--directory', HOME], stdin=f)
        (DATA / '.drain_request.json').unlink(missing_ok=True)
        activate(Path(journal['previous']))
        preflight()
        run(['systemctl', 'start', SERVICE])
        wait_healthy()
        JOURNAL.unlink()
        print('Previous release/home restored. Failed home, if any, retained privately for investigation.')
    except BaseException:
        subprocess.run(['systemctl', 'stop', SERVICE], check=False)
        raise


def wait_healthy():
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            health()
            return
        except (ValueError, OSError, KeyError):
            time.sleep(5)
    raise ValueError('Health deadline exceeded')


def idle_processes():
    """An interactive CLI/login outside the gateway cgroup also holds state."""
    pid = service_pid()
    group = Path('/proc/' + str(pid) + '/cgroup').read_text().strip()
    if pid <= 0 or not re.fullmatch(r'0::/.*/' + re.escape(SERVICE), group):
        raise ValueError('Gateway service cgroup is unknown')
    result = subprocess.run(['pgrep', '-u', str(pwd.getpwnam(USER).pw_uid)],
                            capture_output=True, text=True)
    pids = result.stdout.split()
    if result.returncode != 0 or str(pid) not in pids:
        raise ValueError('Gateway process ownership is unknown')
    for process in pids:
        if not process.isdigit() or Path('/proc/' + process + '/cgroup').read_text().strip() != group:
            raise ValueError('Other service-user activity requires administrator review')


def update(pin, maintenance, automatic=False):
    if not maintenance:
        raise ValueError('Explicit --maintenance authorization is required')
    if JOURNAL.exists():
        raise ValueError('Interrupted maintenance exists; use recover --maintenance first')
    previous = (BASE / 'current').resolve(strict=True)
    old = manifest(previous / 'origin-release.json')
    if version(pin)[0] != version(old)[0]:
        raise ValueError('Major upgrades require a separately reviewed deployment migration')
    release_metadata(pin)
    state(idle=True)
    idle_processes()
    health()
    if automatic:
        native_auth_health()
    policy_before = policy_digest()
    # Staging has no live home access. Its failure never stops the gateway.
    try:
        destination = install_release(pin)
        candidate_policy_probe(destination)
    except BaseException:
        if automatic:
            quarantine(pin)
        raise
    # Work/configuration may have changed while staging; defer without draining.
    state(idle=True)
    idle_processes()
    health()
    if automatic:
        native_auth_health()
    if policy_digest() != policy_before:
        raise ValueError('Policy changed during staging; administrator review required')
    journal = {'previous': str(previous), 'target': pin, 'automatic': automatic}
    save(JOURNAL, journal)
    drained = False
    try:
        drain()
        drained = True
        stopped()
        archive, digest = backup()
        journal.update(archive=str(archive), sha256=digest)
        save(JOURNAL, journal)
        activate(destination)
        preflight()
        if policy_digest() != policy_before:
            raise ValueError('Policy changed during activation')
        (DATA / '.drain_request.json').unlink(missing_ok=True)
        run(['systemctl', 'start', SERVICE])
        wait_healthy()
        if automatic:
            native_auth_health()
        JOURNAL.unlink()
        print('Pinned stable update healthy; backup and previous release retained.')
    except BaseException:
        if drained:
            try:
                rollback(journal)
            finally:
                if automatic:
                    quarantine(pin)
        else:
            JOURNAL.unlink(missing_ok=True)
        raise


def check_updates(apply=False):
    release = json.loads(request(API + '/releases/latest'))
    if release.get('draft') is not False or release.get('prerelease') is not False or not re.fullmatch(r'v\d+\.\d+\.\d+', release.get('tag_name', '')):
        raise ValueError('Latest release metadata is not stable')
    current = manifest(BASE / 'current/origin-release.json')
    tag = release['tag_name']
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'installed': current['tag'],
              'available': tag, 'url': 'https://github.com/NousResearch/hermes-agent/releases/tag/' + tag,
              'updateAvailable': version({'tag': tag}) > version(current), 'applied': False}
    try:
        if not apply or not AUTO_POLICY.exists():
            result['status'] = 'check-only'
            return
        trusted(AUTO_POLICY)
        policy = json.loads(AUTO_POLICY.read_text())
        if policy.get('enabled') is not True or policy.get('policyDigest') != policy_digest():
            raise ValueError('Automatic enablement or reviewed policy changed')
        if JOURNAL.exists():
            result['status'] = 'recovery-required'
            return
        if not result['updateAvailable']:
            result['status'] = 'current'
            return
        commit = json.loads(request(API + '/commits/' + tag))['sha']
        if not re.fullmatch('[0-9a-f]{40}', commit):
            raise ValueError('Immutable upstream commit missing')
        pin = {'repository': REPOSITORY, 'tag': tag, 'commit': commit,
               'installerGitBlob': policy['baseline']['installerGitBlob']}
        if (QUARANTINE / (commit + '.json')).exists():
            result['status'] = 'quarantined'
            return
        compatible(pin, policy['baseline'])
        compatible(current, policy['baseline'])
        release_metadata(pin)
        state(idle=True)
        health()
        update(pin, True, automatic=True)
        result.update(applied=True, status='applied')
    except CompatibilityReviewRequired:
        result['status'] = 'administrator-review-required'
        print('Stable release exceeds the restricted cache/compaction automatic scope; '
              'always-latest is not guaranteed. Review and apply a manual pinned update.')
    except (Exception, KeyboardInterrupt):
        # Do not include credential-bearing exception bodies in timer reports.
        result['status'] = 'deferred-or-failed'
        raise
    finally:
        save(UPDATE_STATE, result, mode=0o644)
        print(json.dumps(result))


def chat_policy(path, allow_paid):
    value = json.loads(path.read_text())
    if set(value) != {'model', 'fallback_providers'} or not isinstance(value['fallback_providers'], list):
        raise ValueError('Policy requires model and fallback_providers only')
    candidates = [dict(provider=value['model']['provider'], model=value['model']['default']), *value['fallback_providers']]
    for entry in candidates:
        if set(entry) != {'provider', 'model'} or not all(isinstance(v, str) and v.strip() for v in entry.values()):
            raise ValueError('Every chat selection requires exact provider and model, without credentials/endpoints')
        if entry['provider'] != 'openai-codex' and not allow_paid:
            raise ValueError('Only openai-codex allowed without explicit --allow-paid acknowledgement')
    if set(value['model']) != {'provider', 'default'}:
        raise ValueError('model requires provider and default only')
    config = json.loads((MANAGED / 'config.yaml').read_text())
    config.update(value)
    save(MANAGED / 'config.yaml', config, mode=0o644)
    print('Separate Hermes chat policy saved. Restart in an idle maintenance window; coding policy unchanged.')


def preflight():
    # Upstream logs and ignores malformed managed YAML. Refuse startup instead
    # of accidentally reverting to its broad default toolsets.
    actual = json.loads((MANAGED / 'config.yaml').read_text())
    baseline = json.loads((ADMIN / 'managed-config.json').read_text())
    for key, value in baseline.items():
        if key != 'fallback_providers' and actual.get(key) != value:
            raise ValueError('Managed coordinator security policy differs from the reviewed baseline')
    if set(actual) - set(baseline) - {'model'}:
        raise ValueError('Unreviewed managed configuration keys')
    values = {}
    for line in (MANAGED / '.env').read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator:
            values[key] = value
    if not re.fullmatch(r'[1-9][0-9]{6,14}', values.get('WHATSAPP_ALLOWED_USERS', '')):
        raise ValueError('A single explicit personal phone allowlist is required')
    if any(values.get(k) != v for k, v in {
        'WHATSAPP_ENABLED': 'true', 'WHATSAPP_MODE': 'self-chat',
        'WHATSAPP_ALLOW_ALL_USERS': 'false', 'WHATSAPP_GROUP_POLICY': 'pairing',
        'WHATSAPP_GROUP_ALLOWED_USERS': '', 'WHATSAPP_DM_POLICY': 'allowlist',
        'HERMES_YOLO_MODE': 'false'}.items()):
        raise ValueError('Managed WhatsApp authorization policy is missing or broadened')
    secret = DATA / '.env'
    if secret.is_symlink() or secret.stat().st_mode & 0o077:
        raise ValueError('Hermes credential file must not be group/world-readable')
    credentials = secret.read_text()
    if not re.search(r'^ORIGIN_MCP_TOKEN=\S+$', credentials, re.MULTILINE):
        raise ValueError('Owner-scoped Origin MCP credential is missing')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['install', 'configure', 'login', 'pair-whatsapp', 'gateway', 'preflight', 'health', 'check-updates', 'daily-updates', 'enable-auto-updates', 'disable-auto-updates', 'update', 'repair-offline', 'recover', 'chat-policy'])
    parser.add_argument('--release', type=Path)
    parser.add_argument('--file', type=Path)
    parser.add_argument('--maintenance', action='store_true')
    parser.add_argument('--allow-paid', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == 'check-updates':
        check_updates()
        return
    if args.command == 'preflight':
        preflight()
        return
    if args.command == 'gateway':
        gateway()
        return
    root_required()
    with open('/run/lock/origin-hermes-maintenance.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'install':
            install()
        elif args.command == 'configure':
            configure()
        elif args.command == 'daily-updates':
            check_updates(apply=True)
        elif args.command in ('enable-auto-updates', 'disable-auto-updates'):
            automatic_policy(args.command == 'enable-auto-updates')
        elif args.command == 'login':
            print('Select ChatGPT or Codex Subscription; human native device login, no copied worker credentials.')
            hermes('model')
        elif args.command == 'pair-whatsapp':
            print('Unofficial Baileys WhatsApp Web bridge: personal account restriction/ban risk. No Meta API fee; no Business conversion.')
            if input('Type I ACCEPT UNOFFICIAL WHATSAPP RISK to open the human pairing wizard: ') != 'I ACCEPT UNOFFICIAL WHATSAPP RISK':
                raise ValueError('Pairing cancelled')
            hermes('whatsapp')
        elif args.command == 'health':
            health()
        elif args.command == 'chat-policy':
            if not args.file:
                raise ValueError('--file is required')
            chat_policy(args.file, args.allow_paid)
        elif args.command == 'update':
            if not args.release:
                raise ValueError('--release reviewed stable manifest is required')
            update(manifest(args.release), args.maintenance)
        elif args.command == 'repair-offline':
            if not args.release:
                raise ValueError('--release is required')
            repair_offline(manifest(args.release), args.maintenance)
        elif args.command == 'recover':
            if not args.maintenance:
                raise ValueError('--maintenance is required')
            journal = json.loads(JOURNAL.read_text())
            if journal.get('automatic'):
                quarantine(journal['target'])
            rollback(journal)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        # Provider/auth subprocesses own their interactive output; never print
        # HTTP bodies, tokens, exception reprs or a secret-bearing traceback.
        print('Hermes supervisor failed: ' + type(error).__name__ + '. Check operator inputs, journal and service status.', file=sys.stderr)
        sys.exit(1)
