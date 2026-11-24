import { MAIN_PANE, type PaneLayout } from "./pane-layout";
import { createContext } from "react";

export const WorkspaceChatContext = createContext<string | null>(null);
export const FocusedWorkspaceThread = createContext<string | null>(null);

export const WorkspaceLayoutContext = createContext<PaneLayout>(MAIN_PANE);
