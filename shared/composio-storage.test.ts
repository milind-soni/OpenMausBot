import { describe, expect, it } from "vitest";

import { composioStorageHost, composioUploadLink } from "./composio-storage.ts";

const account = "0123456789abcdef".repeat(2);
const r2 = `temp.${account}.r2.cloudflarestorage.com`;

describe("composioStorageHost", () => {
  it("allows Composio, S3, and Cloudflare R2 storage hosts", () => {
    for (const host of [
      "composio.dev",
      "storage.composio.dev",
      "bucket.s3.us-east-1.amazonaws.com",
      "composio-files.s3.amazonaws.com",
      r2,
      `${account}.r2.cloudflarestorage.com`,
      `temp.${account}.eu.r2.cloudflarestorage.com`,
      `temp.${account}.us.r2.cloudflarestorage.com`,
      `${account}.fedramp.r2.cloudflarestorage.com`,
      r2.toUpperCase(),
    ]) {
      expect(composioStorageHost(host), host).toBe(true);
    }
  });

  it("rejects other hosts, including suffix lookalikes", () => {
    for (const host of [
      "attacker.example",
      "storage.composio.dev.evil.example",
      "not-r2.cloudflarestorage.com",
      "r2.cloudflarestorage.com",
      "www.r2.cloudflarestorage.com",
      `temp.not-an-account.r2.cloudflarestorage.com`,
      `evil.temp.${account}.r2.cloudflarestorage.com`,
      `${r2}.attacker.example`,
      `temp.${account}.zz.r2.cloudflarestorage.com`,
      `ab.${account}.r2.cloudflarestorage.com`,
      `-temp.${account}.r2.cloudflarestorage.com`,
      `temp-.${account}.r2.cloudflarestorage.com`,
      "169.254.169.254",
      "127.0.0.1",
    ]) {
      expect(composioStorageHost(host), host).toBe(false);
    }
  });
});

describe("composioUploadLink", () => {
  it("returns an HTTPS link on R2, composio.dev, and S3", () => {
    const link = `https://${r2}/517680/googledrive/report.pdf?X-Amz-Signature=1`;
    expect(composioUploadLink(link)?.href).toBe(link);
    expect(composioUploadLink("https://storage.composio.dev/p/report.pdf?X-Amz-Signature=1")?.hostname).toBe("storage.composio.dev");
    expect(composioUploadLink("https://bucket.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=1")?.hostname).toBe("bucket.s3.us-east-1.amazonaws.com");
  });

  it("rejects HTTP, userinfo, a non-default port, and a host that only looks like R2", () => {
    for (const link of [
      undefined,
      "",
      "not a url",
      `http://${r2}/put`,
      `https://user:pass@${r2}/put`,
      `https://${r2}:444/put`,
      `https://${r2}.attacker.example/x`,
      "https://storage.composio.dev.evil.example/x",
      "https://attacker.example/put",
      "http://127.0.0.1:8787/put",
    ]) {
      expect(composioUploadLink(link), String(link)).toBeNull();
    }
  });
});
