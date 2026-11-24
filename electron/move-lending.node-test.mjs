import assert from "node:assert/strict";
import test from "node:test";

import { insideFolder, moveLending, shownFolder } from "./move-lending.mjs";

const lent = (folders, more = {}) => ({ enabled: true, folders: folders.map((path) => (typeof path === "string" ? { path, write: true } : path)), terminal: false, ...more });
const reach = (input) => moveLending(input).folderLent;

test("a working folder inside a folder lent to My Cloud with editing is reachable; one beside it or above it is not", () => {
  assert.deepEqual(moveLending({ state: lent(["/Volumes/Work"]), folders: ["/Volumes/Work/app"], platform: "darwin" }), { paused: false, folderLent: true, terminal: false });
  assert.equal(reach({ state: lent(["/srv/app"]), folders: ["/srv/app/"], platform: "linux" }), true);
  assert.equal(reach({ state: lent(["/srv/code"]), folders: ["/srv/codex"], platform: "linux" }), false, "a sibling whose name starts the same is not inside");
  assert.equal(reach({ state: lent(["/srv/code/app"]), folders: ["/srv/code"], platform: "linux" }), false);
  assert.equal(reach({ state: lent(["/srv/Work"]), folders: ["/srv/work/app"], platform: "linux" }), false, "Linux compares case");
  assert.equal(reach({ state: lent(["/Volumes/Work"]), folders: ["/volumes/work/app"], platform: "darwin" }), true, "macOS doesn't");
});

test("a folder lent read-only is not enough: the move would add editing, so it is not counted as lent", () => {
  assert.equal(reach({ state: lent([{ path: "/Volumes/Work", write: false }]), folders: ["/Volumes/Work/app"], platform: "darwin" }), false);
});

test("every folder of a choice must be reachable, not only the first", () => {
  const state = lent(["/Volumes/Work"]);
  assert.equal(reach({ state, folders: ["/Volumes/Work/a", "/Volumes/Work/b"], platform: "darwin" }), true);
  assert.equal(reach({ state, folders: ["/Volumes/Work/a", "/opt/b"], platform: "darwin" }), false);
  assert.equal(reach({ state, folders: [], platform: "darwin" }), false);
});

test("a working folder inside the home folder is reachable, since every Cloud of the person's own is lent it by itself, unless lending is paused", () => {
  assert.equal(reach({ state: null, folders: ["/Users/ash/code/app"], home: "/Users/ash", platform: "darwin" }), true);
  assert.equal(reach({ state: null, folders: ["/Users/ash"], home: "/Users/ash", platform: "darwin" }), true, "the home folder itself");
  assert.equal(reach({ state: null, folders: ["/Volumes/Work/app"], home: "/Users/ash", platform: "darwin" }), false);
  assert.equal(reach({ state: null, paused: true, folders: ["/Users/ash/code/app"], home: "/Users/ash", platform: "darwin" }), false);
  assert.equal(reach({ state: null, folders: ["c:/users/ash/app"], home: "C:\\Users\\Ash", platform: "win32" }), true);
});

test("Windows paths: backslashes, forward slashes, a lower-case drive and a trailing separator all name one folder", () => {
  assert.equal(reach({ state: lent(["C:\\Users\\Ash"]), folders: ["c:/users/ash/Projects/App"], platform: "win32" }), true);
  assert.equal(reach({ state: lent(["D:\\Work\\"]), folders: ["D:\\Work\\site"], platform: "win32" }), true);
  assert.equal(reach({ state: lent(["D:\\Work"]), folders: ["D:\\Workshop"], platform: "win32" }), false);
  assert.equal(insideFolder("C:\\Users\\Ash\\a", "C:/Users/Ash", "win32"), true);
});

test("paused lending lends nothing, whatever the grant says; commands only when the grant lends the terminal", () => {
  assert.deepEqual(moveLending({ state: lent(["/srv"], { terminal: true }), paused: true, folders: ["/srv/app"], platform: "linux" }), { paused: true, folderLent: false, terminal: false });
  assert.equal(moveLending({ state: lent(["/srv"], { terminal: true, problem: "paused" }), folders: ["/srv/app"], platform: "linux" }).paused, true);
  assert.equal(moveLending({ state: lent([], { terminal: true }), platform: "linux" }).terminal, true);
  assert.deepEqual(moveLending({ state: { ...lent(["/srv"]), enabled: false }, folders: ["/srv/app"], platform: "linux" }), { paused: false, folderLent: false, terminal: false });
  assert.deepEqual(moveLending({ state: null, folders: ["/srv/app"], platform: "linux" }), { paused: false, folderLent: false, terminal: false });
});

test("the folder is shown under ~ inside the home folder on macOS and Linux, and as it is anywhere else", () => {
  assert.equal(shownFolder("/Users/ash/code/app", "/Users/ash", "darwin"), "~/code/app");
  assert.equal(shownFolder("/home/ash", "/home/ash/", "linux"), "~");
  assert.equal(shownFolder("/opt/app", "/Users/ash", "darwin"), "/opt/app");
  assert.equal(shownFolder("/Users/ashley/app", "/Users/ash", "darwin"), "/Users/ashley/app");
  assert.equal(shownFolder("C:\\Users\\Ash\\app", "C:\\Users\\Ash", "win32"), "C:\\Users\\Ash\\app");
  assert.equal(shownFolder(null, "/Users/ash", "darwin"), null);
});
