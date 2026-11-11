"use client";
import { createContext, useContext } from "react";
import type { Id } from "@/convex/_generated/dataModel";

export type IssueNavigation = {
  /** Opens the issue's full page (its own URL; Back returns). */
  openIssue: (projectId: Id<"projects">, taskId: Id<"tasks">) => void;
  /** The issue last opened from this project's list, to focus again when coming back to it (read once). */
  takeReturnFocus: (projectId: Id<"projects">) => Id<"tasks"> | null;
};

export const IssueNavigationContext = createContext<IssueNavigation | null>(null);
export const useIssueNavigation = () => useContext(IssueNavigationContext);

/** The issue in focus for single-key actions and the command menu: a focused row or card, else the open issue page. */
export function focusedIssue(): { projectId: Id<"projects">; taskId: Id<"tasks"> } | null {
  const card = document.activeElement?.closest<HTMLElement>("[data-task-id]");
  const scope = card?.closest<HTMLElement>("[data-issue-project]");
  if (card?.dataset.taskId && scope?.dataset.issueProject) return { projectId: scope.dataset.issueProject as Id<"projects">, taskId: card.dataset.taskId as Id<"tasks"> };
  const page = document.querySelector<HTMLElement>("[data-issue-page]");
  if (page?.dataset.taskId && page.dataset.projectId) return { projectId: page.dataset.projectId as Id<"projects">, taskId: page.dataset.taskId as Id<"tasks"> };
  return null;
}
