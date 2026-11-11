import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("expire project presence", { minutes: 5 }, internal.projectPresence.cleanup, {});
crons.interval("expire storage upload intents", { minutes: 5 }, internal.storage.expireUploads, {});
crons.interval("sync GitHub issues and task PRs", { minutes: 2 }, internal.integrations.kick, {});
// State that used to live in the frontend's local store: expire it here so no frontend instance has to.
crons.interval("expire call presence and signals", { minutes: 1 }, internal.workspaceCalls.prune, {});
crons.interval("maintain MCP OAuth grants", { minutes: 1 }, internal.mcpOAuth.maintain, {});
crons.interval("expire rate limits, leases and GitHub OAuth states", { minutes: 10 }, internal.serverStore.sweep, {});
// The signed integration tick reconciles bounded pages of draft/open/closed PRs too.
crons.interval("expire GitHub deliveries", { hours: 24 }, internal.taskPRs.cleanup, {});
crons.interval("backfill PR repository index", { minutes: 2 }, internal.taskPRs.backfillRepositories, {});
crons.interval("resume interrupted workspace deletions", { minutes: 15 }, internal.workspaceDeletion.resume, {});
crons.daily("expire deleted-workspace notices", { hourUTC: 3, minuteUTC: 30 }, internal.workspaceDeletion.expireNotices, {});
export default crons;
