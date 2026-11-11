"use client";

import { ContentSkeleton } from "./content-skeleton";
import { DelayedSkeleton } from "./delayed-skeleton";
import { lazyComponent } from "./lazy-component";

/*
 * Views and dialogs that the board does not need on first paint, split out of the workspace chunk. They are fetched
 * in the background once the workspace has settled (see preloadViews), so opening one later renders at once; before
 * that, views show their usual loading skeleton and dialogs open when their code has arrived.
 */
export const TaskModal = lazyComponent(() => import("./issue-detail").then(module => module.TaskModal), null, { dialog: true });
export const IssueComposer = lazyComponent(() => import("./issue-composer").then(module => module.IssueComposer), null, { dialog: true });
export const ChatView = lazyComponent(() => import("./chat-shell").then(module => module.ChatView), <ContentSkeleton kind="chat" label="Loading chat" />);
export const InboxView = lazyComponent(() => import("./inbox-view").then(module => module.InboxView), <ContentSkeleton label="Loading inbox" />);
export const WorkspaceSettings = lazyComponent(() => import("./workspace-settings").then(module => module.WorkspaceSettings), null, { dialog: true });
export const MemberProfile = lazyComponent(() => import("./member-profile").then(module => module.MemberProfile), null, { dialog: true });
export const CreateWorkspaceDialog = lazyComponent(() => import("./create-workspace-dialog").then(module => module.CreateWorkspaceDialog), null, { dialog: true });
export const AssetsPanel = lazyComponent(() => import("./project-library").then(module => module.AssetsPanel), <DelayedSkeleton label="Loading assets" />);
export const VaultPanel = lazyComponent(() => import("./project-library").then(module => module.VaultPanel), <DelayedSkeleton label="Loading vault" />);
export const FeedbackView = lazyComponent(() => import("./feedback-view").then(module => module.FeedbackView), <DelayedSkeleton label="Loading feedback" />);
export const VoiceChatView = lazyComponent(() => import("./call-view").then(module => module.VoiceChatView));
export const ProjectMembers = lazyComponent(() => import("./project-members").then(module => module.ProjectMembers));
export const IssueRouteView = lazyComponent(() => import("./issue-route-view").then(module => module.IssueRouteView), <ContentSkeleton label="Opening issue" />);
export const CommandMenu = lazyComponent(() => import("./command-menu").then(module => module.CommandMenu));
export const ShortcutsDialog = lazyComponent(() => import("./command-menu").then(module => module.ShortcutsDialog));

// Most used first: an issue, a new issue, then the other views.
const preloads: Array<() => Promise<unknown>> = [IssueRouteView, TaskModal, IssueComposer, CommandMenu, InboxView, ChatView, AssetsPanel, VaultPanel, FeedbackView, ProjectMembers, VoiceChatView, WorkspaceSettings, MemberProfile, CreateWorkspaceDialog, ShortcutsDialog].map(view => view.preload);

let scheduled = false;
/** Fetches every deferred view in the background, one after another, once the page is idle. */
export function preloadViews() {
  if (scheduled || typeof window === "undefined") return;
  scheduled = true;
  const idle = (run: () => void) => typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(run, { timeout: 2000 }) : window.setTimeout(run, 100);
  window.setTimeout(() => idle(async () => {
    for (const preload of preloads) await preload().catch(() => undefined);
  }), 300);
}
