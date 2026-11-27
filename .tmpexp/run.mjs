import { fromMarkdown } from "mdast-util-from-markdown";
import { windowsPathDestinations } from "./ext.mjs";
const cases = [
  String.raw`[a](C:\Users\Maus\.openmausbot\report.md)`,
  String.raw`![b](<D:\.hidden\chart one.png>)`,
  String.raw`[c]: C:\.cache\notes.md`,
  String.raw`[a](C:\Apps\x\(1\).md)`,
  String.raw`[u](\\nas\share\.private\report.md)`,
  String.raw`[t](C:\a\b.md "C:\.title")`,
  String.raw`[s](C:\Users\Maus\report.md) and prose C:\Users\Maus\.x`,
  String.raw`[q](C:\Users\Maus\"quoted".md)`,
  String.raw`[n](C:\Users\Maus\.a\.b\.c.md)`,
  String.raw`[e](C:\)`,
  String.raw`[f](C:\.\rel.md)`,
  String.raw`[g](c:\users\x\_y\-z\!w.md)`,
];
for (const c of cases) {
  const tree = fromMarkdown(c, { mdastExtensions: [windowsPathDestinations] });
  const urls = [];
  const walk = (n) => { if (n.url !== undefined) urls.push(n.url); (n.children||[]).forEach(walk); };
  walk(tree);
  console.log(JSON.stringify(c), "=>", JSON.stringify(urls));
}
