import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkUrl } from './settings.mjs';
test('benchmark endpoint requires an explicit loopback origin', () => {
  for (const origin of ['http://127.0.0.1:1234', 'http://localhost:1234/', 'http://[::1]:1234']) assert.equal(benchmarkUrl(origin).protocol, 'http:');
  for (const origin of ['', 'https://127.0.0.1:1234', 'http://example.com', 'http://127.0.0.1:1234/v1', 'http://user:pass@localhost:1234', 'http://localhost:1234/?secret=1']) assert.throws(() => benchmarkUrl(origin));
});
