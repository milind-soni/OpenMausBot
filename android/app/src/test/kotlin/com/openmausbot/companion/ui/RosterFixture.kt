package com.openmausbot.companion.ui

import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Fleet

/**
 * A synthetic fleet with every state the home list draws — the counterpart of
 * the iPhone companion's roster preview fleet, decoded through the same
 * serializer a real fleet takes.
 *
 * An unsectioned Chief of Staff with one thread, a pinned unread bot, a bot
 * with three threads (a folder, a pinned unfiled thread with a queued send,
 * and a hidden routine run), one waiting on you, one working, a long name with
 * a long role, a two-word name for large-text wrapping, groups (one busy, one
 * waiting on an unanswered card), a bot-to-bot chat, and named sections with
 * their own Chief. It is long enough to scroll on a phone. The one pending
 * card sits in a group, so every bot's waiting mark comes from its threads.
 *
 * Times are relative to [fleet]'s `now`, so the list reads like a real day
 * whenever it runs; nothing asserts on the stamps themselves.
 */
internal object RosterFixture {
    const val CHIEF = "roster-atlas"
    const val PINNED = "roster-pixel"
    const val THREE_THREADS = "roster-pepper"
    const val WAITING = "roster-scout"
    const val TWO_THREADS = "roster-quill"
    const val LONG_NAME = "roster-maximilian"
    const val TWO_WORDS = "roster-bo"
    const val SECTION_CHIEF = "roster-juno"
    const val WORKING = "roster-forge"
    const val GROUP = "roster-general"
    /** Waits on an unanswered card. */
    const val WAITING_GROUP = "roster-design-crit"
    /** A section's group, mid-turn. */
    const val SECTION_GROUP = "roster-release-room"
    const val BOT_CHAT = "roster-scout-forge"

    /** The last row of the unsearched list: Growth's last bot. */
    const val LAST_ROW = "roster-sage"

    const val LONG_NAME_TEXT = "Maximilian Vandermeer-Oppenheimer"
    const val LONG_ROLE_TEXT = "Long-term records retention and archival compliance"
    const val TWO_WORDS_TEXT = "Bo Christoffersen"

    val PEPPER_THREADS = listOf("roster-pepper-gmail", "roster-pepper-icloud", "roster-pepper-weekend")

    private const val MINUTE = 60_000L
    private const val HOUR = 60 * MINUTE
    private const val DAY = 24 * HOUR

    fun fleet(now: Long = System.currentTimeMillis()): Fleet =
        CompanionJson.decodeFromString(Fleet.serializer(), json(now))

