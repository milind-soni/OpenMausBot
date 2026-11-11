type BurstApi = (path: string, init: { method: string; body: string }) => Promise<Record<string, unknown>>;

export async function callBurstTool(args: Record<string, unknown>, api: BurstApi): Promise<{ text: string; isError?: boolean }> {
  const task = String(args.task ?? "").trim();
  const instructions = String(args.instructions ?? "").trim();
  const items = Array.isArray(args.items) ? args.items.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  if (!task || !instructions || items.length === 0) return { text: "burst needs task, instructions and items, one item per part.", isError: true };
  const r = await api("/api/internal/bursts", { method: "POST", body: JSON.stringify({ task, instructions, items }) });
  if (r.error) return { text: `Couldn't propose that burst: ${String(r.error)}`, isError: true };
  const cut = Number(r.requested) > Number(r.total) ? ` The plan runs ${String(r.total)} of the ${String(r.requested)} you listed.` : "";
  return { text: `Burst proposed: ${String(r.total)} parts, ${String(r.parallel)} at once, on ${String(r.modelName)}.${cut} A card with Run, Edit and Cancel is in the chat. Nothing runs until the person presses Run: say so in one short line and end your turn; do not do the work here.` };
}
