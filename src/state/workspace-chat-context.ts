import { createContext } from "react";

export const WorkspaceChatContext = createContext<string | null>(null);
export const FocusedWorkspaceThread = createContext<string | null>(null);
