// A live published page: its index.html carries the version of its files and a small check that reloads the page when
// the link serves a newer version, so a page republished from a changed folder updates in every open browser.
import { createHash } from "node:crypto";
import type { PageFile } from "./bundle.ts";

/** How often an open live page asks its own link for a newer version. */
const CHECK_EVERY_MS = 30_000;
const DOCTYPE = /^\s*<!doctype[^>]*>/iu;

const reloadCheck = (version: string) =>
  `<meta name="omb-live" content="${version}"><script>(()=>{const v="${version}";setInterval(async()=>{try{` +
  `const t=await(await fetch(location.href,{cache:"no-store"})).text();const m=/<meta name="omb-live" content="([0-9a-f]+)"/.exec(t);` +
  `if(m&&m[1]!==v)location.reload()}catch{}},${CHECK_EVERY_MS})})()</script>`;

/** The files with the reload check put at the top of index.html (after its doctype, so the page keeps its mode). */
export function liveFiles(files: readonly PageFile[]): PageFile[] {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.data.byteLength}\0`).update(file.data);
  const check = reloadCheck(hash.digest("hex").slice(0, 16));
  return files.map((file) => {
    if (file.path !== "index.html") return file;
    const html = file.data.toString("utf8");
    const doctype = DOCTYPE.exec(html)?.[0] ?? "";
    return { path: file.path, data: Buffer.from(doctype + check + html.slice(doctype.length)) };
  });
}
