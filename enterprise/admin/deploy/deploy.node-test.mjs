// Offline template contract only; this does not qualify systemd/Caddy on Linux.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

test('portal identity and sockets stay separate from tenant runtime authority', () => {
  const unit = read('openmausbot-admin.service');
  for (const line of ['User=omb-admin', 'Group=caddy', 'SupplementaryGroups=omb-admin',
    'RuntimeDirectory=openmausbot-admin', 'RuntimeDirectoryMode=0750',
    'StateDirectoryMode=0700', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
    'InaccessiblePaths=-/var/lib/openmausbot', 'EnvironmentFile=/etc/openmausbot/admin.env',
    'EnvironmentFile=/etc/openmausbot/admin-license.env']) assert.ok(unit.includes(line), line);
  assert.ok(unit.includes('ExecStart=/usr/bin/node /opt/openmausbot/enterprise/admin/dist/server.mjs'));
  const env = read('admin.env.example');
  const origin = /^OMB_ADMIN_URL=(.+)$/m.exec(env)[1];
  assert.equal(origin, 'https://admin.example.com');
  assert.match(env, /^OMB_ADMIN_SOCKET=\/run\/openmausbot-admin\/http.sock$/m);
  assert.match(env, /^OMB_FLEET_SOCKET=\/run\/openmausbot\/fleet.sock$/m);
  assert.match(env, /^OMB_ADMIN_MAIL_FROM="OpenMausBot <access@example.com>"$/m);
  assert.ok(/^OMB_ADMIN_SECRET=(.+)$/m.exec(env)[1].length < 32, 'example secret must fail production validation');
  assert.doesNotMatch(env, /^OMB_ADMIN_PORT=|^ANTHROPIC_API_KEY=/m);
  assert.match(read('openmausbot-fleet-admin.conf'), /^EnvironmentFile=\/etc\/openmausbot\/admin-license.env$/m);
});

test('Caddy uses exact-host routing and a private reload endpoint', () => {
  const caddy = read('Caddyfile');
  assert.match(caddy, /^admin\.example\.com \{$/m);
  assert.match(caddy, /reverse_proxy unix\/\/run\/openmausbot-admin\/http.sock/);
  assert.match(caddy, /header_up Host admin.example.com/);
  assert.match(caddy, /header_up X-OMB-Client-IP \{remote_host\}/);
  assert.match(caddy, /admin unix\/\/run\/caddy-admin\/admin.sock/);
  assert.doesNotMatch(caddy, /localhost:2019|admin off/);
  const unit = read('caddy-admin.conf');
  assert.match(unit, /^RuntimeDirectoryMode=0750$/m);
  assert.match(unit, /--address unix\/\/run\/caddy-admin\/admin.sock/);
});