    private fun json(now: Long): String {
        fun ago(millis: Long): Long = now - millis
        val created = ago(40 * DAY)
        val model = """"modelSelection": {"instanceId": "fixture", "model": "fixture"}"""
        return """
        {
          "bots": [
            {
              "id": "roster-atlas", "threadId": "roster-atlas-plan", "name": "Atlas",
              "title": "Operations lead", "description": "", "notifications": true, "color": "teal",
              "unread": false, $model, "createdAt": $created, "chiefOfStaff": true,
              "tasks": [
                {"threadId": "roster-atlas-plan", "title": "Weekly plan", "createdAt": $created, "updatedAt": ${ago(3 * HOUR)}, $model}
              ],
              "messages": [
                {"id": "atlas-1", "role": "user", "kind": "text", "at": ${ago(3 * HOUR + 5 * MINUTE)}, "text": "What does the team need from me this week?"},
                {"id": "atlas-2", "role": "bot", "kind": "text", "at": ${ago(3 * HOUR)}, "text": "Three reviews and one approval. I put them in order."}
              ]
            },
            {
              "id": "roster-pixel", "threadId": "roster-pixel-shots", "name": "Pixel",
              "title": "Designer", "description": "", "notifications": true, "color": "pink",
              "unread": true, $model, "createdAt": $created, "pinned": true,
              "tasks": [
                {"threadId": "roster-pixel-shots", "title": "Store screenshots", "createdAt": ${ago(9 * DAY)}, "updatedAt": ${ago(40 * MINUTE)}, $model, "unread": true}
              ],
              "messages": [
                {"id": "pixel-1", "role": "user", "kind": "text", "at": ${ago(90 * MINUTE)}, "text": "Prepare the store screenshots."},
                {"id": "pixel-2", "role": "bot", "kind": "text", "at": ${ago(40 * MINUTE)}, "text": "The new screenshots are ready for review."}
              ]
            },
            {
              "id": "roster-pepper", "threadId": "roster-pepper-gmail", "name": "Pepper",
              "title": "Personal assistant", "description": "", "notifications": true, "color": "purple",
              "unread": true, $model, "createdAt": $created, "busy": true,
              "projects": [{"id": "email", "name": "Email", "emoji": "✉️"}],
              "tasks": [
                {"threadId": "roster-pepper-gmail", "title": "Triage Gmail", "createdAt": ${ago(3 * DAY)}, "updatedAt": ${ago(5 * MINUTE)}, $model, "projectId": "email", "busy": true, "activity": "working", "unread": false},
                {"threadId": "roster-pepper-icloud", "title": "Triage iCloud", "createdAt": ${ago(3 * DAY)}, "updatedAt": ${ago(HOUR)}, $model, "projectId": "email", "busy": false, "activity": "idle", "unread": true},
                {"threadId": "roster-pepper-weekend", "title": "Plan weekend", "createdAt": ${ago(4 * DAY)}, "updatedAt": ${ago(DAY + 2 * HOUR)}, $model, "busy": false, "activity": "queued", "unread": false, "pinned": true},
                {"threadId": "roster-pepper-routine", "title": "Internal routine execution", "createdAt": ${ago(4 * DAY)}, "updatedAt": ${ago(4 * DAY)}, $model, "projectId": "email", "routineRunId": "roster-routine-run"}
              ],
              "messages": [
                {"id": "pepper-1", "role": "user", "kind": "text", "at": ${ago(8 * MINUTE)}, "text": "Triage Gmail and flag anything urgent."},
                {"id": "pepper-2", "role": "bot", "kind": "text", "at": ${ago(5 * MINUTE)}, "text": "Working through 42 unread messages now."}
              ]
            },
            {
              "id": "roster-scout", "threadId": "roster-scout-checklist", "name": "Scout",
              "title": "Researcher", "description": "", "notifications": true, "color": "cyan",
              "unread": false, $model, "createdAt": $created, "busy": true,
              "tasks": [
                {"threadId": "roster-scout-checklist", "title": "Release checklist", "createdAt": ${ago(2 * DAY)}, "updatedAt": ${ago(10 * MINUTE)}, $model, "busy": true, "activity": "waiting-on-you", "unread": false}
              ],
              "messages": [
                {"id": "scout-1", "role": "user", "kind": "text", "at": ${ago(15 * MINUTE)}, "text": "Compare the release checklist with the store requirements."},
                {"id": "scout-2", "role": "bot", "kind": "text", "at": ${ago(10 * MINUTE)}, "text": "One step needs your answer before I continue."}
              ]
            },
            {
              "id": "roster-quill", "threadId": "roster-quill-blog", "name": "Quill",
              "title": "Writer", "description": "", "notifications": true, "color": "orange",
              "unread": false, $model, "createdAt": $created,
              "tasks": [
                {"threadId": "roster-quill-blog", "title": "Launch blog post", "createdAt": ${ago(2 * DAY)}, "updatedAt": ${ago(DAY + 3 * HOUR)}, $model},
                {"threadId": "roster-quill-notes", "title": "Release notes", "createdAt": ${ago(7 * DAY)}, "updatedAt": ${ago(2 * DAY)}, $model}
              ],
              "messages": [
                {"id": "quill-1", "role": "user", "kind": "text", "at": ${ago(DAY + 4 * HOUR)}, "text": "Draft the launch blog post."},
                {"id": "quill-2", "role": "bot", "kind": "text", "at": ${ago(DAY + 3 * HOUR)}, "text": "The first draft is in the shared folder."}
              ]
            },
            {
              "id": "roster-maximilian", "threadId": "roster-maximilian-audit", "name": "Maximilian Vandermeer-Oppenheimer",
              "title": "$LONG_ROLE_TEXT", "description": "", "notifications": true, "color": "yellow",
              "unread": false, $model, "createdAt": $created,
              "tasks": [
                {"threadId": "roster-maximilian-audit", "title": "Archive audit", "createdAt": ${ago(10 * DAY)}, "updatedAt": ${ago(8 * DAY)}, $model}
              ],
              "messages": [
                {"id": "max-1", "role": "bot", "kind": "text", "at": ${ago(8 * DAY)}, "text": "The archive audit is complete."}
              ]
            },
            {
              "id": "roster-bo", "threadId": "roster-bo-renewals", "name": "$TWO_WORDS_TEXT",
              "title": "Account manager", "description": "", "notifications": true, "color": "green",
              "unread": false, $model, "createdAt": $created,
              "tasks": [
                {"threadId": "roster-bo-renewals", "title": "Renewal reminders", "createdAt": ${ago(9 * DAY)}, "updatedAt": ${ago(9 * DAY)}, $model}
              ],
              "messages": [
                {"id": "bo-1", "role": "bot", "kind": "text", "at": ${ago(9 * DAY)}, "text": "Renewal reminders are scheduled."}
              ]
            },
            {
              "id": "roster-juno", "threadId": "roster-juno-sprint", "name": "Juno",
              "title": "Engineering lead", "description": "", "notifications": true, "color": "blue",
              "unread": false, $model, "createdAt": $created, "chiefOfStaff": true, "section": "Engineering",
              "tasks": [
                {"threadId": "roster-juno-sprint", "title": "Sprint review", "createdAt": ${ago(3 * DAY)}, "updatedAt": ${ago(3 * DAY)}, $model}
              ],
              "messages": [
                {"id": "juno-1", "role": "bot", "kind": "text", "at": ${ago(3 * DAY)}, "text": "Sprint review notes are ready."}
              ]
            },
            {
              "id": "roster-forge", "threadId": "roster-forge-release", "name": "Forge",
              "title": "Engineer", "description": "", "notifications": true, "color": "red",
              "unread": false, $model, "createdAt": $created, "busy": true, "section": "Engineering",
              "tasks": [
                {"threadId": "roster-forge-release", "title": "Release build", "createdAt": ${ago(2 * DAY)}, "updatedAt": ${ago(10 * MINUTE)}, $model, "busy": true, "activity": "working"}
              ],
              "messages": [
                {"id": "forge-1", "role": "user", "kind": "text", "at": ${ago(15 * MINUTE)}, "text": "Run the complete release verification."},
                {"id": "forge-2", "role": "bot", "kind": "text", "at": ${ago(10 * MINUTE)}, "text": "Building the signed bundle and checking the privacy manifest."}
              ]
            },
            {
              "id": "roster-echo", "threadId": "roster-echo-regressions", "name": "Echo",
              "title": "QA reviewer", "description": "", "notifications": true, "color": "green",
              "unread": false, $model, "createdAt": $created, "section": "Engineering",
              "tasks": [
                {"threadId": "roster-echo-regressions", "title": "Regression pass", "createdAt": ${ago(4 * DAY)}, "updatedAt": ${ago(4 * DAY)}, $model}
              ],
              "messages": [
                {"id": "echo-1", "role": "bot", "kind": "text", "at": ${ago(4 * DAY)}, "text": "No regressions in the last build."}
              ]
            },
            {
              "id": "roster-nova", "threadId": "roster-nova-inbox", "name": "Nova",
              "title": "Customer support", "description": "", "notifications": true, "color": "coral",
              "unread": false, $model, "createdAt": $created, "section": "Growth",
              "tasks": [
                {"threadId": "roster-nova-inbox", "title": "Support inbox", "createdAt": ${ago(8 * DAY)}, "updatedAt": ${ago(8 * DAY)}, $model}
              ],
              "messages": [
                {"id": "nova-1", "role": "bot", "kind": "text", "at": ${ago(8 * DAY)}, "text": "Answered the open support tickets."}
              ]
            },
            {
              "id": "roster-ledger", "threadId": "roster-ledger-close", "name": "Ledger",
              "title": "Finance analyst", "description": "", "notifications": true, "color": "green",
              "unread": false, $model, "createdAt": $created, "section": "Growth",
              "tasks": [
                {"threadId": "roster-ledger-close", "title": "Month-end close", "createdAt": ${ago(15 * DAY)}, "updatedAt": ${ago(15 * DAY)}, $model}
              ],
              "messages": [
                {"id": "ledger-1", "role": "bot", "kind": "text", "at": ${ago(15 * DAY)}, "text": "The month-end close is reconciled."}
              ]
            },
            {
              "id": "roster-sage", "threadId": "roster-sage-pricing", "name": "Sage",
              "title": "Strategist", "description": "", "notifications": true, "color": "purple",
              "unread": false, $model, "createdAt": $created, "section": "Growth",
              "tasks": [
                {"threadId": "roster-sage-pricing", "title": "Pricing review", "createdAt": ${ago(22 * DAY)}, "updatedAt": ${ago(22 * DAY)}, $model}
              ],
              "messages": [
                {"id": "sage-1", "role": "bot", "kind": "text", "at": ${ago(22 * DAY)}, "text": "Pricing options are summarised."}
              ]
            }
          ],
          "groups": [
            {
              "id": "roster-general", "threadId": "roster-general-thread", "name": "General",
              "memberIds": ["roster-atlas", "roster-scout", "roster-forge"],
              "defaultResponder": {"kind": "mentions"}, "bulletin": "", "unread": true, "createdAt": $created,
              "tasks": [{"threadId": "roster-general-thread", "title": "General", "createdAt": $created}],
              "messages": [
                {"id": "general-1", "role": "bot", "kind": "text", "at": ${ago(40 * MINUTE)}, "text": "Stand-up notes are posted."}
              ]
            },
            {
              "id": "roster-design-crit", "threadId": "roster-design-crit-thread", "name": "Design crit",
              "memberIds": ["roster-pixel", "roster-quill"],
              "defaultResponder": {"kind": "mentions"}, "bulletin": "", "unread": false, "createdAt": $created,
              "tasks": [{"threadId": "roster-design-crit-thread", "title": "Design crit", "createdAt": $created}],
              "messages": [
                {"id": "crit-1", "role": "bot", "kind": "text", "at": ${ago(DAY + 3 * HOUR)}, "text": "Copy and layout are aligned."},
                {"id": "crit-2", "role": "bot", "kind": "options", "at": ${ago(DAY + 2 * HOUR)}, "card": {"title": "Publish the new store copy?", "subtitle": "Pixel and Quill agreed on the wording.", "options": ["Allow", "Deny"], "requestId": "crit-request"}}
              ]
            },
            {
              "id": "roster-release-room", "threadId": "roster-release-room-thread", "name": "Release room",
              "memberIds": ["roster-forge", "roster-echo", "roster-juno"],
              "defaultResponder": {"kind": "mentions"}, "bulletin": "", "unread": false, "createdAt": $created,
              "section": "Engineering", "busyBotId": "roster-forge",
              "tasks": [{"threadId": "roster-release-room-thread", "title": "Release room", "createdAt": $created}],
              "messages": [
                {"id": "release-1", "role": "bot", "kind": "text", "at": ${ago(2 * DAY)}, "text": "Release checklist is green."}
              ]
            },
            {
              "id": "roster-scout-forge", "threadId": "roster-scout-forge-thread", "name": "Scout & Forge",
              "memberIds": ["roster-scout", "roster-forge"],
              "defaultResponder": {"kind": "mentions"}, "bulletin": "", "unread": false, "createdAt": $created,
              "dm": true,
              "messages": [
                {"id": "pair-1", "role": "bot", "kind": "text", "at": ${ago(3 * DAY)}, "text": "Handing over the benchmark results."}
              ]
            }
          ],
          "botQueuedMessages": {
            "roster-pepper-weekend": [{"queueId": "roster-weekend-queued", "text": "Draft the weekend plan"}]
          }
        }
        """.trimIndent()
    }
}
