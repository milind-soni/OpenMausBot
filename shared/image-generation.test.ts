import { describe, expect, it } from "vitest";
import { normalizeImageGenerationUrl } from "./image-generation";

describe("avatar image endpoint", () => {
  it.each([
    ["https://router.example/v1/", "https://router.example/v1"],
    ["http://127.0.0.1:20128/v1/images/generations", "http://127.0.0.1:20128/v1"],
    ["http://[::1]:4000/v1", "http://[::1]:4000/v1"],
    ["http://192.168.1.10:4000/v1", "http://192.168.1.10:4000/v1"],
    ["http://host.docker.internal:4000/v1", "http://host.docker.internal:4000/v1"],
  ])("normalizes an explicitly configured endpoint %s", (input, expected) => {
    expect(normalizeImageGenerationUrl(input)).toBe(expected);
  });
  it.each([
    "file:///etc/passwd", "http://router.example/v1", "https://user:secret@router.example/v1",
    "https://router.example/v1?key=secret", "https://router.example/v1#secret",
    "http://169.254.169.254/latest", "https://169.254.169.254/latest", "http://0.0.0.0/v1", "https://0.0.0.0/v1",
    "http://[fd00:ec2::254]/latest", "https://[fd00:ec2::254]/latest", "http://[fc00::1]/v1", "https://[fdaa::3]/v1",
    "https://[::ffff:169.254.169.254]/latest", "https://[::]/v1", "https://[::ffff:0.0.0.0]/",
    "https://100.100.100.200/latest", "https://[64:ff9b::a9fe:a9fe]/", "https://[2002:a9fe:a9fe::]/", "https://[fe80::1]/v1",
    "not a URL",
  ])("rejects unsafe or secret-bearing URLs %s", (input) => {
    expect(() => normalizeImageGenerationUrl(input)).toThrow("API base URL");
  });
});
