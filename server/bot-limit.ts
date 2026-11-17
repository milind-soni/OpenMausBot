/** What a workspace at its bot limit answers: the limit, and what the person can do about it. */
export const botLimitRefusal = (max: number): string =>
  `This workspace already has ${max} bots, the most one workspace holds (bots in the archive count too). ` +
  "To add another, delete a bot you no longer need, or create the new bots in another workspace.";
