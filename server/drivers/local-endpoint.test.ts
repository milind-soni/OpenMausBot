import { describe, expect, it } from "vitest";

import { isLocalEndpoint } from "./local-endpoint.ts";

describe("isLocalEndpoint", () => {
  it("accepts loopback and private-network hosts", () => {
    for (const url of [
      "http://127.0.0.1:8080/v1",
      "http://localhost:1234/v1",
      "http://[::1]:8080/v1",
      "http://10.0.0.5:11434/v1",
      "http://192.168.1.20:8000/v1",
      "http://172.16.0.9/v1",
      "http://mybox.localhost/v1",
      "http://[fd12::1]:8080/v1",
    ]) {
      expect(isLocalEndpoint(url), url).toBe(true);
    }
  });

  it("rejects public hosts, however local they sound", () => {
    for (const url of [
      "https://openrouter.ai/api/v1",
      "https://api.groq.com/openai/v1",
      "http://172.32.0.1/v1", // just outside 172.16/12
      "http://localhost.evil.example/v1",
      "http://8.8.8.8/v1",
    ]) {
      expect(isLocalEndpoint(url), url).toBe(false);
    }
  });

  it("treats an unparseable URL as remote — the safe side", () => {
    expect(isLocalEndpoint("not a url")).toBe(false);
    expect(isLocalEndpoint("")).toBe(false);
  });
});
