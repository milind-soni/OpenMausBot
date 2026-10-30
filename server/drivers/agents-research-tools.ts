// The agents catalog's X and research tools (through treg) and the internal route behind each. Every call is paid, from
// the person's own treg balance or their Cloud plan's allowance, so a bot is shown these tools only when a treg key or a
// plan credential is held and its research switch is on; each route checks both again before it spends.
import { agentsCallMember } from "../../shared/agents-tool-names.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

/** Each call's route, by the member name it goes by (x_search's actions are its members). */
const RESEARCH_ROUTES: Readonly<Record<string, string>> = {
  x_search: "x/search", x_user_posts: "x/user-posts", x_post: "x/post", x_profile: "x/profile",
  research_search: "research/search", research_endpoint: "research/endpoint", research_call: "research/call",
};
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["x_search", "research_search", "research_endpoint", "research_call"]);

/** What each X read cannot go without, said before anything is spent. */
const X_NEEDS: Readonly<Record<string, string>> = { x_search: "query", x_user_posts: "handle", x_post: "post", x_profile: "handle" };
const X_ACTIONS = new Set(["search", "user_posts", "post", "profile"]);

export async function callResearchTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const member = agentsCallMember(name, args);
  const { action, ...rest } = args;
  const input = name === "x_search" ? rest : args;
  if (name === "x_search") {
    if (action !== undefined && action !== null && !X_ACTIONS.has(String(action))) return { text: "x_search action is search (the default), user_posts, post or profile.", isError: true };
    const needed = X_NEEDS[member]!;
    const value = input[needed];
    if (typeof value !== "string" || !value.trim()) return { text: `x_search ${member === "x_search" ? "search" : String(action)} needs ${needed}.`, isError: true };
  }
  const { ok, body } = await context.client.apiResponse(`/api/internal/${RESEARCH_ROUTES[member]}`, { method: "POST", body: JSON.stringify(input) });
  return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "Research failed. Try again shortly."), isError: true };
}

export const RESEARCH_TOOL_DEFINITIONS = [
  {
    name: "x_search",
    description:
      "Read X (Twitter) without an X account (was also x_user_posts / x_post / x_profile). Every call is paid (the user's treg balance or Cloud plan) and read-only: you cannot post, like or reply. search (the default) finds posts; write one well-filtered query instead of many broad ones. The query takes X operators: from:handle, to:handle, \"exact phrase\", since:YYYY-MM-DD, until:YYYY-MM-DD, min_faves:N, -filter:replies, lang:en, OR. Bare words are all required, so use a short phrase or OR between alternatives. user_posts reads an account's recent posts, newest first. Both return compact posts (link, author, time, text, likes, reposts, replies, quotes, views) and newestId: to monitor X, for example in a routine, keep newestId and pass it back as sinceId next time to get only newer posts. post reads one post, and with replies the first page of up to 20 replies to it. profile looks up an account: name, bio, followers, following, post count and verified status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["search", "user_posts", "post", "profile"], description: "search (default), user_posts, post or profile." },
        query: { type: "string", minLength: 1, maxLength: 512, description: "search: the X search query; operators allowed." },
        sort: { type: "string", enum: ["latest", "top"], description: "search: latest (default) or top." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "search and user_posts: how many posts, 1-50. Default 20." },
        sinceId: { type: "string", pattern: "^\\d{1,25}$", description: "search and user_posts: only posts newer than this post id, a newestId from an earlier call." },
        handle: { type: "string", minLength: 1, description: "user_posts and profile: the account: @handle, handle, or an x.com profile link." },
        includeReplies: { type: "boolean", description: "user_posts: include the account's replies to others. Default false." },
        post: { type: "string", minLength: 1, description: "post: an x.com or twitter.com post link, or the post id." },
        replies: { type: "boolean", description: "post: also return replies to the post. Default false." },
      },
    },
  },
  {
    name: "research_search",
    description:
      "Find a research endpoint for a job in treg's catalog: companies, people and work emails, funding, news, social and trend data, SEO, search results, scraping, generation and more. Describe the job, not a vendor. Returns endpoints with their params, an example and the estimated cost; then call one with research_call. Searching is free.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: { type: "string", minLength: 1, maxLength: 300, description: "What the research is for, such as \"work email of a person at a company\"." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "How many endpoints, 1-10. Default 5." },
      },
      required: ["job"],
    },
  },
  {
    name: "research_endpoint",
    description: "Read one research endpoint in full: its params, an example, its cost and how to check on an async task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", minLength: 1, maxLength: 200, description: "An endpoint id from research_search." } },
      required: ["id"],
    },
  },
  {
    name: "research_call",
    description:
      "Call a research endpoint by id and get the provider's answer and what it cost (a paid call). params are its query parameters for a GET endpoint, otherwise its JSON body; query adds a query string to a body endpoint. Follow the endpoint's params and example. An async task answers with how to check on it: call that with research_call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200, description: "The endpoint id." },
        params: { type: "object", additionalProperties: true, description: "The endpoint's parameters." },
        query: { type: "object", additionalProperties: true, description: "Query string for an endpoint that takes a JSON body." },
      },
      required: ["id"],
    },
  },
];
