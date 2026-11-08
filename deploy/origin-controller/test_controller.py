import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('controller.py'))
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)

class PresenceTests(unittest.TestCase):
    peers = [{'hostId': 'host-1', 'peerId': 'node-1', 'tailnetName': 'nixos.tail.test'}]

    def status(self, peer):
        return {'BackendState': 'Running', 'Self': {'Online': True}, 'Peer': {'key': peer}}

    def test_only_explicit_boolean_is_evidence(self):
        for online in (True, False):
            data = self.status({'ID': 'node-1', 'DNSName': 'nixos.tail.test.', 'Online': online})
            self.assertEqual(controller.presence(data, self.peers, 100), [
                {'hostId': 'host-1', 'tailnetName': 'nixos.tail.test', 'online': online, 'observedAt': 100}])
        for online in (None, 0, 'false'):
            data = self.status({'ID': 'node-1', 'DNSName': 'nixos.tail.test', 'Online': online})
            self.assertEqual(controller.presence(data, self.peers, 100), [])

    def test_missing_disconnected_or_reused_peer_is_unknown(self):
        self.assertEqual(controller.presence(self.status({}), self.peers, 100), [])
        data = self.status({'ID': 'replacement', 'DNSName': 'nixos.tail.test', 'Online': False})
        self.assertEqual(controller.presence(data, self.peers, 100), [])
        data['Peer']['key']['ID'] = 'node-1'
        data['Self']['Online'] = False
        self.assertEqual(controller.presence(data, self.peers, 100), [])
        data['Self']['Online'] = True
        data['BackendState'] = 'Stopped'
        self.assertEqual(controller.presence(data, self.peers, 100), [])

    def test_credentials_cannot_follow_redirects(self):
        with self.assertRaises(ValueError):
            controller.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.test')

class BillingTests(unittest.TestCase):
    binding = {'orgId': 'org-fixture', 'revision': 'e9f4f673-34f1-44e8-a0a8-0b2a5c005baf'}
    raw = {'id': 'org-fixture', 'billing_mode': 'credits', 'currency': 'eur',
           'balance_micro': 50000000, 'accruing_micro': 438}

    def test_native_credit_identity_and_currency_are_preserved(self):
        for currency in ('eur', 'usd'):
            report = controller.billing_report({**self.raw, 'currency': currency}, self.binding, 100)
            self.assertEqual(report['status'], 'available')
            self.assertEqual(report['currency'], currency.upper())
            self.assertEqual(report['balanceMicro'], 50000000)
            self.assertEqual(report['accruingMicro'], 438)
            self.assertEqual(report['revision'], self.binding['revision'])
            self.assertEqual(report['observedAt'], 100)

    def test_missing_wrong_org_subscription_or_invalid_amounts_fail_closed(self):
        bad = [None, {}, {**self.raw, 'id': 'different-org'},
               {**self.raw, 'billing_mode': 'stripe'}, {**self.raw, 'currency': 'GBP'},
               {**self.raw, 'balance_micro': True}, {**self.raw, 'balance_micro': 2**53},
               {**self.raw, 'accruing_micro': None}, {**self.raw, 'accruing_micro': -1}]
        for raw in bad:
            with self.subTest(raw=raw):
                report = controller.billing_report(raw, self.binding, 100)
                self.assertEqual(report['status'], 'unknown')
                self.assertNotIn('balanceMicro', report)

if __name__ == '__main__':
    unittest.main()
