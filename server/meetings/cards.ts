// The two cards a meeting puts in its conversation: the live one (waiting, in the meeting, ended, with Leave) and the notes.
import { END_REASON_TEXT, MEETING_PLATFORM_NAMES, type MeetingEndReason } from "../../shared/meetings.ts";
import type { WidgetText } from "../../shared/widget-text.ts";
import type { ServerLineKey } from "../server-lines.ts";
import { WIDGET_LIMITS, type WidgetRoot } from "../../shared/widget.ts";
import type { MeetingRecord } from "./manager.ts";

type Node = Record<string, unknown>;

export const LEAVE_ACTION = "meeting_leave";

/** Each end reason's words in the language packs. */
export const END_LINE = {
  left: "server.meetings.end.left", stop_requested: "server.meetings.end.stop_requested", meeting_ended: "server.meetings.end.meeting_ended",
  removed: "server.meetings.end.removed", denied: "server.meetings.end.denied", lobby_timeout: "server.meetings.end.lobby_timeout",
  guests_blocked: "server.meetings.end.guests_blocked", meet_refused: "server.meetings.end.meet_refused", not_found: "server.meetings.end.not_found", join_failed: "server.meetings.end.join_failed",
  consent_failed: "server.meetings.end.consent_failed", alone: "server.meetings.end.alone", max_length: "server.meetings.end.max_length",
  crashed: "server.meetings.end.crashed", lost: "server.meetings.end.lost", speech_unavailable: "server.meetings.end.speech_unavailable",
} as const satisfies Record<MeetingEndReason, ServerLineKey>;

const words = (key: string, params?: WidgetText["params"]): WidgetText => ({ key, ...(params ? { params } : {}) });
const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
const text = (value: string, said?: WidgetText, weight?: "medium"): Node => ({ type: "Text", value: clip(value, WIDGET_LIMITS.text), ...(weight ? { weight } : {}), ...(said ? { i18n: { value: said } } : {}) });
const caption = (value: string, said?: WidgetText): Node => ({ type: "Caption", value: clip(value, 160), ...(said ? { i18n: { value: said } } : {}) });
const title = (value: string, said: WidgetText): Node => ({ type: "Title", value, size: "sm", i18n: { value: said } });

function root(heading: string, sub: string, children: Node[], said: { title?: WidgetText; caption?: WidgetText } = {}): WidgetRoot {
  return {
    type: "Card", id: "root", title: clip(heading.replace(/\s+/g, " ").trim(), WIDGET_LIMITS.title), caption: clip(sub.replace(/\s+/g, " ").trim(), WIDGET_LIMITS.caption), children,
    ...(said.title || said.caption ? { i18n: said } : {}),
  } as unknown as WidgetRoot;
}

function status(record: MeetingRecord, minutes: number): Node {
  switch (record.phase) {
    case "starting": return text("Getting the cloud computer ready…", words("server.meetings.card.starting"), "medium");
    case "joining": return text("Joining the meeting…", words("server.meetings.card.joining"), "medium");
    case "lobby": return text("Waiting for the host to let me in", words("server.meetings.card.lobby"), "medium");
    case "in_meeting": return text(`In the meeting · others here: ${record.others} · ${minutes} min`, words("server.meetings.card.live", { count: record.others, minutes }), "medium");
    default: {
      const reason: MeetingEndReason = record.endReason ?? "meeting_ended";
      return record.joinedAt
        ? text(`Ended after ${minutes} min. ${END_REASON_TEXT[reason]}`, words("server.meetings.card.ended", { minutes, reason: words(END_LINE[reason]) }), "medium")
        : text(END_REASON_TEXT[reason], words(END_LINE[reason]), "medium");
    }
  }
}

export function liveCard(record: MeetingRecord, minutes: number): WidgetRoot {
  const where = MEETING_PLATFORM_NAMES[record.platform];
  const children: Node[] = [status(record, minutes)];
  if (record.phase === "in_meeting" && record.questions > 0) children.push(caption(`Questions answered in the chat: ${record.questions}`, words("server.meetings.card.questions", { count: record.questions })));
  if (record.phase !== "ended" && record.speechState === "installing") children.push(caption("Setting up transcription (one-time, about a minute)…", words("server.meetings.card.settingUp")));
  if (record.phase !== "ended" && record.speechProblem) children.push(text(`Transcription stopped: ${record.speechProblem}`, words("server.meetings.card.speechStopped", { problem: record.speechProblem })));
  if (record.phase === "ended" && record.endReason === "speech_unavailable" && record.endDetail) children.push(text(record.endDetail));
  if (record.phase === "ended" && record.notes === "asked") children.push(caption("Writing the notes…", words("server.meetings.card.writing")));
  if (record.phase !== "ended") {
    children.push({ type: "Row", gap: 2, wrap: true, children: [{ type: "Button", label: "Leave meeting", style: "secondary", onClickAction: { type: LEAVE_ACTION, payload: { meetingId: record.id } }, i18n: { label: words("server.meetings.card.leave") } }] });
  }
  return root(record.note ?? where, record.note ? where : "Meeting notes", children, record.note ? {} : { caption: words("server.meetings.card.title") });
}

export interface MeetingNotes {
  title: string;
  summary: string;
  decisions: string[];
  actions: Array<{ owner?: string; item: string; due?: string }>;
  questions: string[];
}

const section = (heading: string, key: string, rows: Node[]): Node[] => (rows.length ? [title(heading, words(key)), ...rows] : []);

export function notesCard(record: MeetingRecord, notes: MeetingNotes, minutes: number, dateLine: string): WidgetRoot {
  const people = record.attendees.length ? record.attendees.join(", ") : "";
  return root(notes.title, `${dateLine} · ${minutes} min · ${MEETING_PLATFORM_NAMES[record.platform]}`, [
    ...section("Summary", "server.meetings.notes.summary", notes.summary.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 12).map((line) => text(line))),
    ...section("Decisions", "server.meetings.notes.decisions", notes.decisions.slice(0, 20).map((line) => text(`• ${line}`))),
    ...section("Action items", "server.meetings.notes.actions", notes.actions.slice(0, 30).map((action) =>
      text(`• ${action.owner ? `${action.owner}: ` : ""}${action.item}${action.due ? ` (by ${action.due})` : ""}`))),
    ...section("Open questions", "server.meetings.notes.questions", notes.questions.slice(0, 15).map((line) => text(`• ${line}`))),
    ...(people ? section("Attendees", "server.meetings.notes.attendees", [text(people)]) : []),
    caption("The full transcript is attached below.", words("server.meetings.notes.transcript")),
  ]);
}
