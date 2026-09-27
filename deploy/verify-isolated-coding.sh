#!/bin/sh
# Run as the configured guest user AFTER the computer starts, never on the
# shared backend. No model call, API key, or user project is used.
set -eu
test "$(codex --version)" = "codex-cli 0.157.1"
python3 - <<'PY'
import os, pathlib, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix='.nation-coding-check-', dir=pathlib.Path.home()) as temp:
    root = pathlib.Path(temp)
    project = root / 'project'
    project.mkdir()
    outside = root / 'outside'
    outside.mkdir()
    config = root / 'config'
    config.mkdir()
    program = '''import pathlib, socket
p = pathlib.Path('proof.txt')
p.write_text('WORKSPACE_WRITE_OK')
assert p.read_text() == 'WORKSPACE_WRITE_OK'
try:
    pathlib.Path(%r).write_text('BREACH')
    raise AssertionError('Outside project write was permitted')
except OSError as e:
    assert e.errno in (1, 13, 30), e
try:
    with socket.socket() as s:
        s.settimeout(3)
        s.connect(('1.1.1.1', 443))
    raise AssertionError('Shell network access was permitted')
except OSError:
    pass
print('PASS: project write/read, outside write denied, shell network denied')
''' % str(outside / 'forbidden')
    env = {'PATH': os.environ['PATH'], 'HOME': str(pathlib.Path.home()), 'CODEX_HOME': str(config)}
    subprocess.run(['codex', 'sandbox', '-P', ':workspace', '-C', str(project), '--', 'python3', '-c', program], env=env, check=True, timeout=30)
    assert (project / 'proof.txt').read_text() == 'WORKSPACE_WRITE_OK'
    assert not (outside / 'forbidden').exists()
PY
