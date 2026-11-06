import { AppWindow, Crosshair } from "lucide-react";
import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { AppMessage } from "./app/AppMessage";
import { BugReportNote } from "./BugReportNote";
import { GoalRunRow } from "./GoalRunCard";
import { HelperKeySuggestion } from "./HelperKeySuggestion";
import { MessageBoundary } from "./MessageBoundary";
import { WidgetMessage } from "./widget/WidgetMessage";

export function richRowKind(message: Message): Message["kind"] {
  // MausBot's follow-up is text the model reads, drawn under its intro's card row (OptionsCardRow).
  if (message.helperFollowup) return "options";
  if (message.setupSuggestion || (message.kind === "goal.run" && message.goalRun)) return "widget";
  if (message.kind === "widget" && !message.widget) return "text";
  if (message.kind === "app" && !message.app) return "text";
  return message.kind;
}

/** `room`: shown to everyone in a room, view-only. */
export function RichMessageRow({ botId, botName, threadId, message, room }: { botId: string; botName: string; threadId?: string; message: Message; room?: boolean }) {
  return (
    <MessageBoundary fallbackText={message.text ?? ""}>
      {message.setupSuggestion
        ? <HelperKeySuggestion threadId={threadId} message={message} />
        : message.kind === "goal.run"
          ? <GoalRunRow botId={botId} threadId={threadId} message={message} />
          : message.kind === "app"
            ? <AppMessage botId={botId} botName={botName} threadId={threadId} message={message} room={room} />
            : <WidgetMessage botId={botId} threadId={threadId} message={message} viewOnly={room} />}
    </MessageBoundary>
  );
}

/** A page, an app or a widget a room member showed: the same row as in its own chat, view-only. */
export function RoomRichRow({ message, from, threadId }: { message: Message; from: NonNullable<Message["from"]>; threadId: string }) {
  return (
    <div className="flex justify-start">
      <RichMessageRow botId={from.botId} botName={from.name} threadId={threadId} message={message} room />
    </div>
  );
}

export function UserLineNote({ message }: { message: Message }) {
  // A @devs message: its report's status ("Got it, we're looking", then "Fixed in 0.1.x").
  if (message.bugReport) return <BugReportNote report={message.bugReport} />;
  if (message.pointed?.length) {
    const label = t("chat.preview.pointedAt", { parts: message.pointed.map((part) => part.label).join(", ") });
    return (
      <span data-pointed-note className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-ink-tertiary" title={label}>
        <Crosshair aria-hidden="true" size={11} className="shrink-0" />
        <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
      </span>
    );
  }
  if (message.fromApp?.title) {
    const label = t("app.sentFrom", { title: message.fromApp.title });
    return (
      <span data-sent-from-app={message.fromApp.messageId} className="mt-1 flex items-center gap-1 text-[11px] text-ink-tertiary" title={label}>
        <AppWindow aria-hidden="true" size={11} className="shrink-0" />
        <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
      </span>
    );
  }
  if (message.via === "api") return <span data-via-bot-api className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.viaBotApi")}>{t("chat.viaBotApi")}</span>;
  if (message.via !== "call") return null;
  return <span className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.viaCall")}>{t("chat.viaCall")}</span>;
}
