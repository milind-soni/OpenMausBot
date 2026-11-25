// @vitest-environment happy-dom
import { expect, it } from "vitest";

it("reads a key written on localStorage back through window.localStorage", () => {
  localStorage.setItem("omb", "kept");
  expect(window.localStorage.getItem("omb")).toBe("kept");
  localStorage.removeItem("omb");
  expect(window.localStorage.getItem("omb")).toBeNull();
});
