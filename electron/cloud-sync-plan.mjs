// What one pass of Files does, worked out from three listings of one folder: this computer's (`pc`), My Cloud's
// (`cloud`) and the base (each file as it was when both last matched). Pure: the engine carries the plan out.

// This many files leaving a shared folder at once, and at least this share of it, waits for the person to say so.
export const ASK_DELETES_AT = 10;
export const ASK_DELETES_SHARE = 0.2;

/**
 * A shared folder goes one way, this computer to My Cloud: this computer's version always wins. A file gone from this
 * computer is removed from My Cloud only when the base proves it was there, and never while anything else cannot be read
 * (`unsettled`, or `kept`: links and hard-linked files, present but not carried). Files only My Cloud has (a bot's) stay.
 */
export function planShare({ base, pc, cloud, keptDirs = [] }) {
  const uploads = [], records = [], deletes = [], forgets = [];
  const underKept = (path) => keptDirs.some((dir) => path.startsWith(`${dir}/`));
  for (const [path, file] of pc) {
    if (file.unsettled || file.kept) continue;
    const there = cloud.get(path);
    if (there?.sha256 === file.sha256) {
      const known = base.get(path);
      if (!known || known.sha256 !== file.sha256 || known.size !== file.size || known.mtimeMs !== file.mtimeMs) records.push({ path, sha256: file.sha256, size: file.size, mtimeMs: file.mtimeMs });
      continue;
    }
    uploads.push({ path, sha256: file.sha256, size: file.size, mtimeMs: file.mtimeMs, file: file.file, baseSha256: there?.sha256 ?? null });
  }
  for (const [path, known] of base) {
    if (pc.has(path) || underKept(path)) continue;
    const there = cloud.get(path);
    if (!there) { forgets.push({ path }); continue; }
    deletes.push({ path, baseSha256: there.sha256, size: known.size });
  }
  const ask = deletes.length > 0 && ((pc.size === 0 && base.size > 0) || (deletes.length >= ASK_DELETES_AT && deletes.length >= ASK_DELETES_SHARE * base.size));
  return { uploads, records, deletes, forgets, ask };
}

/**
 * A bot's work comes one way, My Cloud to this computer, and never deletes here. A file the person changed here since it
 * came (size or time differs from the base) is kept as it is: My Cloud's newer version lands beside it (`beside`). A file
 * the person removed here comes back only when My Cloud has a newer version.
 */
export function planOutputs({ base, pc, cloud }) {
  const downloads = [], records = [];
  for (const [path, there] of cloud) {
    const here = pc.get(path), known = base.get(path);
    if (here?.unsettled || here?.kept) continue;
    if (here && here.sha256 === there.sha256) {
      if (!known || known.sha256 !== there.sha256 || known.size !== here.size || known.mtimeMs !== here.mtimeMs) records.push({ path, sha256: there.sha256, size: here.size, mtimeMs: here.mtimeMs });
      continue;
    }
    if (known && known.sha256 === there.sha256) continue;
    if (!here) { downloads.push({ path, sha256: there.sha256, size: there.size, replace: null }); continue; }
    const untouched = Boolean(known && here.size === known.size && here.mtimeMs === known.mtimeMs);
    downloads.push({ path, sha256: there.sha256, size: there.size, replace: untouched ? here : null, beside: !untouched });
  }
  return { downloads, records };
}
