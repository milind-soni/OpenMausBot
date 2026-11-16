#!/usr/bin/env node
// A stand-in for cloudflared's quick tunnel, for a check that may not reach Cloudflare: it names the loopback port it was
// given as https://fixture-<port>.trycloudflare.com, says the tunnel is registered, and runs until it is killed. The
// check reaches that port itself.
const target = new URL(process.argv[process.argv.indexOf("--url") + 1] ?? "");
process.stderr.write(`INF |  https://fixture-${target.port}.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0\n`);
setInterval(() => {}, 1 << 30);
