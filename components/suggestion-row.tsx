"use client";

import { Hash } from "lucide-react";
import { StatusIcon } from "./issue-icons";
import { UserAvatar, type AvatarIdentity } from "./user-avatar";
import type { ChatSuggestion } from "./use-chat-suggestions";

/**
 * One @ / # suggestion, the same in chat and in issue comments: a person's avatar, a project's #, or an issue's status
 * ring (as in the Link issue picker), then the name and its detail line.
 */
export function SuggestionRow({ option, avatar }: { option: ChatSuggestion; avatar?: AvatarIdentity }) {
  return <>
    {option.member ? <UserAvatar user={avatar ?? option.member} size="small" /> : option.reference?.type === "issue" ? <StatusIcon title={option.status ?? ""} /> : <Hash size={16} />}
    <span className="suggestion-copy"><strong>{option.label}</strong><small>{option.detail}</small></span>
  </>;
}
