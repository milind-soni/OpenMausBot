#!/usr/bin/env python3
"""Origin's unprivileged, one-shot presence and native billing collector.

Operator setup (never run by Hermes):
  install -Dm755 controller.py /opt/origin-controller/controller.py
  python3 /opt/origin-controller/controller.py configure
  install -m644 origin-controller.{service,timer} /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now origin-controller.timer

Requires python3, systemd with LoadCredential, and an authenticated Tailscale
daemon. Optional Boxd billing uses a separately authorized native CLI login in
the controller's private HOME; OAuth never leaves that account. The controller
bearer is scoped only to this workspace. No machine allocation is performed.
"""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import subprocess
import sys
import time
import tempfile
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path('/etc/origin-controller/config.json')
BOXD_VERSION = '0.3.3'
BOXD_BINARY = '/opt/origin-controller/boxd/0.3.3/boxd'
BOXD_URL = 'https://boxd.sh/downloads/cli/boxd-linux-amd64'
BOXD_SHA256 = '38371394b448850f32a2b6b297fe5141c5d8e2afd40037e8d4c93a0a00b0d35f'
NATIVE_HOME = Path('/var/lib/origin-controller')
NATIVE_USER = 'origin-controller-native'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Controller endpoint redirects are forbidden')


def endpoint(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('An HTTPS endpoint without credentials, query or fragment is required')
    if parsed.path != '/api/execution/controller':
        raise ValueError('Endpoint must end in /api/execution/controller')
    return value


def presence(status, peers, observed_at):
    """Missing peers, stale local daemon or missing Online are UNKNOWN, not offline."""
    if status.get('BackendState') != 'Running' or status.get('Self', {}).get('Online') is not True:
        return []
    result = []
    available = status.get('Peer', {})
    if not isinstance(available, dict):
        return []
    for target in peers:
        # Stable Tailscale node ID prevents a reused name from proving absence.
        matches = [p for p in available.values() if isinstance(p, dict)
                   and p.get('ID') == target['peerId']
                   and str(p.get('DNSName', '')).rstrip('.').lower() == target['tailnetName'].rstrip('.').lower()]
        if len(matches) != 1 or type(matches[0].get('Online')) is not bool:
            continue
        result.append({'hostId': target['hostId'], 'tailnetName': target['tailnetName'],
                       'online': matches[0]['Online'], 'observedAt': observed_at})
    return result


def validate(config):
    endpoint(config['url'])
    if not Path(config['tailscaleBinary']).is_absolute():
        raise ValueError('tailscaleBinary must be absolute')
    peers = config['peers']
    if not isinstance(peers, list):
        raise ValueError('peers must be an array')
    seen = set()
    for peer in peers:
        if not all(isinstance(peer.get(k), str) and peer[k].strip() for k in ('hostId', 'peerId', 'tailnetName')):
            raise ValueError('Each peer requires Origin hostId, Tailscale peerId and full tailnetName')
        if peer['hostId'] in seen:
            raise ValueError('Duplicate Origin host mapping')
        seen.add(peer['hostId'])
    if config.get('boxdBinary') not in (None, BOXD_BINARY):
        raise ValueError('boxdBinary must name the pinned controller installation')
    return config


def billing_report(raw, binding, observed_at):
    report = {'source': 'boxd-native-cli', 'version': BOXD_VERSION,
              'orgId': binding['orgId'], 'revision': binding['revision'],
              'observedAt': observed_at, 'status': 'unknown'}
    if not isinstance(raw, dict) or raw.get('id') != binding['orgId']:
        return report
    balance, accruing = raw.get('balance_micro'), raw.get('accruing_micro')
    currency = str(raw.get('currency', '')).upper()
    if raw.get('billing_mode') != 'credits' or currency not in ('EUR', 'USD'):
        return report
    if type(balance) is not int or abs(balance) > 9007199254740991 or type(accruing) is not int or not 0 <= accruing <= 9007199254740991:
        return report
    return {**report, 'status': 'available', 'billingMode': 'credits',
            'currency': currency, 'balanceMicro': balance, 'accruingMicro': accruing}


def post(config, token, body):
    request = urllib.request.Request(config['url'], data=json.dumps(body).encode(), headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'User-Agent': 'origin-controller/1'}, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=15) as response:
        if response.status != 200:
            raise ValueError('Controller request did not succeed')
        data = response.read(1048577)
        if len(data) > 1048576:
            raise ValueError('Controller response exceeds limit')
        return json.loads(data)


def collect_billing(binary, binding):
    observed_at = int(time.time() * 1000)
    raw = None
    try:
        info = Path(binary).stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Native CLI must be administrator-owned')
        env = {'HOME': str(NATIVE_HOME), 'XDG_CONFIG_HOME': str(NATIVE_HOME / '.config'),
               'PATH': '/usr/bin:/bin', 'BOXD_TELEMETRY': '0', 'DO_NOT_TRACK': '1'}
        version = subprocess.run([binary, '--version'], env=env, stdin=subprocess.DEVNULL,
                                 capture_output=True, check=True, timeout=3)
        if version.stdout.decode().strip() != 'boxd ' + BOXD_VERSION:
            raise ValueError('Native CLI version changed')
        completed = subprocess.run([binary, '--json', 'manage', 'billing'], env=env,
                                   stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=10)
        raw = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, ValueError, UnicodeError):
        print('Native Boxd billing unavailable; no credit admission evidence', file=sys.stderr)
    # Timestamp acquisition began, not when a delayed subprocess finally returned.
    return billing_report(raw, binding, observed_at)


