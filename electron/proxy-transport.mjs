import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { lookup } from "node:dns/promises";

export async function openProxyTunnel(target, proxy, timeout = 10_000) {
  const secure = proxy?.protocol === "https:" || (!proxy && target.secure);
  const hostname = proxy ? proxy.hostname.replace(/^\[|\]$/g, "") : target.hostname;
  const port = Number(proxy ? proxy.port || (secure ? 443 : proxy.protocol.startsWith("socks") ? 1080 : 80) : target.port);
  const socket = secure ? tls.connect({ host: hostname, port, servername: hostname }) : net.connect({ host: hostname, port });
  socket.on("error", () => {});
  const timer = setTimeout(() => socket.destroy(new Error("Proxy connection timed out")), timeout);
  let buffered = Buffer.alloc(0);
  const chunk = () => new Promise((resolve, reject) => {
    const clean = () => { socket.off("data", data); socket.off("error", fail); socket.off("end", ended); socket.off("close", ended); };
    const data = value => { socket.pause(); clean(); resolve(value); };
    const fail = error => { clean(); reject(error); };
    const ended = () => fail(new Error("Proxy closed during handshake"));
    socket.once("data", data);
    socket.once("error", fail);
    socket.once("end", ended);
    socket.once("close", ended);
    if (socket.destroyed || socket.readableEnded) ended();
    else socket.resume();
  });
  const read = async (enough) => {
    while (!enough(buffered)) {
      buffered = Buffer.concat([buffered, await chunk()]);
      if (buffered.length > 65536) throw new Error("Invalid proxy response");
    }
  };
  try {
    await once(socket, secure ? "secureConnect" : "connect");
    if (proxy?.protocol === "socks4:") {
      const address = (await lookup(target.hostname, { family: 4 })).address;
      const request = Buffer.from([4, 1, 0, 0, ...address.split(".").map(Number), 0]);
      request.writeUInt16BE(Number(target.port), 2);
      socket.write(request);
      await read(b => b.length >= 8);
      if (buffered[1] !== 90) throw new Error("SOCKS4 proxy refused connection");
      buffered = buffered.subarray(8);
    } else if (proxy?.protocol === "socks5:") {
      socket.write(Buffer.from([5, 1, 0]));
      await read(b => b.length >= 2);
      if (buffered[0] !== 5 || buffered[1] !== 0) throw new Error("SOCKS proxy requires unsupported authentication");
      buffered = buffered.subarray(2);
      const family = net.isIP(target.hostname);
      let host;
      if (family === 4) host = Buffer.from(target.hostname.split(".").map(Number));
      else if (family === 6) {
        const normalized = target.hostname.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_all, a, b, c, d) => `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`);
        const [left, right] = normalized.split("::");
        const start = left ? left.split(":") : [];
        const end = right ? right.split(":") : [];
        const groups = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
        host = Buffer.alloc(16);
        groups.forEach((group, index) => host.writeUInt16BE(parseInt(group, 16), index * 2));
      } else host = Buffer.from(target.hostname);
      if (host.length > 255) throw new Error("Invalid proxy destination");
      const port = Buffer.alloc(2);
      port.writeUInt16BE(Number(target.port));
      socket.write(Buffer.concat([Buffer.from(family ? [5, 1, 0, family === 4 ? 1 : 4] : [5, 1, 0, 3, host.length]), host, port]));
      await read(b => b.length >= 5 && b.length >= (b[3] === 1 ? 10 : b[3] === 4 ? 22 : 7 + b[4]));
      if (buffered[0] !== 5 || buffered[1] !== 0) throw new Error("SOCKS proxy refused connection");
      buffered = buffered.subarray(buffered[3] === 1 ? 10 : buffered[3] === 4 ? 22 : 7 + buffered[4]);
    } else if (proxy) {
      const authority = `${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`;
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n` : "";
      const pinned = target.address ? `OMB-Target-IP: ${target.address}\r\n` : "";
      const route = target.url ? `OMB-Target-URL: ${target.url}\r\n` : "";
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}${pinned}${route}\r\n`);
      await read(b => b.includes("\r\n\r\n"));
      if (!/^HTTP\/1\.[01] 200\b/.test(buffered.toString())) throw new Error("HTTP proxy refused connection");
      buffered = buffered.subarray(buffered.indexOf("\r\n\r\n") + 4);
    }
    socket.pause();
    if (buffered.length) socket.unshift(buffered);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
