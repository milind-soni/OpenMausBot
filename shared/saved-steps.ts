/** Set on the reply of a request whose computer steps were saved (`learned`) or that was answered from saved steps
 * with no AI (`replayed`), as `WireMessage.savedSteps`. Clients that do not know it ignore it. */
export interface SavedStepsMark { recipeId: string; learned?: true; replayed?: true }
