import assert from 'node:assert/strict';
export function benchmarkUrl(value = process.env.OMB_BENCHMARK_URL) {
  assert(value, 'Set OMB_BENCHMARK_URL to an explicit loopback HTTP server origin');
  const url = new URL(value);
  assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Benchmark endpoint must use loopback HTTP');
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Benchmark endpoint must be an origin without credentials or path');
  return url;
}
