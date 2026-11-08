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

if __name__ == '__main__':
    unittest.main()
