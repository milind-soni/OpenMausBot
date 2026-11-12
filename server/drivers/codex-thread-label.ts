import type { SendTurnInput } from "../contracts.ts";

type Label = NonNullable<SendTurnInput["nativeLabel"]>;
type Request = (method: string, params: unknown) => Promise<any>;
type NativeThread = { id: string; name?: string | null; section?: { id?: string; name?: string } | null };

const SECTION_PREFIX = "MausBot";
const NAME_MAX = 120;

export function codexThreadLabel(label: Label): { section: string; name: string } {
  const department = label.department?.trim();
  const name = `${label.bot.trim()} · ${label.conversation.trim()}`;
  return {
    section: department ? `${SECTION_PREFIX} · ${department}` : SECTION_PREFIX,
    name: name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name,
  };
}

const creating = new Map<string, Promise<string>>();

async function sectionId(request: Request, home: string, name: string): Promise<string> {
  let cursor: string | null = null;
  do {
    const page: { data?: Array<{ id: string; name: string }>; nextCursor?: string | null } =
      await request("threadSection/list", cursor ? { cursor } : {});
    const found = page?.data?.find((section) => section.name === name);
    if (found) return found.id;
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  const key = `${home}\0${name}`;
  const pending = creating.get(key) ?? request("threadSection/create", { name })
    .then((created: { section?: { id?: string } }) => {
      if (!created?.section?.id) throw new Error("Codex did not return a section id");
      return created.section.id;
    })
    .finally(() => creating.delete(key));
  creating.set(key, pending);
  return pending;
}

export async function fileCodexThread(request: Request, home: string, thread: NativeThread, label: Label): Promise<void> {
  const wanted = codexThreadLabel(label);
  const placedByPerson = thread.section && thread.section.name !== SECTION_PREFIX && !thread.section.name?.startsWith(`${SECTION_PREFIX} · `);
  if (!placedByPerson && thread.section?.name !== wanted.section) {
    await request("thread/section/move", { threadId: thread.id, sectionId: await sectionId(request, home, wanted.section) });
  }
  if (thread.name !== wanted.name) await request("thread/name/set", { threadId: thread.id, name: wanted.name });
}
