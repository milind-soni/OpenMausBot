# Agent notifications and proactivity QA

OpenMausBot treats **proactivity as an explicit trigger**, not as a hidden
heartbeat. A bot may continue within an active task through Auto mode, may be
started by a Routine or Webhook, and may coordinate peers when its engine and
profile allow that. This change does not add background polling that invents
work or sends messages without one of those configured paths.

## Notification policy

The harness is the single owner of interruption policy. A bot with
notifications disabled remains quiet. Otherwise it may emit:

- **Needs approval** or **has a question** when the task is blocked on the user.
- **Needs your hands** when a computer task requires a takeover.
- **Finished** only when there is a non-empty result to summarize.
- **Routine failed** when a scheduled or manual routine run cannot complete.

Every notification carries both the bot ID and the exact task thread ID. A
click must select that bot **and switch to that task**, including a routine's
detached task; opening whichever task happens to be active is a failure.
Opening a conversation reads its notifications in the feed, a pending question
or approval included, and every open app's badge drops them at once.

Desktop notifications are suppressed while the window already has focus. The
iOS app can present live or replayed notifications while it is running and uses
the same bot/task target when the notification is tapped. Waking a terminated
iOS app still requires a future APNs relay; local network or VPN connectivity
alone cannot provide closed-app delivery.

### Muted threads

One bot conversation thread can be muted from its row menu (**Mute
notifications**), with `PATCH /api/bots/:botId/tasks/:threadId` and
`{"notificationsMuted": true}` (`false` unmutes, `null` returns the thread to
the default), or by a Chief of Staff with the `mute_thread` tool. The bot's
other threads keep notifying, and the per-bot switch still wins: a bot with
notifications off stays quiet in an unmuted thread. Room threads have no mute;
a room's mentions notify as before.

A muted thread's messages, unread state and sidebar waits are unchanged; what
reaches the person's devices follows one table, `THREAD_MUTE_POLICY` in
`server/thread-mute.ts`:

| Notification | Muted, bot has a Chief of Staff | Muted, no Chief of Staff |
|---|---|---|
| Finished, resumed with results, mention, routine waiting | silent | silent |
| Waiting on a tool approval, a question or a sign-in | notifies | notifies |
| A turn that ended on `NEEDS INPUT:` in work the person asked for | notifies once, as a question, whatever `features.chiefEscalations` says | notifies once, as a question |
| The same in work a teammate assigned | silent when the runtime woke the assigner with the question in its still-live thread; notifies once, as a question, when the assignment wanted no reply or the assigner's thread is gone | the same |
| **Couldn't start**, **routine failed** | silent once the Chief took the report (its turn started or queued); otherwise notifies once | notifies |
| Incident or escalation no Chief received (none in reach, or its turn could not start) | notifies | notifies |
| Peer approval (a bot asks before contacting a teammate) | notifies | notifies |
| Spend alert (account-level, not tied to the thread) | notifies | notifies |
| The brief has something new for the person (sent in the main agent's chat) | notifies | notifies |

Nothing that waits on the person disappears: every gate only they can lift
notifies, Chief or not, since a Chief's own threads may be muted too. A turn
that ends needing input tells the person directly; with escalations on, the
Chief's copy counts as already told, so the person hears once. In work a
teammate assigned, the question goes to the assigner instead, and the person
hears of it once only when no assigner was woken: the assignment wanted no
reply, or the assigner's thread is gone. A failure is left to the Chief only
once it accepted that report; when there is no Chief, it refuses the report
turn, the report is rate-limited, or it folds into work a teammate assigned,
the person hears of it once. The menu item's help line, shown under it, says the
same, and a muted thread's row carries a muted bell beside its title.

Nothing is muted until someone chooses it. With `features.muteBotOpenedThreads`
set to `true` in `config.json`, threads a bot opened (a teammate's handoff
thread, a bot's own `start_thread`) start muted; threads the person started and
each bot's main chat do not. A thread's own choice overrides that default, and
the thread records who made it (`notificationsMutedBy`: `person` or `chief`).

`mute_thread` is Chief-only. It mutes or unmutes a thread a bot opened, either
on the Chief itself or opened by a bot the Chief can reach, and only one the
Chief's `list_threads` would show. A thread the person started, each bot's main
chat, and any mute or unmute the person chose can be changed only by the
person; the person can always change the Chief's. A move to My Cloud carries
the choice and who made it.

## Automated coverage

| Contract | Test |
|---|---|
| Per-agent off means quiet; empty completions stay quiet; summaries are bounded | `server/notify.test.ts` |
| Every notification kind, muted; a failure reaches the person once unless the Chief took its report (refused, no Chief, assigned work, rate limit); a turn ending on `NEEDS INPUT:` tells the person once with escalations off or on, Chief or not; the brief still notifies from a muted main chat; the opt-in default never mutes the person's threads or a main chat; mute persists; `mute_thread` refuses hidden threads and the person's choice | `server/thread-mute.test.ts` |
| Muted threads stay quiet while the main chat notifies; a muted thread still asks for a tool approval, an answer and a sign-in, Chief or not, and tells the person once that a turn ended needing them; assigned work that ends needing input stays quiet while its assigner is woken and tells the person once when the assignment wanted no reply or the assigner is gone; the per-bot switch wins; the HTTP API and `mute_thread` refuse what they must; the person's choice outranks the Chief's | `server/thread-mute.e2e.test.ts` |
| A peer approval in a muted thread still notifies the person while its Chief receives the escalation | `server/escalations.e2e.test.ts` |
| A move to My Cloud keeps the mute and who chose it | `server/cloud-send-settings.test.ts`, `server/cloud-chat-merge.test.ts` |
| The row menu mutes, unmutes, rolls back a refused change and shows the refreshed state; the muted bell and the menu's help line show without hover | `src/components/Sidebar.thread-mute.test.ts` |
| Browser click returns the exact bot/task target | `src/lib/notify.test.ts` |
| Store navigation selects the bot and switches the task | `src/state/store.test.ts` |
| Opening a conversation reads only its own feed entries, live in every open app | `server/notification-read.e2e.test.ts` |
| Routine failure receipt and callback occur once | `server/routines.test.ts` |
| Real failed routine emits one `routine-failed` notification and no duplicate `done` | `server/notification-wiring.test.ts` |
| iOS target parsing and detached-task decision | `ios/Tests/CompanionCoreTests/DecodingTests.swift` |
| Paired-device route policy remains default-deny | `companion/test/routes.test.ts` |

## Manual release pass

Run these with two bots, notifications enabled on one and disabled on the
other:

1. Background the desktop window. Complete a normal task and confirm one
   result notification. Click it and verify the exact task opens.
2. Trigger an approval and a question. Confirm their copy, click targets, and
   that no duplicate completion notification appears before the task settles.
3. Run a routine manually, then create a controlled failing run. Confirm the
   receipt shows the detached task and the failure generates exactly one alert.
4. Repeat the above with notifications disabled for that bot; the chat and run
   receipt should update without a system alert.
5. On iOS, tap a live/replayed notification for a non-active routine task.
   Confirm the app switches the server-side active task before navigating.
6. Exercise Auto mode, a Routine, and a Webhook independently. Verify each has
   a visible initiating user/configured trigger and that no unconfigured
   heartbeat starts work.

Live provider, OS-permission, backgrounding, and APNs behavior cannot be proven
by unit tests alone and remains part of the signed desktop/iPhone release pass.
