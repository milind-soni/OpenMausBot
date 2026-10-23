// The agents catalog's tools for the threads a bot opened: listing them, closing them, and a Chief of Staff's mute.
export const MUTED_THREAD_STILL_NOTIFIES =
  "of everything waiting on them: approvals, questions, sign-ins and a turn that ended needing their input; of a problem no Chief received; of spend; of anything new on their brief; and once of a failure, unless you took its incident report";

export const THREAD_TOOL_DEFINITIONS = [
  {
    name: "list_threads",
    description:
      "See your own threads and the threads you opened on teammates, newest first: each with its bot, title, state (running, waiting on the person, queued, idle, or closed), whether the person has unread there, and the delegation id if it was a handoff. Use it to check how the threads you started are going before reporting to the person; write a thread's title as #Title when you mention it. A Chief of Staff also sees threads teammates opened on each other. This is a read: it starts nothing and changes nothing.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "close_thread",
    description:
      "Mark a thread you opened (or one of your own) as finished once you have read its result: it leaves the person's default sidebar list (still under all threads, with a note saying you closed it) and list_threads reports it as closed. Nothing is deleted — deleting stays the person's decision — and a thread that is still running cannot be closed; wait for it or leave it. Use the thread id from list_threads or from the start_thread result. If a close is refused, do not retry it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { thread_id: { type: "string", description: "The thread id from list_threads or start_thread." } },
      required: ["thread_id"],
    },
  },
  {
    name: "mute_thread",
    description:
      `Chief of Staff only: mute or unmute the person's phone and desktop notifications for one thread a bot opened — yours, or one opened in your reachable team (list_threads shows which are muted). A muted thread still notifies the person ${MUTED_THREAD_STILL_NOTIFIES}. Its other notices stop; its messages and unread state are unchanged. A thread the person started, each bot's main chat, and any mute or unmute the person chose are the person's to change. Use it when the person asks for quieter threads; if it is refused, do not retry it.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        thread_id: { type: "string", description: "The thread id from list_threads." },
        muted: { type: "boolean", description: "true mutes the thread; false lets it notify again." },
      },
      required: ["thread_id", "muted"],
    },
  },
];
