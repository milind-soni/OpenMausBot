// Dev-only gallery of the question and approval cards on a Team Cloud, served at /question-cards-preview.html; not in
// the packaged app. It mounts the real chat and inbox components over a fixed store, with no server behind it.
// ?state=question|approval|open|answered|others&surface=chat|inbox|panel&skin=midnight|daylight&mode=simple|advanced&lang=de
import { StrictMode, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { InboxRow, InboxView } from "../shared/inbox";
import { ChatView } from "@/components/ChatView";
import { InboxPanel } from "@/components/inbox/InboxPanel";
import { setLocale } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { openInbox, setInboxView } from "@/state/inbox";
import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import { setTeamPeople } from "@/state/team-people";
import "./styles.css";

const params = new URLSearchParams(location.search);
const stateName = params.get("state") ?? "question";
const surface = params.get("surface") ?? "chat";
const skin = params.get("skin") ?? "midnight";
setAdvancedMode(params.get("mode") === "advanced");
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
setLocale(params.get("lang") ?? "en");

const AT = Date.now() - 12 * 60_000;
const PHILIPP = { email: "philipp@acme.test", name: "Philipp", role: "owner" };
const QUESTION = "Soll ich den Fix für die Sondervariante umsetzen?";
const CHOICES = ["Ja, nur den Abschlusstext", "Ja, auch den Einladungstext", "Nein"];
const OPEN_QUESTION = "Welche Formulierung soll der neue Abschlusstext für die Sondervariante bekommen?";
const COMMAND = "git push origin fix/natural-greenery-custom-case && gh pr create --base develop --title \"Fix: Sondervariante natural-greenery\"";
const WORK = "biber-work";
const INBOX = "luchs-inbox";

const questionCard = (answered?: string): NonNullable<Message["card"]> => ({
  title: "Your bot has a question", subtitle: QUESTION, options: CHOICES, requestId: "req-question", requestType: "question",
  ...(answered ? { answered: "answer", answeredText: answered } : {}),
});
const approvalCard: NonNullable<Message["card"]> = {
  title: "Approval needed", subtitle: COMMAND, options: ["Allow", "Deny"], requestId: "req-approval", requestType: "permission", tool: "Bash",
};
const openCard: NonNullable<Message["card"]> = {
  title: "Your bot has a question", subtitle: OPEN_QUESTION, options: [], requestId: "needs-input-as_1-1", requestType: "question",
};
const cardFor = (state: string): NonNullable<Message["card"]> | null =>
  state === "question" ? questionCard() : state === "answered" ? questionCard(CHOICES[0]) : state === "approval" ? approvalCard : state === "open" ? openCard : null;

const message = (id: string, minutes: number, fields: Partial<Message>): Message =>
  ({ id, at: AT + minutes * 60_000, role: "bot", kind: "text", text: "", ...fields }) as Message;

/** The other cards that share the question card's shell: a key, a sign-in, a connection and a first-run choice. */
const others = (): Message[] => [
  message("secret", 1, { kind: "secret", text: "Securely provide the OpenAI API key.", secret: { target: "openaiImageApiKey", label: "OpenAI API key",
    description: "Generate a key at platform.openai.com. Biber can use it but never read it back.", placeholder: "sk-…", helpUrl: "https://platform.openai.com/api-keys", requestKey: "request-key-1" } }),
  message("signin", 2, { kind: "signin", signIn: { url: "https://example.com/login", site: "example.com", place: "browser", reason: "The report is behind a login." } }),
  message("connector", 3, { kind: "connector", connector: { slug: "github", label: "GitHub", description: "Read pull requests", status: "required", resumeKey: "resume1" } }),
  message("quiz", 4, { kind: "options", card: { title: "Wie soll ich dich nennen?", subtitle: "", options: ["Philipp", "Phil", "Herr Huber"] } }),
] as Message[];

function biberMessages(state: string): Message[] {
  if (state === "others") return others();
  const rows: Message[] = [
    message("brief", 0, { role: "bot", from: { botId: "luchs", name: "Luchs", color: "orange" }, roomRequest: { id: "job-1", phase: "request" },
      text: "@Biber Setz bitte den Fix für die Sondervariante natural-greenery um: als Branch fix/natural-greenery-custom-case, mit PR nach develop." }),
    message("reply", 2, { text: state === "open"
      ? "Ich habe die Sondervariante geprüft: Der Abschlusstext nutzt noch die alte Vorlage."
      : "Ich habe die Sondervariante geprüft: Abschlusstext und Einladungstext nutzen beide noch die alte Vorlage. Bevor ich etwas ändere:" }),
  ];
  const card = cardFor(state);
  if (card) rows.push(message("ask", 3, { kind: "options", text: card.subtitle, card }));
  if (state === "answered") rows.push(message("after", 5, { text: "Gut, ich passe nur den Abschlusstext an und öffne den PR nach develop." }));
  return rows;
}

function inboxRows(state: string): InboxRow[] {
  const card = cardFor(state);
  const rows: InboxRow[] = [];
  if (card) {
    rows.push({ id: "copy", kind: "ask", tab: state === "answered" ? "done" : "needs-you", unread: state !== "answered", at: AT + 3 * 60_000,
      from: { name: "Biber", botId: "biber" }, origin: { botId: "biber", threadId: WORK, title: "Sondervariante: Fix" }, text: card.subtitle, card });
  }
  rows.push({ id: "report", kind: "result", tab: "info", unread: false, at: AT - 90 * 60_000, from: { name: "Luchs", botId: "luchs" },
    origin: { botId: "luchs", threadId: "luchs-daily", title: "Tagesübersicht" }, text: "Tagesübersicht: 3 neue Leads, 1 Antwort offen." });
  return rows;
}

function inboxMessages(state: string): Message[] {
  const rows: Message[] = [
    message("ask-luchs", -2, { role: "user", sender: { name: PHILIPP.name, id: "p_philipp" },
      text: "Kannst du Biber den Fix für die Sondervariante umsetzen lassen? Branch fix/natural-greenery-custom-case, PR nach develop." }),
    message("handed", -1, { text: "Mach ich: Biber setzt den Fix um und meldet sich, wenn etwas von dir gebraucht wird." }),
  ];
  const card = cardFor(state);
  if (card) {
    rows.push(message("copy", 3, { kind: "options", text: card.subtitle, card,
      inbox: { kind: "ask", from: { name: "Biber", botId: "biber" }, origin: { botId: "biber", threadId: WORK, title: "Sondervariante: Fix" } } }));
  }
  return rows;
}

const BASE = {
  title: "", description: "", notifications: true, unread: false, modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
} as const;

function bots(state: string): Bot[] {
  const biber: Bot = { ...BASE, id: "biber", name: "Biber", title: "Entwickler", color: "teal", createdBy: PHILIPP.email, threadId: WORK, mainThreadId: "biber-main",
    busy: state === "question" || state === "approval", activity: state === "question" || state === "approval" ? "waiting-on-you" : "idle",
    tasks: [{ threadId: "biber-main", title: "Biber", createdAt: AT - 86_400_000 }, { threadId: WORK, title: "Sondervariante: Fix", createdAt: AT, private: true,
      openedBy: { botId: "luchs", name: "Luchs", at: AT } }], messages: biberMessages(state) };
  const luchs: Bot = { ...BASE, id: "luchs", name: "Luchs", title: "Philipps Chief", color: "orange", chiefOfStaff: true, reportsTo: PHILIPP.email, threadId: INBOX,
    tasks: [{ threadId: INBOX, title: "Inbox", createdAt: AT - 86_400_000, inbox: true, ...(cardFor(state) && state !== "answered" ? { openAsks: 1 } : {}) }],
    messages: inboxMessages(state) };
  return [biber, luchs];
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh w-full overflow-hidden bg-app text-ink">{children}</div>;
}

function Gallery() {
  const all = useMemo(() => bots(stateName), []);
  const view: InboxView = { botId: "luchs", threadId: INBOX, rows: inboxRows(stateName), anchor: inboxRows(stateName)[0]?.id ?? null };
  setInboxView(view);
  if (surface === "panel") openInbox(view.rows[0]?.kind === "ask" && stateName !== "answered" ? { reading: view.rows[0].id } : { tab: stateName === "answered" ? "done" : "needs-you" });
  const shown = surface === "chat" ? all[0]! : all[1]!;
  const state: AppState = { ...initialState, bots: all, selectedId: shown.id, connected: true };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return (
    <StoreContext.Provider value={value}>
      <Frame>
        <div className="flex min-w-0 flex-1 flex-col"><ChatView bot={shown} /></div>
        {surface === "panel" && <InboxPanel />}
      </Frame>
    </StoreContext.Provider>
  );
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!new URL(url, location.href).pathname.startsWith("/api/")) return realFetch(input, init);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
setTeamPeople({ people: [{ ...PHILIPP, you: true }, { email: "marco@acme.test", name: "Marco", role: "member" }], me: { ...PHILIPP, you: true }, admin: true, needsYou: [] });

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
