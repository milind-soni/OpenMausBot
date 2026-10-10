// A throwaway TLS certificate for tests that need a real https:// server:
// made at test time with the openssl command line, valid for two days, for
// this computer's loopback names and the made-up host proxy tests use. A
// child process trusts it through NODE_EXTRA_CA_CERTS=<certPath>.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TestTls {
  key: string;
  cert: string;
  /** the certificate's file, for NODE_EXTRA_CA_CERTS */
  certPath: string;
}

/** The host name proxy tests give a server "on the internet". */
export const TEST_TLS_HOST = "mcp.proxy-fixture.test";

/** A certificate written into `dir`, or undefined where no openssl runs. */
export function makeTestTls(dir: string): TestTls | undefined {
  const config = join(dir, "openssl.cnf");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  // A config of its own, so no system openssl.cnf is needed (Windows).
  writeFileSync(config, [
    "[req]", "distinguished_name = dn", "x509_extensions = v3", "prompt = no",
    "[dn]", "CN = OpenMausBot test",
    "[v3]", "basicConstraints = critical,CA:TRUE", "keyUsage = critical,digitalSignature,keyCertSign",
    "extendedKeyUsage = serverAuth", `subjectAltName = DNS:localhost,DNS:${TEST_TLS_HOST},IP:127.0.0.1,IP:::1`, "",
  ].join("\n"));
  const made = spawnSync("openssl", ["req", "-x509", "-config", config, "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2"], { stdio: "pipe", timeout: 30_000 });
  if (made.error || made.status !== 0) return undefined;
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), certPath };
}
