// New conversation makes one conversation per action (store.tsx): a click while one is being made for the same folder
// answers with that one's outcome, and a click for another folder waits for it, then runs.
type NewTask = { botId: string; projectId?: string; cwd?: string; onCreated?: () => void; onError?: (message: string) => void };

export function createNewTaskOnce() {
  const conversationsBeingMade = new Map<string, { projectId?: string; cwd?: string; outcome: Promise<string | null> }>();
  /** `settle`, for the caller to call with the failure (null once the conversation is made), or null when this click was
   * answered by the one being made, or will run again (`again`) once it is. */
  return (action: NewTask, again: () => void): ((failure: string | null) => void) | null => {
    const making = conversationsBeingMade.get(action.botId);
    if (making && making.projectId === action.projectId && making.cwd === action.cwd) {
      void making.outcome.then((failure) => failure === null ? action.onCreated?.() : action.onError?.(failure));
      return null;
    }
    if (making) {
      void making.outcome.then(() => again());
      return null;
    }
    let settle: (failure: string | null) => void = () => {};
    const outcome = new Promise<string | null>((resolve) => {
      settle = (failure) => { conversationsBeingMade.delete(action.botId); resolve(failure); };
    });
    conversationsBeingMade.set(action.botId, { projectId: action.projectId, cwd: action.cwd, outcome });
    return settle;
  };
}
