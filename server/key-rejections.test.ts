import { expect, it, vi } from "vitest";
import { forgetKey, keyRejected, noteKeyAccepted, noteKeyRejected, onKeyRejectionChange, rejectsKey } from "./key-rejections.ts";

it.each([
  [401, `{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}`, true],
  [401, "", true],
  [403, `{"error":{"message":"API key has been revoked"}}`, true],
  [400, `{"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***yz."}`, true],
  [429, `{"error":{"message":"Rate limit reached"}}`, false],
  [429, `{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}`, false],
  [401, `{"error":{"message":"Your credit balance is too low (billing)"}}`, false],
  [402, `{"error":{"message":"Insufficient credits"}}`, false],
  [403, `{"error":{"message":"You do not have access to model gpt-9"}}`, false],
  [403, "Forbidden", false],
  [400, `{"error":{"message":"messages must not be empty"}}`, false],
  [500, "invalid api key", false],
])("HTTP %i %s rejects the key: %s", (status, body, expected) => {
  expect(rejectsKey(status, body)).toBe(expected);
});

it("marks a key per endpoint until it is accepted or forgotten, without keeping the key", () => {
  const listener = vi.fn();
  const stop = onKeyRejectionChange(listener);
  const url = "https://fixture.invalid/v1";
  noteKeyRejected(`${url}/`, "fixture-rejected-key");
  noteKeyRejected(url, "fixture-rejected-key");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(keyRejected(url, "fixture-rejected-key")).toBe(true);
  expect(keyRejected(url, "fixture-other-key")).toBe(false);
  expect(keyRejected("https://other.invalid/v1", "fixture-rejected-key")).toBe(false);

  noteKeyAccepted(url, "fixture-rejected-key");
  expect(keyRejected(url, "fixture-rejected-key")).toBe(false);
  noteKeyAccepted(url, "fixture-rejected-key");
  expect(listener).toHaveBeenCalledTimes(2);

  noteKeyRejected(url, "fixture-rejected-key");
  noteKeyRejected("https://other.invalid/v1", "fixture-rejected-key");
  forgetKey("fixture-rejected-key");
  expect(keyRejected(url, "fixture-rejected-key")).toBe(false);
  expect(keyRejected("https://other.invalid/v1", "fixture-rejected-key")).toBe(false);
  expect(listener).toHaveBeenCalledTimes(5);
  stop();
});
