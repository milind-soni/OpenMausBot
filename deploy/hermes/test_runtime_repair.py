import copy
import hashlib
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import runtime_repair


def digest(value):
    return hashlib.sha256(value).hexdigest()


class RuntimeRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.before = {'first.py': b'old first\n', 'nested/second.js': b'old second\n'}
        self.after = {'first.py': b'new first\n', 'nested/second.js': b'new second\n'}
        specifications = {}
        for relative, value in self.before.items():
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
            path.chmod(0o640)
            specifications[relative] = (
                digest(value), digest(self.after[relative]),
                ((value.decode(), self.after[relative].decode()),))
        (self.source / 'package.json').write_bytes(b'guarded dependency')
        for replacement in (
            patch.object(runtime_repair, '_PATCHES', specifications),
            patch.object(runtime_repair, '_GUARDS', {'package.json': digest(b'guarded dependency')}),
        ):
            replacement.start()
            self.addCleanup(replacement.stop)

    def contents(self):
        return {relative: (self.source / relative).read_bytes() for relative in self.before}

    def test_repair_preserves_modes_and_refuses_reapplication(self):
        receipt = runtime_repair.apply_repair(self.source)
        self.assertEqual(self.contents(), self.after)
        for relative in self.before:
            self.assertEqual(stat.S_IMODE((self.source / relative).stat().st_mode), 0o640)
        runtime_repair.validate_repair(self.source, receipt)
        with self.assertRaises(ValueError):
            runtime_repair.apply_repair(self.source)
        self.assertEqual(self.contents(), self.after)

    def test_late_input_drift_leaves_every_file_unchanged(self):
        (self.source / 'nested/second.js').write_bytes(b'unreviewed upstream change')
        before = self.contents()
        with self.assertRaises(ValueError):
            runtime_repair.apply_repair(self.source)
        self.assertEqual(self.contents(), before)

    def test_dependency_drift_blocks_all_writes(self):
        (self.source / 'package.json').write_bytes(b'different dependency')
        with self.assertRaises(ValueError):
            runtime_repair.apply_repair(self.source)
        self.assertEqual(self.contents(), self.before)

    def test_linked_inputs_cannot_modify_external_files(self):
        outside = self.root / 'outside.js'
        outside.write_bytes(self.before['nested/second.js'])
        linked = self.source / 'nested/second.js'
        for kind in ('symlink', 'hardlink'):
            with self.subTest(kind=kind):
                linked.unlink()
                if kind == 'symlink':
                    linked.symlink_to(outside)
                else:
                    os.link(outside, linked)
                with self.assertRaises(ValueError):
                    runtime_repair.apply_repair(self.source)
                self.assertEqual(outside.read_bytes(), self.before['nested/second.js'])
                self.assertEqual((self.source / 'first.py').read_bytes(), self.before['first.py'])

    def test_linked_destination_ancestor_is_rejected(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            runtime_repair.apply_repair(alias / 'source')
        self.assertEqual(self.contents(), self.before)

    def test_receipt_cannot_escape_its_stage(self):
        receipt = runtime_repair.apply_repair(self.source)
        outside = self.root / 'private'
        outside.write_bytes(b'outside stage')
        for relative in ('../private', str(outside), 'nested/../../private', 'nested//second.js'):
            with self.subTest(relative=relative):
                invalid = copy.deepcopy(receipt)
                invalid['files'] = {relative: digest(outside.read_bytes())}
                with self.assertRaises(ValueError):
                    runtime_repair.validate_repair(self.source, invalid)
        self.assertEqual(self.contents(), self.after)
        self.assertEqual(outside.read_bytes(), b'outside stage')

    def test_historical_receipt_survives_asset_update_but_detects_file_drift(self):
        receipt = runtime_repair.apply_repair(self.source)
        with patch.object(runtime_repair, '_PATCHES', {}), \
             patch.object(runtime_repair, 'repair_id', return_value='f' * 64):
            runtime_repair.validate_repair(self.source, receipt)
            (self.source / 'first.py').write_bytes(b'corrupted previous release')
            with self.assertRaises(ValueError):
                runtime_repair.validate_repair(self.source, receipt)


if __name__ == '__main__':
    unittest.main()
