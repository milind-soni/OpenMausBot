"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ChatTrigger } from "@/lib/chat-composer";
import type { ChatReference } from "@/lib/chat-types";
import { taskKey } from "@/lib/project-issues";
import type { ChatMember } from "./chat-shell";
import { memberName } from "./user-avatar";

/**
 * `label` is the main line of the list (a person's full name); `insert` is what the composer types (the handle).
 * Issues carry their `status` (lane title, "Draft" for the draft lane) for the same StatusIcon as the Link picker.
 */
export type ChatSuggestion = { key: string; label: string; insert: string; detail: string; member?: ChatMember; reference?: ChatReference; status?: string };

export function useChatSuggestions(trigger: ChatTrigger | null, members: ChatMember[] | undefined, sessionToken: string, teamId: Id<"teams">) {
  const referencing = trigger?.kind === "reference";
  const query = trigger?.query.toLowerCase() || "";
  const projects = useQuery(api.projects.listForUser, referencing ? { sessionToken, teamId } : "skip");
  // The latest open issues (matched here on title, project and key) plus a title search over all of them.
  const recent = useQuery(api.workspaceSearch.issues, referencing ? { sessionToken, teamId, text: "", done: false } : "skip");
  const found = useQuery(api.workspaceSearch.issues, referencing && query.trim() ? { sessionToken, teamId, text: query, done: false } : "skip");
  let options: ChatSuggestion[] = [];
  if (trigger?.kind === "member") {
    options = (members || []).filter(m => m.userId && `${m.name} ${m.username || ""} ${m.email}`.toLowerCase().includes(query)).slice(0, 8).map(member => {
      const handle = member.username || member.email.split("@")[0] || memberName(member);
      return { key: member.userId!, label: memberName(member), insert: handle, detail: `@${handle}`, member };
    });
  } else if (referencing) {
    const projectMatches: ChatSuggestion[] = (projects || []).filter(p => p.name.toLowerCase().includes(query)).slice(0, 5).map(p => ({ key: p._id, label: p.name, insert: p.name, detail: "Project", reference: { type: "project", id: p._id, projectId: p._id, label: p.name } }));
    const projectName = new Map<string, string>((projects || []).filter(p => p.status === "active").map(p => [p._id, p.name]));
    const seen = new Set<string>();
    const issues = [...(found || []), ...(recent || []).filter(t => `${t.title} ${projectName.get(t.projectId) ?? ""} ${taskKey(t._id)}`.toLowerCase().includes(query))]
      .filter(t => projectName.has(t.projectId) && !seen.has(t._id) && Boolean(seen.add(t._id)));
    const issueMatches: ChatSuggestion[] = issues.slice(0, 8 - projectMatches.length).map(t => ({ key: t._id, label: t.title, insert: t.title, detail: `${projectName.get(t.projectId)} · ${taskKey(t._id)}`, status: t.status ?? "", reference: { type: "issue", id: t._id, projectId: t.projectId, label: t.title } }));
    options = [...projectMatches, ...issueMatches];
  }
  return { options, loading: trigger?.kind === "member" ? members === undefined : referencing && (projects === undefined || recent === undefined || (Boolean(query.trim()) && found === undefined)) };
}
