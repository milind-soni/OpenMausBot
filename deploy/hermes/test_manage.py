import importlib.util
import base64
import hashlib
import os
import subprocess
import tarfile
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('hermes_manage', Path(__file__).with_name('manage.py'))
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.base = self.root / 'base'
        self.base.mkdir()
        self.previous = self.base / 'previous'
        self.previous.mkdir()
        (self.base / 'current').symlink_to(self.previous)
        self.pin = {'tag': 'v0.23.1', 'commit': 'a' * 40, 'installerGitBlob': 'b' * 40,
                    'repository': manage.REPOSITORY}
        (self.previous / 'origin-release.json').write_text(json.dumps({**self.pin, 'tag': 'v0.23.0'}))
        self.patches = [patch.object(manage, 'DATA', self.data), patch.object(manage, 'BASE', self.base),
                        patch.object(manage, 'JOURNAL', self.root / 'maintenance.json'),
                        patch.object(manage, 'ADMIN_UID', os.getuid())]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def staged_release(self):
        root = self.base / 'releases' / (self.pin['commit'] + '-supervised-2')
        destination = root / 'source'
        runtime = root / 'build-home/.hermes'
        state = manage.runtime_state(destination)
        environment = state / 'environments/generation/venv'
        bootstrap = state / 'pm-runtime/generations/bootstrap'
        for path in (destination / '.hermes/bin', destination / 'scripts/whatsapp-bridge/node_modules',
                     runtime / 'profiles', runtime / 'tools', root / 'probe-data',
                     root / 'build-home/managed', environment / 'bin', bootstrap / 'bin'):
            path.mkdir(parents=True, exist_ok=True)
        for folder, _, _ in os.walk(root):
            Path(folder).chmod(0o755)
        files = {
            root / 'origin-stage.json': json.dumps({'layout': 2, 'commit': self.pin['commit']}),
            destination / 'origin-release.json': json.dumps(self.pin),
            state / 'facts.json': json.dumps({'packages': {'venv': {'environment': str(environment)}}}),
            state / '.install.lock': '',
            state / 'pm-runtime/.prepare.lock': '',
            bootstrap / '.lease-managed': '',
            environment / '.lease-managed': '',
            environment / 'pyvenv.cfg': 'version = 3.14.0\n',
            environment / 'bin/python': '#!/bin/sh\nexit 0\n',
            destination / '.hermes/bin/hermes': '#!/bin/sh\nexit 0\n',
            destination / 'scripts/whatsapp-bridge/package.json': '{}',
            destination / 'scripts/whatsapp-bridge/node_modules/.hermes-pkg-hash': hashlib.sha256(b'{}').hexdigest()[:16],
        }
        for path, content in files.items():
            path.write_text(content)
            path.chmod(0o644)
        (environment / 'bin/python').chmod(0o755)
        (destination / '.hermes/bin/hermes').chmod(0o755)
        (state / '.install.lock').chmod(0o600)
        (state / 'pm-runtime/.prepare.lock').chmod(0o600)
        (runtime / 'profiles/.origin-probe').symlink_to(root / 'probe-data')
        (runtime / 'profiles/coordinator').symlink_to(self.data)
        account = type('Account', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
        original_trusted = manage.trusted
        # /tmp is intentionally mutable; exercise the actual subtree checks
        # using this test account as administrator, not a deployed /opt ancestor.
        for item in (patch.object(manage, 'trusted', side_effect=lambda path: None if path in (root, self.base) else original_trusted(path)),
                     patch.object(manage.pwd, 'getpwnam', return_value=account)):
            item.start()
            self.addCleanup(item.stop)
        return destination

    def write_state(self, **changes):
        value = {'gateway_state': 'running', 'pid': 123, 'active_agents': 0, 'active_work': None,
                 'updated_at': datetime.now(timezone.utc).isoformat(), 'platforms': {}}
        value.update(changes)
        (self.data / 'gateway_state.json').write_text(json.dumps(value))

    def test_idle_requires_fresh_matching_process_and_explicit_zero(self):
        with patch.object(manage, 'service_pid', return_value=123):
            self.write_state()
            manage.state(idle=True)
            for changes in ({'active_agents': None}, {'active_agents': False}, {'active_agents': 1},
                            {'pid': 124}, {'active_work': [{'kind': 'cron'}]},
                            {'updated_at': datetime.fromtimestamp(time.time() - 121, timezone.utc).isoformat()}):
                self.write_state(**changes)
                with self.assertRaises(ValueError):
                    manage.state(idle=True)

    def test_missing_maintenance_never_reaches_mutation(self):
        with patch.object(manage, 'install_release') as install, patch.object(manage, 'drain') as drain:
            with self.assertRaises(ValueError):
                manage.update(self.pin, False)
            install.assert_not_called()
            drain.assert_not_called()

    def test_busy_gateway_is_not_stopped_or_rolled_back(self):
        with patch.object(manage, 'release_metadata'), patch.object(manage, 'state', side_effect=ValueError('busy')), \
             patch.object(manage, 'stopped') as stopped, patch.object(manage, 'rollback') as rollback:
            with self.assertRaises(ValueError):
                manage.update(self.pin, True)
            stopped.assert_not_called()
            rollback.assert_not_called()
            self.assertFalse(manage.JOURNAL.exists())

    def test_failed_backup_never_activates_staged_candidate(self):
        with patch.object(manage, 'release_metadata'), patch.object(manage, 'state'), \
             patch.object(manage, 'health'), patch.object(manage, 'policy_digest', return_value='policy'), \
             patch.object(manage, 'candidate_policy_probe'), \
             patch.object(manage, 'idle_processes'), \
             patch.object(manage, 'drain'), patch.object(manage, 'stopped'), \
             patch.object(manage, 'backup', side_effect=OSError('disk full')), \
             patch.object(manage, 'install_release', return_value=self.root / 'candidate') as install, \
             patch.object(manage, 'activate') as activate, patch.object(manage, 'rollback') as rollback:
            with self.assertRaises(OSError):
                manage.update(self.pin, True)
            install.assert_called_once()
            activate.assert_not_called()
            rollback.assert_called_once()
            self.assertNotIn('archive', rollback.call_args.args[0])

    def test_health_failure_rolls_back_verified_backup(self):
        archive = self.root / 'backup.tar.gz'
        with patch.object(manage, 'release_metadata'), patch.object(manage, 'state'), \
             patch.object(manage, 'health'), patch.object(manage, 'policy_digest', return_value='policy'), \
             patch.object(manage, 'preflight'), \
             patch.object(manage, 'candidate_policy_probe'), \
             patch.object(manage, 'idle_processes'), \
             patch.object(manage, 'drain'), patch.object(manage, 'stopped'), \
             patch.object(manage, 'backup', return_value=(archive, 'digest')), \
             patch.object(manage, 'install_release', return_value=self.root / 'candidate'), \
             patch.object(manage, 'activate'), patch.object(manage, 'run'), \
             patch.object(manage, 'wait_healthy', side_effect=ValueError('health')), \
             patch.object(manage, 'rollback') as rollback:
            with self.assertRaises(ValueError):
                manage.update(self.pin, True)
            self.assertEqual(rollback.call_args.args[0]['sha256'], 'digest')
            self.assertEqual(rollback.call_args.args[0]['archive'], str(archive))

    def test_chat_policy_is_not_coding_or_paid_policy(self):
        policy = json.loads(Path(__file__).with_name('managed-config.json').read_text())
        self.assertEqual(policy['fallback_providers'], [])
        self.assertEqual(policy['platform_toolsets']['whatsapp'], ['mcp-origin'])
        extra = policy['platforms']['whatsapp']['extra']
        self.assertEqual(extra['bridge_script'], '/opt/origin-hermes/current/scripts/whatsapp-bridge/bridge.js')
        # Pinned upstream policy_from_extra gates ONLY when admin list is nonempty.
        self.assertEqual(extra['allow_admin_from'], ['origin-local-maintenance-only'])
        self.assertFalse(set(extra['user_allowed_commands']) & {'update', 'plugins', 'tools', 'yolo', 'approvals', 'model'})
        tools = policy['mcp_servers']['origin']['tools']['include']
        self.assertIn('start_execution_run', tools)
        self.assertNotIn('approve_execution_run', tools)
        self.assertFalse(policy['plugins']['auto_apply'])

    def test_malformed_or_broadened_managed_policy_blocks_startup(self):
        baseline = json.loads(Path(__file__).with_name('managed-config.json').read_text())
        (self.root / 'managed-config.json').write_text(json.dumps(baseline))
        config = self.root / 'config.yaml'
        with patch.object(manage, 'MANAGED', self.root), patch.object(manage, 'ADMIN', self.root):
            config.write_text('not valid JSON')
            with self.assertRaises(ValueError):
                manage.preflight()
            baseline['platform_toolsets']['whatsapp'].append('terminal')
            config.write_text(json.dumps(baseline))
            with self.assertRaises(ValueError):
                manage.preflight()

    def lifecycle(self):
        events = []
        mocks = {}
        returns = {'policy_digest': 'policy', 'install_release': self.root / 'candidate',
                   'backup': (self.root / 'archive', 'digest')}
        for name in ('release_metadata', 'state', 'health', 'native_auth_health', 'policy_digest',
                     'install_release', 'drain', 'stopped', 'backup', 'activate',
                     'candidate_policy_probe',
                     'idle_processes',
                     'preflight', 'run', 'wait_healthy'):
            def record(*args, _name=name, **kwargs):
                events.append(_name)
                return returns.get(_name)
            item = patch.object(manage, name, side_effect=record)
            mocks[name] = item.start()
            self.addCleanup(item.stop)
        return events, mocks

    def test_healthy_automatic_transition_stages_before_drain_and_backup_before_activation(self):
        events, _ = self.lifecycle()
        manage.update(self.pin, True, automatic=True)
        ordered = ['install_release', 'candidate_policy_probe', 'drain', 'stopped', 'backup', 'activate',
                   'preflight', 'run', 'wait_healthy']
        self.assertEqual([event for event in events if event in ordered], ordered)
        self.assertEqual(events.count('state'), 2)
        self.assertEqual(events.count('native_auth_health'), 3)
        self.assertFalse(manage.JOURNAL.exists())

    def test_new_work_after_staging_defers_without_drain(self):
        _, mocks = self.lifecycle()
        mocks['state'].side_effect = [None, ValueError('busy')]
        with self.assertRaises(ValueError):
            manage.update(self.pin, True, automatic=True)
        mocks['install_release'].assert_called_once()
        mocks['drain'].assert_not_called()
        mocks['stopped'].assert_not_called()
        self.assertFalse(manage.JOURNAL.exists())

    def test_missing_auth_health_defers_before_stage(self):
        _, mocks = self.lifecycle()
        mocks['native_auth_health'].side_effect = ValueError('unconfigured')
        with self.assertRaises(ValueError):
            manage.update(self.pin, True, automatic=True)
        mocks['install_release'].assert_not_called()
        mocks['drain'].assert_not_called()

    def test_policy_change_after_staging_never_stops_gateway(self):
        _, mocks = self.lifecycle()
        mocks['policy_digest'].side_effect = ['old', 'changed']
        with self.assertRaises(ValueError):
            manage.update(self.pin, True, automatic=True)
        mocks['drain'].assert_not_called()

    def test_other_service_user_activity_defers_without_staging_or_stop(self):
        _, mocks = self.lifecycle()
        mocks['idle_processes'].side_effect = ValueError('interactive login')
        with self.assertRaises(ValueError):
            manage.update(self.pin, True, automatic=True)
        mocks['install_release'].assert_not_called()
        mocks['stopped'].assert_not_called()

    def test_idle_process_ownership_rejects_process_outside_gateway_cgroup(self):
        result = type('Result', (), {'stdout': '123\n124\n', 'returncode': 0})()
        account = type('Account', (), {'pw_uid': 1001})()
        group = '0::/system.slice/origin-hermes.service'
        with patch.object(manage, 'service_pid', return_value=123), \
             patch.object(manage.pwd, 'getpwnam', return_value=account), \
             patch.object(manage.subprocess, 'run', return_value=result), \
             patch.object(Path, 'read_text', side_effect=[group, group, '0::/user.slice/other']):
            with self.assertRaises(ValueError):
                manage.idle_processes()

    def test_candidate_policy_failure_is_quarantined_before_any_drain(self):
        _, mocks = self.lifecycle()
        mocks['candidate_policy_probe'].side_effect = ValueError('effective policy broadened')
        with patch.object(manage, 'quarantine') as quarantine:
            with self.assertRaises(ValueError):
                manage.update(self.pin, True, automatic=True)
            quarantine.assert_called_once_with(self.pin)
        mocks['drain'].assert_not_called()
        mocks['stopped'].assert_not_called()

    def test_failed_automatic_health_rolls_back_and_quarantines_commit(self):
        _, mocks = self.lifecycle()
        mocks['wait_healthy'].side_effect = ValueError('unhealthy')
        with patch.object(manage, 'rollback') as rollback, \
             patch.object(manage, 'QUARANTINE', self.root / 'quarantine'), patch.object(manage, 'trusted'):
            with self.assertRaises(ValueError):
                manage.update(self.pin, True, automatic=True)
            receipt = json.loads((manage.QUARANTINE / (self.pin['commit'] + '.json')).read_text())
            self.assertEqual(receipt['release'], self.pin)
            self.assertEqual(rollback.call_args.args[0]['sha256'], 'digest')

    def test_stage_failure_quarantines_without_downtime(self):
        _, mocks = self.lifecycle()
        mocks['install_release'].side_effect = ValueError('bad source')
        with patch.object(manage, 'quarantine') as quarantine:
            with self.assertRaises(ValueError):
                manage.update(self.pin, True, automatic=True)
            quarantine.assert_called_once_with(self.pin)
        mocks['drain'].assert_not_called()
        mocks['stopped'].assert_not_called()

    def test_rollback_restores_private_home_and_prepared_runtime(self):
        home = self.root / 'home'
        home.mkdir()
        self.data = home / '.hermes'
        self.data.mkdir()
        (self.data / 'auth.json').write_text('private-original')
        archive = self.root / 'home.tar.gz'
        with tarfile.open(archive, 'w:gz') as target:
            target.add(home, arcname='.')
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.data / 'auth.json').write_text('bad-migration')
        account = type('Account', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
        def extract(args, **kwargs):
            return subprocess.run([str(arg) for arg in args], check=True, **kwargs)
        with patch.object(manage, 'HOME', home), patch.object(manage, 'DATA', self.data), \
             patch.object(manage, 'stopped'), patch.object(manage, 'run'), \
             patch.object(manage, 'as_user', side_effect=extract), \
             patch.object(manage.pwd, 'getpwnam', return_value=account), \
             patch.object(manage, 'preflight'), patch.object(manage, 'wait_healthy'):
            previous = self.staged_release()
            self.pin = {**self.pin, 'commit': 'c' * 40, 'tag': 'v0.23.2'}
            candidate = self.staged_release()
            facts = manage.runtime_state(candidate) / 'facts.json'
            original_facts = facts.read_bytes()
            manage.activate(candidate)
            manage.JOURNAL.write_text('{}')
            manage.rollback({'previous': str(previous), 'archive': str(archive), 'sha256': digest})
        self.assertEqual((self.data / 'auth.json').read_text(), 'private-original')
        self.assertEqual((self.base / 'current').resolve(), previous)
        self.assertEqual((self.base / 'current-runtime').resolve(), previous.parent / 'build-home/.hermes')
        self.assertFalse(manage.JOURNAL.exists())
        self.assertEqual(facts.read_bytes(), original_facts)

    def test_compatibility_allows_agent_code_but_rejects_security_and_permission_changes(self):
        tree = {'scripts/install.sh': ('100755', 'blob', self.pin['installerGitBlob']),
                'gateway/run.py': ('100644', 'blob', 'c' * 40),
                'uv.lock': ('100644', 'blob', 'd' * 40),
                'agent/cache_bounds.py': ('100644', 'blob', '1' * 40),
                'agent/secret_scope.py': ('100644', 'blob', '2' * 40),
                'agent/agent_init.py': ('100644', 'blob', '3' * 40),
                'agent/file_safety.py': ('100644', 'blob', '4' * 40),
                'agent/conversation_loop.py': ('100644', 'blob', '5' * 40),
                'docs/guide.md': ('100644', 'blob', 'e' * 40)}
        for path, replacement in [('gateway/run.py', ('100644', 'blob', 'f' * 40)),
                                  ('uv.lock', ('100644', 'blob', 'f' * 40)),
                                  ('agent/secret_scope.py', ('100644', 'blob', 'f' * 40)),
                                  ('agent/agent_init.py', ('100644', 'blob', 'f' * 40)),
                                  ('agent/file_safety.py', ('100644', 'blob', 'f' * 40)),
                                  ('agent/conversation_loop.py', ('100644', 'blob', 'f' * 40)),
                                  ('agent/new_module.py', ('100644', 'blob', 'f' * 40)),
                                  ('docs/guide.md', ('100755', 'blob', 'e' * 40)),
                                  ('docs/link', ('120000', 'blob', 'f' * 40))]:
            with self.subTest(path=path), patch.object(manage, 'source_tree', side_effect=[tree, {**tree, path: replacement}]):
                with self.assertRaises(ValueError):
                    manage.compatible(self.pin, self.pin)
        with patch.object(manage, 'source_tree', side_effect=[tree, {**tree, 'docs/guide.md': ('100644', 'blob', 'f' * 40)}]):
            manage.compatible(self.pin, self.pin)
        with patch.object(manage, 'source_tree', side_effect=[tree, {**tree, 'agent/cache_bounds.py': ('100644', 'blob', 'f' * 40)}]):
            manage.compatible(self.pin, self.pin)
        with self.assertRaises(ValueError):
            manage.compatible({**self.pin, 'tag': 'v0.24.0'}, self.pin)

    def test_incomplete_tree_and_retagged_source_fail_closed(self):
        with patch.object(manage, 'request', side_effect=[
                json.dumps({'sha': self.pin['commit'], 'tree': {'sha': 'c' * 40}}).encode(),
                json.dumps({'sha': 'c' * 40, 'truncated': True, 'tree': []}).encode()]):
            with self.assertRaises(ValueError):
                manage.source_tree(self.pin['commit'])
        with patch.object(manage, 'request', side_effect=[
                json.dumps({'tag_name': self.pin['tag'], 'draft': False, 'prerelease': False}).encode(),
                json.dumps({'sha': 'c' * 40}).encode()]):
            with self.assertRaises(ValueError):
                manage.release_metadata(self.pin)

    def test_missing_activity_field_is_not_idle(self):
        self.write_state()
        path = self.data / 'gateway_state.json'
        value = json.loads(path.read_text())
        del value['active_work']
        path.write_text(json.dumps(value))
        with patch.object(manage, 'service_pid', return_value=123):
            with self.assertRaises(ValueError):
                manage.state(idle=True)

    def test_incompatible_stable_release_reports_review_required_without_application(self):
        policy = self.root / 'automatic-updates.json'
        report = self.root / 'latest.json'
        policy.write_text(json.dumps({'enabled': True, 'baseline': self.pin, 'policyDigest': 'policy'}))
        metadata = json.dumps({'tag_name': self.pin['tag'], 'draft': False, 'prerelease': False}).encode()
        with patch.object(manage, 'AUTO_POLICY', policy), patch.object(manage, 'UPDATE_STATE', report), \
             patch.object(manage, 'QUARANTINE', self.root / 'quarantine'), patch.object(manage, 'trusted'), \
             patch.object(manage, 'policy_digest', return_value='policy'), \
             patch.object(manage, 'request', side_effect=[metadata, json.dumps({'sha': 'c' * 40}).encode()]), \
             patch.object(manage, 'compatible', side_effect=manage.CompatibilityReviewRequired('enforcement changed')), \
             patch.object(manage, 'update') as update:
            manage.check_updates(apply=True)
        result = json.loads(report.read_text())
        self.assertEqual(result['status'], 'administrator-review-required')
        self.assertFalse(result['applied'])
        update.assert_not_called()

    def test_daily_opt_in_and_quarantine_prevent_unattended_retry(self):
        policy = self.root / 'automatic-updates.json'
        report = self.root / 'latest.json'
        quarantine = self.root / 'quarantine'
        quarantine.mkdir()
        metadata = json.dumps({'tag_name': self.pin['tag'], 'draft': False, 'prerelease': False}).encode()
        with patch.object(manage, 'AUTO_POLICY', policy), patch.object(manage, 'UPDATE_STATE', report), \
             patch.object(manage, 'QUARANTINE', quarantine), patch.object(manage, 'trusted'), \
             patch.object(manage, 'policy_digest', return_value='policy'), \
             patch.object(manage, 'request', return_value=metadata) as request, \
             patch.object(manage, 'update') as update:
            manage.check_updates(apply=True)
            self.assertEqual(json.loads(report.read_text())['status'], 'check-only')
            update.assert_not_called()
            policy.write_text(json.dumps({'enabled': True, 'baseline': self.pin, 'policyDigest': 'policy'}))
            (quarantine / (self.pin['commit'] + '.json')).write_text('{}')
            request.side_effect = [metadata, json.dumps({'sha': self.pin['commit']}).encode()]
            manage.check_updates(apply=True)
            self.assertEqual(json.loads(report.read_text())['status'], 'quarantined')
            update.assert_not_called()

    def test_enable_disable_is_administrator_only_and_never_logs_in(self):
        policy = self.root / 'automatic-updates.json'
        with patch.object(manage, 'AUTO_POLICY', policy), patch.object(manage, 'trusted'), \
             patch.object(manage, 'root_required'), patch.object(manage, 'preflight'), \
             patch.object(manage, 'health'), patch.object(manage, 'native_auth_health'), \
             patch.object(manage, 'release_metadata'), patch.object(manage, 'policy_digest', return_value='policy'), \
             patch.object(manage, 'validate_stage'), \
             patch.object(manage.pwd, 'getpwnam'), patch.object(manage, 'run') as run, \
             patch.object(manage, 'hermes') as hermes:
            manage.automatic_policy(True)
            self.assertTrue(json.loads(policy.read_text())['enabled'])
            self.assertIn('origin-hermes-update-check.timer', run.call_args.args[0])
            manage.automatic_policy(False)
            self.assertFalse(policy.exists())
            hermes.assert_not_called()
        with patch.object(manage.os, 'geteuid', return_value=1000):
            with self.assertRaises(ValueError):
                manage.automatic_policy(True)

    def test_health_only_uses_mcp_initialization_and_tool_discovery(self):
        (self.data / '.env').write_text('ORIGIN_MCP_URL=https://origin.example/mcp\nORIGIN_MCP_TOKEN=private\n')
        tools = [{'name': name} for name in ('get_workspace', 'start_execution_run', 'get_execution_run', 'cancel_execution_run')]
        with patch.object(manage, 'preflight'), \
             patch.object(manage, 'state', return_value={'platforms': {'whatsapp': {'state': 'connected'}}}), \
             patch.object(manage, 'request', side_effect=[(b'{}', {}), b'', json.dumps({'result': {'tools': tools}}).encode()]) as request, \
             patch.object(manage, 'hermes') as hermes:
            manage.health()
            methods = [json.loads(call.args[1])['method'] for call in request.call_args_list]
            self.assertEqual(methods, ['initialize', 'notifications/initialized', 'tools/list'])
            hermes.assert_not_called()

    def test_native_health_is_local_and_requires_unexpired_configured_oauth(self):
        config = {'model': {'provider': 'openai-codex', 'default': 'chosen-model'}, 'fallback_providers': []}
        (self.root / 'config.yaml').write_text(json.dumps(config))
        auth = self.data / 'auth.json'
        def token(expiry):
            payload = base64.urlsafe_b64encode(json.dumps({'exp': expiry}).encode()).decode().rstrip('=')
            auth.write_text(json.dumps({'providers': {'openai-codex': {'tokens': {
                'access_token': 'header.' + payload + '.signature', 'refresh_token': 'local-only'}}}}))
            auth.chmod(0o600)
        with patch.object(manage, 'MANAGED', self.root), patch.object(manage, 'request') as request, \
             patch.object(manage, 'hermes') as hermes:
            token(time.time() + 3600)
            manage.native_auth_health()
            token(time.time() - 1)
            with self.assertRaises(ValueError):
                manage.native_auth_health()
            request.assert_not_called()
            hermes.assert_not_called()


    def test_candidate_probe_is_networkless_and_refuses_unknown_result(self):
        destination = self.staged_release()
        home = destination.parent / 'build-home'
        managed = self.root / 'managed'
        managed.mkdir()
        (managed / 'config.yaml').write_text('{"platform_toolsets":{"whatsapp":["mcp-origin"]}}')
        (managed / '.env').write_text('WHATSAPP_ALLOW_ALL_USERS=false\n')
        with patch.object(manage, 'MANAGED', managed), patch.object(manage, 'stage_run') as stage:
            stage.return_value.stdout = 'origin-effective-policy-ok\n'
            manage.candidate_policy_probe(destination)
            self.assertFalse(stage.call_args.kwargs['network'])
            self.assertEqual(stage.call_args.kwargs['stdin'], subprocess.DEVNULL)
            self.assertNotIn('ORIGIN_MCP_TOKEN=', (home / 'managed/.env').read_text())
            stage.return_value.stdout = 'unknown'
            with self.assertRaises(ValueError):
                manage.candidate_policy_probe(destination)

    def test_broadened_owner_allowlist_fails_preflight(self):
        baseline = json.loads(Path(__file__).with_name('managed-config.json').read_text())
        (self.root / 'managed-config.json').write_text(json.dumps(baseline))
        (self.root / 'config.yaml').write_text(json.dumps(baseline))
        (self.root / '.env').write_text('WHATSAPP_ALLOWED_USERS=15551234567\nWHATSAPP_ALLOW_ALL_USERS=true\n')
        with patch.object(manage, 'MANAGED', self.root), patch.object(manage, 'ADMIN', self.root):
            with self.assertRaises(ValueError):
                manage.preflight()

    def test_privileged_probe_rejects_intermediate_links_without_touching_live_policy(self):
        destination = self.staged_release()
        live = self.root / 'live-managed'
        live.mkdir()
        (live / 'config.yaml').write_text('original-private-policy')
        (live / '.env').write_text('original-private-environment')
        with patch.object(manage, 'MANAGED', live), patch.object(manage, 'stage_run') as stage:
            for relative in ('build-home/.hermes', 'build-home/managed', 'probe-data'):
                with self.subTest(relative=relative):
                    path = destination.parent / relative
                    saved = path.with_name(path.name + '.saved')
                    path.rename(saved)
                    path.symlink_to(live)
                    try:
                        with self.assertRaises(ValueError):
                            manage.candidate_policy_probe(destination)
                        self.assertEqual((live / 'config.yaml').read_text(), 'original-private-policy')
                        self.assertEqual((live / '.env').read_text(), 'original-private-environment')
                        stage.assert_not_called()
                    finally:
                        path.unlink()
                        saved.rename(path)

    def test_freezing_overrides_restrictive_umask_for_runtime_traversal(self):
        root = self.root / 'raw-stage'
        old_umask = os.umask(0o077)
        try:
            (root / 'source').mkdir(parents=True)
            (root / 'build-home/.hermes/profiles/.origin-probe').mkdir(parents=True)
            (root / 'build-home/.hermes/installs').mkdir()
            code = root / 'source/module.py'
            code.write_text('value = 1\n')
            with patch.object(manage, 'run'):
                manage.freeze_stage(root)
        finally:
            os.umask(old_umask)
        for folder, _, files in os.walk(root):
            self.assertEqual(Path(folder).stat().st_mode & 0o777, 0o755)
            for name in files:
                self.assertEqual((Path(folder) / name).stat().st_mode & 0o777, 0o644)

    def test_runtime_preparation_keeps_created_directories_traversable_under_private_umask(self):
        destination = self.staged_release()
        root = destination.parent
        profiles = root / 'build-home/.hermes/profiles'
        (profiles / '.origin-probe').unlink()
        (root / 'probe-data').rename(profiles / '.origin-probe')
        (profiles / 'coordinator').unlink()
        (root / 'build-home/managed').rmdir()
        old_umask = os.umask(0o077)
        try:
            manage.prepare_runtime(destination)
        finally:
            os.umask(old_umask)
        self.assertEqual((root / 'build-home/managed').stat().st_mode & 0o777, 0o755)
        self.assertEqual((root / 'build-home/.hermes/installs').stat().st_mode & 0o777, 0o755)
        self.assertEqual((profiles / '.origin-probe').resolve(), root / 'probe-data')
        manage.validate_stage(destination)

    def test_runtime_index_rejects_private_home_redirection(self):
        destination = self.staged_release()
        index = manage.runtime_index(destination, create=True)
        target = manage.runtime_state(destination)
        entry = index / target.name
        entry.unlink()
        entry.symlink_to(self.data)
        with self.assertRaises(ValueError):
            manage.runtime_index(destination)
        with self.assertRaises(ValueError):
            manage.runtime_index(destination, create=True)
        self.assertEqual(entry.resolve(), self.data)

    def test_runtime_index_rejects_replaceable_parent(self):
        destination = self.staged_release()
        index = manage.runtime_index(destination, create=True)
        index.chmod(0o777)
        with self.assertRaises(ValueError):
            manage.runtime_index(destination)

    def test_runtime_index_refuses_symlinked_storage_without_writing_target(self):
        destination = self.staged_release()
        (self.base / 'runtime-installs').symlink_to(self.data)
        before = set(self.data.iterdir())
        with self.assertRaises(ValueError):
            manage.runtime_index(destination, create=True)
        self.assertEqual(set(self.data.iterdir()), before)

    def test_runtime_index_remains_traversable_under_private_umask(self):
        destination = self.staged_release()
        previous = os.umask(0o077)
        try:
            index = manage.runtime_index(destination, create=True)
        finally:
            os.umask(previous)
        self.assertEqual(index.stat().st_mode & 0o777, 0o755)
        self.assertEqual((index / manage.runtime_state(destination).name).resolve(),
                         manage.runtime_state(destination))

    def test_executable_symlink_into_private_home_is_rejected(self):
        destination = self.staged_release()
        evil = self.data / 'python'
        evil.write_text('unreviewed')
        launcher = destination / '.hermes/bin/hermes'
        launcher.unlink()
        launcher.symlink_to(evil)
        with self.assertRaises(ValueError):
            manage.validate_stage(destination)

    def test_executable_symlink_into_mutable_runtime_lock_is_rejected(self):
        destination = self.staged_release()
        launcher = destination / '.hermes/bin/hermes'
        for lock in manage.runtime_locks(destination):
            with self.subTest(lock=lock.name):
                launcher.unlink()
                launcher.symlink_to(lock)
                with self.assertRaises(ValueError):
                    manage.validate_stage(destination)


    def test_repeated_activations_keep_each_runtime_outside_replaceable_private_home(self):
        first = self.staged_release()
        first_facts = manage.runtime_state(first) / 'facts.json'
        first_content = first_facts.read_bytes()
        manage.activate(first)
        self.pin = {**self.pin, 'commit': 'c' * 40, 'tag': 'v0.23.2'}
        second = self.staged_release()
        second_facts = manage.runtime_state(second) / 'facts.json'
        for candidate in (second, first, second):
            manage.activate(candidate)
            self.assertEqual((self.base / 'current-runtime').resolve(), candidate.parent / 'build-home/.hermes')
            env = manage.runtime_environment(candidate)
            self.assertEqual(Path(env['HOME']), candidate.parent / 'build-home')
            selected = Path(json.loads((manage.runtime_state(candidate) / 'facts.json').read_text())['packages']['venv']['environment'])
            self.assertTrue(selected.resolve().is_relative_to(candidate.parent))
            self.assertFalse(selected.resolve().is_relative_to(self.data))
            index = manage.runtime_index(candidate)
            for retained in (first, candidate):
                target = manage.runtime_state(retained)
                self.assertEqual((index / target.name).resolve(), target)
        self.assertEqual(first_facts.read_bytes(), first_content)
        self.assertTrue(second_facts.is_file())

    def offline_candidate(self):
        previous = self.staged_release()
        manage.activate(previous)
        self.previous = previous
        candidate = self.base / 'repaired' / 'source'
        candidate.mkdir(parents=True)
        (candidate.parent / 'build-home/.hermes').mkdir(parents=True)
        (candidate.parent / 'origin-stage.json').write_text('{"layout":3}')
        manage.runtime_state(candidate).mkdir(parents=True)
        (self.data / 'private-state').write_text('keep-private-state')
        mocks = {}
        for name, value in {
            'require_offline': None, 'validate_stage': None, 'policy_digest': 'policy',
            'install_release': candidate, 'candidate_policy_probe': None, 'preflight': None,
        }.items():
            item = patch.object(manage, name, return_value=value)
            mocks[name] = item.start()
            self.addCleanup(item.stop)
        forbidden = patch.object(manage, 'run', side_effect=AssertionError('Offline repair started a command'))
        forbidden.start()
        self.addCleanup(forbidden.stop)
        return candidate, mocks

    def test_offline_repair_changes_only_runtime_and_leaves_private_home_intact(self):
        candidate, _ = self.offline_candidate()
        manage.repair_offline(self.pin, True)
        self.assertEqual((self.base / 'current').resolve(), candidate)
        self.assertEqual((self.base / 'current-runtime').resolve(), candidate.parent / 'build-home/.hermes')
        self.assertEqual((self.data / 'private-state').read_text(), 'keep-private-state')
        self.assertFalse(manage.JOURNAL.exists())

    def test_failed_offline_activation_restores_both_pointers_without_restoring_home(self):
        _, mocks = self.offline_candidate()
        mocks['preflight'].side_effect = ValueError('Invalid candidate policy')
        with self.assertRaises(ValueError):
            manage.repair_offline(self.pin, True)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertEqual((self.base / 'current-runtime').resolve(), self.previous.parent / 'build-home/.hermes')
        self.assertEqual((self.data / 'private-state').read_text(), 'keep-private-state')
        self.assertFalse(manage.JOURNAL.exists())

    def test_offline_repair_rejects_release_change_and_missing_authorization(self):
        _, _ = self.offline_candidate()
        for pin, authorized in ((self.pin, False), ({**self.pin, 'tag': 'v0.23.2'}, True)):
            with self.subTest(pin=pin, authorized=authorized):
                with self.assertRaises(ValueError):
                    manage.repair_offline(pin, authorized)
                self.assertEqual((self.base / 'current').resolve(), self.previous)
                self.assertEqual((self.data / 'private-state').read_text(), 'keep-private-state')
                self.assertFalse(manage.JOURNAL.exists())

    def test_offline_repair_defers_when_policy_or_activity_changes_during_stage(self):
        _, mocks = self.offline_candidate()
        mocks['policy_digest'].side_effect = ['before', 'after']
        with self.assertRaises(ValueError):
            manage.repair_offline(self.pin, True)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertFalse(manage.JOURNAL.exists())
        mocks['policy_digest'].side_effect = None
        mocks['require_offline'].side_effect = [None, ValueError('Interactive login started')]
        with self.assertRaises(ValueError):
            manage.repair_offline(self.pin, True)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertFalse(manage.JOURNAL.exists())

    def test_offline_recovery_restores_old_pointer_after_interrupted_activation(self):
        candidate, _ = self.offline_candidate()
        journal = {'mode': 'offline-repair', 'previous': str(self.previous), 'target': self.pin}
        manage.JOURNAL.write_text(json.dumps(journal))
        manage.activate(candidate)
        manage.rollback(journal)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertEqual((self.base / 'current-runtime').resolve(), self.previous.parent / 'build-home/.hermes')
        self.assertEqual((self.data / 'private-state').read_text(), 'keep-private-state')
        self.assertFalse(manage.JOURNAL.exists())

    def test_offline_gate_rejects_active_or_interactive_service_identity(self):
        account = type('Account', (), {'pw_uid': os.getuid()})()
        with patch.object(manage, 'service_pid', return_value=0), \
             patch.object(manage.pwd, 'getpwnam', return_value=account), \
             patch.object(manage.subprocess, 'run') as command:
            command.return_value = subprocess.CompletedProcess([], 0, stdout='activating\n')
            with self.assertRaises(ValueError):
                manage.require_offline()
            command.side_effect = [
                subprocess.CompletedProcess([], 0, stdout='inactive\n'),
                subprocess.CompletedProcess([], 0, stdout='123'),
            ]
            with self.assertRaises(ValueError):
                manage.require_offline()
        self.assertEqual((self.base / 'current').resolve(), self.previous)

    def test_legacy_cached_stage_cannot_satisfy_a_repaired_install(self):
        destination = self.staged_release()
        with patch.object(manage, 'release_metadata'), \
             patch.object(manage, 'stage_root', return_value=destination.parent):
            with self.assertRaises(ValueError):
                manage.install_release(self.pin)


    def test_writable_administrator_policy_is_rejected(self):
        path = self.root / 'policy'
        path.write_text('{}')
        path.chmod(0o666)
        with self.assertRaises(ValueError):
            manage.trusted(path)



if __name__ == '__main__':
    unittest.main()
