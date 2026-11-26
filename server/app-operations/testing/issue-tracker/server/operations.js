const STATUSES = ["open", "doing", "done"];

export async function list(input, ctx) {
  const status = input && STATUSES.includes(input.status) ? input.status : null;
  const { rows } = await ctx.db.query(
    status ? "SELECT id, title, status, label FROM issues WHERE status = ? ORDER BY id" : "SELECT id, title, status, label FROM issues ORDER BY id",
    status ? [status] : [],
  );
  return rows;
}

export async function add(input, ctx) {
  const title = String(input?.title ?? "").trim();
  if (!title || title.length > 200) throw new Error("A title is 1 to 200 characters.");
  const { lastInsertRowid } = await ctx.db.exec("INSERT INTO issues (title, label) VALUES (?, ?)", [title, input?.label ?? null]);
  ctx.log("added", lastInsertRowid);
  return { id: lastInsertRowid };
}

export async function setStatus(input, ctx) {
  if (!STATUSES.includes(input?.status)) throw new Error("status is open, doing or done.");
  const { changes } = await ctx.db.exec("UPDATE issues SET status = ? WHERE id = ?", [input.status, input.id]);
  if (changes !== 1) throw new Error(`No issue ${input.id}.`);
  return { ok: true };
}

export async function stats(_input, ctx) {
  const { rows } = await ctx.db.query("SELECT status, count(*) AS n FROM issues GROUP BY status ORDER BY status");
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}