def tick(config, token):
    reports = []
    try:
        completed = subprocess.run([config['tailscaleBinary'], 'status', '--json'],
                                   capture_output=True, check=True, timeout=10)
        status = json.loads(completed.stdout)
        reports = presence(status, config['peers'], int(time.time() * 1000))
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
        print('Tailscale observation unavailable; reporting no presence evidence', file=sys.stderr)
    if not token or re.search(r'\s', token):
        raise ValueError('Missing or malformed controller bearer')
    payload = {'op': 'tick', 'localPresence': reports}
    if config.get('boxdBinary'):
        try:
            binding = post(config, token, {'op': 'billingContext'}).get('boxdBilling')
            if isinstance(binding, dict) and isinstance(binding.get('orgId'), str) and isinstance(binding.get('revision'), str):
                payload['boxdBilling'] = collect_billing(config['boxdBinary'], binding)
        except (OSError, ValueError, urllib.error.URLError):
            print('Native billing context unavailable; old evidence will expire', file=sys.stderr)
    post(config, token, payload)
    print(f'Controller tick accepted; explicit peer observations: {len(reports)}')


def native_account():
    if os.geteuid() != 0:
        raise ValueError('Controller account provisioning requires administrator')
    try:
        account = pwd.getpwnam(NATIVE_USER)
    except KeyError:
        subprocess.run(['useradd', '--system', '--home-dir', str(NATIVE_HOME), '--shell', '/usr/sbin/nologin', NATIVE_USER], check=True)
        account = pwd.getpwnam(NATIVE_USER)
    if account.pw_dir != str(NATIVE_HOME) or account.pw_uid == 0:
        raise ValueError('Existing controller account has an unexpected home or uid')
    for directory in (NATIVE_HOME, NATIVE_HOME / '.config'):
        if directory.is_symlink():
            raise ValueError('Controller home directories must not be symlinks')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
        os.chown(directory, account.pw_uid, account.pw_gid)


def install_boxd():
    """Administrator-only installation; authenticating is a separate owner action."""
    if os.geteuid() != 0 or platform.machine() != 'x86_64':
        raise ValueError('Pinned Boxd installation requires administrator on Linux x86_64')
    native_account()
    destination = Path(BOXD_BINARY)
    if destination.is_symlink() or destination.parent.is_symlink():
        raise ValueError('Pinned executable paths must not be symlinks')
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if destination.exists():
        if hashlib.sha256(destination.read_bytes()).hexdigest() != BOXD_SHA256:
            raise ValueError('Existing pinned Boxd binary differs; inspect before replacing')
    else:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(BOXD_URL, timeout=120) as response:
            binary = response.read(100_000_001)
        if len(binary) > 100_000_000 or hashlib.sha256(binary).hexdigest() != BOXD_SHA256:
            raise ValueError('Pinned Boxd download checksum mismatch')
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stage:
            temporary = Path(stage.name)
            try:
                stage.write(binary)
                stage.flush()
                temporary.chmod(0o755)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
    print('Pinned Boxd installed. Add boxdBinary=' + BOXD_BINARY + ' to controller config.')
    print('Owner login: runuser -u ' + NATIVE_USER + ' -- env HOME=' + str(NATIVE_HOME)
          + ' XDG_CONFIG_HOME=' + str(NATIVE_HOME / '.config') + ' ' + BOXD_BINARY + ' auth login')


def configure():
    if os.geteuid() != 0:
        raise ValueError('Run configure as the deployment administrator')
    if CONFIG.exists():
        raise ValueError('Config exists; edit it explicitly rather than overwriting')
    url = endpoint(input('Origin HTTPS controller endpoint: ').strip())
    binary = input('Absolute tailscale executable [/usr/bin/tailscale]: ').strip() or '/usr/bin/tailscale'
    peers = []
    print('Copy stable ID and DNSName from tailscale status --json. Blank host ID finishes.')
    while host_id := input('Origin enrolled local host ID: ').strip():
        peers.append({'hostId': host_id, 'peerId': input('Tailscale peer ID: ').strip(),
                      'tailnetName': input('Full Tailscale DNSName: ').strip()})
    config = validate({'url': url, 'tailscaleBinary': binary, 'peers': peers})
    token = getpass.getpass('Separate scoped controller service bearer: ').strip()
    if not token or re.search(r'\s', token):
        raise ValueError('A nonempty bearer without whitespace is required')
    native_account()
    CONFIG.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    CONFIG.parent.chmod(0o755)
    secret = CONFIG.parent / 'service-token'
    with open(secret, 'x', opener=lambda p, f: os.open(p, f, 0o600)) as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(token + '\n')
    with open(CONFIG, 'x', opener=lambda p, f: os.open(p, f, 0o644)) as f:
        os.fchmod(f.fileno(), 0o644)
        json.dump(config, f, indent=2)
        f.write('\n')
    print('Configuration saved; no service has been started.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['tick', 'configure', 'install-boxd'])
    parser.add_argument('--config', type=Path, default=CONFIG)
    args = parser.parse_args()
    if args.command == 'configure':
        configure()
    elif args.command == 'install-boxd':
        install_boxd()
    else:
        config = validate(json.loads(args.config.read_text()))
        credential_dir = os.environ.get('CREDENTIALS_DIRECTORY')
        if not credential_dir:
            raise ValueError('Run tick using the supplied systemd unit and LoadCredential')
        tick(config, (Path(credential_dir) / 'service-token').read_text().strip())


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f'Controller rejected tick (HTTP {error.code}); no presence inferred', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Deliberately exclude exception text from network/subprocess failures.
        print(f'Controller failed ({type(error).__name__}); inspect configuration and service state', file=sys.stderr)
        sys.exit(1)
