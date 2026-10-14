import type { ReactNode } from "react";

import type { Message } from "@/state/store";
import { BugReportCard } from "./BugReportCard";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SignInRequestCard } from "./SignInRequestCard";

/** A card in which a bot asks the person for something only they can do, or null for any other row. */
export function askCardRow(m: Message, { botId, botName, threadId }: { botId: string; botName: string; threadId: string }): ReactNode {
  if (m.kind === "secret" && m.secret) return <SecretRequestCard botId={botId} threadId={threadId} message={m} />;
  if (m.kind === "signin" && m.signIn) return <SignInRequestCard botId={botId} botName={botName} threadId={threadId} message={m} />;
  if (m.kind === "connector" && m.connector) return <ConnectorCard botId={botId} threadId={threadId} message={m} />;
  if (m.kind === "bugreport" && m.bugReport) return <BugReportCard botId={botId} botName={botName} threadId={threadId} message={m} />;
  return null;
}
