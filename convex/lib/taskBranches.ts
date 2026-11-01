import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { taskBranch } from "../../lib/task-branch";
import { hashToken } from "./auth";

export async function reserveTaskBranch(ctx: MutationCtx, task: Doc<"tasks">, requested?: string) {
  if (task.githubTaskBranch) { if (requested && requested !== task.githubTaskBranch) throw new ConvexError("This issue's branch is already in use"); return task.githubTaskBranch; }
  const linked = await ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", task._id)).first();
  if (requested && linked && requested !== linked.branch) throw new ConvexError("This issue already has a pull request on another branch");
  let branch = requested ?? linked?.branch ?? taskBranch(task);
  const collision = await ctx.db.query("tasks").withIndex("by_githubTaskBranch", q => q.eq("githubTaskBranch", branch)).first();
  if (collision && collision._id !== task._id) {
    if (requested) throw new ConvexError("This issue's branch is already in use");
    branch = `${branch}-${(await hashToken(task._id)).slice(0, 12)}`;
    const second = await ctx.db.query("tasks").withIndex("by_githubTaskBranch", q => q.eq("githubTaskBranch", branch)).first();
    if (second && second._id !== task._id) throw new ConvexError("Another issue uses this branch name. Rename the issue.");
  }
  await ctx.db.patch(task._id, { githubTaskBranch: branch });
  return branch;
}
