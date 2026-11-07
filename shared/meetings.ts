// Meeting notes: a bot joins an online meeting as a guest on its cloud computer, transcribes it and writes notes.

export type MeetingPlatform = "meet" | "teams" | "jitsi";

export const MEETING_PLATFORM_NAMES: Record<MeetingPlatform, string> = { meet: "Google Meet", teams: "Microsoft Teams", jitsi: "Jitsi Meet" };

/** Why a meeting ended, as the bot on the cloud computer reports it. */
export type MeetingEndReason = "left" | "stop_requested" | "meeting_ended" | "removed" | "denied" | "lobby_timeout" | "guests_blocked"
  | "not_found" | "join_failed" | "consent_failed" | "alone" | "max_length" | "crashed" | "lost";

export type MeetingPhase = "starting" | "joining" | "lobby" | "in_meeting" | "ended";

export const END_REASON_TEXT: Record<MeetingEndReason, string> = {
  left: "I left the meeting.",
  stop_requested: "Someone in the meeting typed \"@notes stop\", so I left.",
  meeting_ended: "The meeting ended.",
  removed: "Someone removed me from the meeting.",
  denied: "The host turned down my request to join.",
  lobby_timeout: "Nobody let me in, so I gave up waiting.",
  guests_blocked: "This meeting doesn't let guests join (the organizer's settings need a signed-in account), so I couldn't get in.",
  not_found: "That meeting link doesn't lead to a meeting. Check the link.",
  join_failed: "I couldn't get through the meeting's join screen.",
  consent_failed: "I couldn't post my note-taking notice in the meeting chat (chat may be off for guests), so I left without recording anything.",
  alone: "Everyone else left, so I left too.",
  max_length: "The meeting reached the 4-hour limit, so I left.",
  crashed: "The meeting bot stopped unexpectedly. What it heard until then is kept.",
  lost: "I lost contact with the cloud computer running the meeting. What it heard until then is kept.",
};

export type MeetingLink = { ok: true; platform: MeetingPlatform; url: string } | { ok: false; error: string };

export const ZOOM_NOT_SUPPORTED = "Zoom meetings aren't supported yet. I can join Google Meet, Microsoft Teams and Jitsi links.";
const NOT_A_MEETING = "That doesn't look like a Google Meet, Microsoft Teams or Jitsi meeting link.";
const MEET_CODE = /^\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i;
const JITSI_HOSTS = /(^|\.)jit\.si$|^8x8\.vc$|^meet\.systemli\.org$|(^|\.)jitsi\./i;

export function parseMeetingLink(raw: string): MeetingLink {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: NOT_A_MEETING };
  }
  if (url.protocol !== "https:" || url.username || url.password) return { ok: false, error: NOT_A_MEETING };
  const host = url.hostname.toLowerCase();
  if (/(^|\.)zoom\.(us|com)$|(^|\.)zoomgov\.com$/.test(host)) return { ok: false, error: ZOOM_NOT_SUPPORTED };
  if (host === "meet.google.com") {
    return MEET_CODE.test(url.pathname) || url.pathname.startsWith("/lookup/") ? { ok: true, platform: "meet", url: url.toString() } : { ok: false, error: NOT_A_MEETING };
  }
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host === "teams.cloud.microsoft") {
    return /^\/(l\/meetup-join|meet|v2|_#\/l\/meetup-join)/i.test(url.pathname) || /meetup-join/i.test(url.hash)
      ? { ok: true, platform: "teams", url: url.toString() } : { ok: false, error: NOT_A_MEETING };
  }
  if (JITSI_HOSTS.test(host) && /^\/[^/]+\/?$/.test(url.pathname)) return { ok: true, platform: "jitsi", url: url.toString() };
  return { ok: false, error: NOT_A_MEETING };
}

/** The first Meet, Teams or Jitsi link in free text, such as a calendar event's description. */
export function findMeetingLink(text: string | undefined): string | null {
  for (const match of (text ?? "").matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
    const link = match[0].replace(/[.,;]+$/, "");
    if (parseMeetingLink(link).ok) return link;
  }
  return null;
}

/** The name the bot shows in the meeting. */
export const meetingDisplayName = (botName: string): string => `${botName.trim().slice(0, 40) || "MausBot"} (notes)`;

/** Posted in the meeting chat the moment the bot is let in, before anything is captured. Not configurable. */
export function consentLine(botName: string, personName: string | undefined): string {
  const forWhom = personName?.trim() ? `for ${personName.trim().slice(0, 60)}` : "for the person who invited me";
  return `Hi, I'm ${meetingDisplayName(botName)} from MausBot, taking notes ${forWhom}. Ask me with @notes. Type "@notes stop" and I'll leave.`;
}

export const MEETING_MAX_MS = 4 * 60 * 60_000;
export const MEETING_LOBBY_MS = 10 * 60_000;
export const MEETING_ALONE_MS = 2 * 60_000;

/** The routine that joins the person's calendar meetings: created only when they ask for it. */
export const MEETING_ROUTINE = {
  name: "Join my meetings and take notes",
  everyMinutes: 10,
  windowStart: "07:50",
  windowEnd: "19:00",
  prompt: [
    "Check my Google Calendar for meetings that start in the next 12 minutes or started less than 5 minutes ago.",
    "Skip all-day events, cancelled ones and ones I declined.",
    "For each one with a Google Meet or Microsoft Teams link (look at the conference link, the location and the description), call join_meeting with that link and the event title as the note.",
    "join_meeting answers that you are already there for a meeting you joined, so calling it again is safe.",
    "If there is nothing to join, finish without a message.",
  ].join(" "),
} as const;

export interface MeetingLine {
  speaker: string | null;
  text: string;
  /** Epoch milliseconds. */
  start: number;
  end: number;
}
