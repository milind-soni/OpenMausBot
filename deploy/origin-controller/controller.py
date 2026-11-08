#!/usr/bin/env python3
"""Origin's unprivileged, one-shot presence collector; invoke every 15 seconds.

Operator setup (never run by Hermes):
  install -Dm755 controller.py /opt/origin-controller/controller.py
  python3 /opt/origin-controller/controller.py configure
  install -m644 origin-controller.{service,timer} /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now origin-controller.timer

Requires python3, systemd with LoadCredential, and an already authenticated
Tailscale daemon. Configure the service bearer in Origin first; it must be scoped
only to the intended workspace/controller tick, NOT an owner MCP or worker token.
No tailscale login, SSH, cloud-provider access or machine enrollment is performed.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path('/etc/origin-controller/config.json')


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
    return config


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
    payload = json.dumps({'op': 'tick', 'localPresence': reports}).encode()
    request = urllib.request.Request(config['url'], data=payload, headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'User-Agent': 'origin-controller/1'}, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=30) as response:
        if response.status != 200:
            raise ValueError('Controller tick did not succeed')
        # Never log response bodies: they may include run metadata or secrets.
        response.read(1048576)
    print(f'Controller tick accepted; explicit peer observations: {len(reports)}')


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
    parser.add_argument('command', choices=['tick', 'configure'])
    parser.add_argument('--config', type=Path, default=CONFIG)
    args = parser.parse_args()
    if args.command == 'configure':
        configure()
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
