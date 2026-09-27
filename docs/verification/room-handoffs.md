# Addressed work between group conversations

An agent speaking in one group can send a work request to a named agent in
another group. The sender does **not** need to belong to the destination.
Only the addressed agent runs, using the destination conversation, bulletin,
working folder, and its own profile. A plain `@Name` in chat still addresses
the current room; cross-room delivery uses an explicit group and agent ID.

The addressed agent can lead a discussion with existing members in that same
room before deciding and delegating further. Enable **Discuss with members
before delegating or concluding incoming work** to require it. See
[discussion and decisions within each layer](room-discussion.md).

## Configure and use

The default remains upstream's standard `coordinate_bots` behavior: permitted
teammates can collaborate without configuring routes or requiring a discussion.
In **Group collaboration settings**, optionally enable **Restrict incoming requests
to selected groups** and select the permitted source groups. An enabled restriction
with no sources blocks incoming group requests; disabling it restores the default.
The automatic result return does not require a reverse route.

Routes never grant additional team access. The existing sender/recipient peer
allow-lists, approvals, and Chief's explicitly selected team grants still apply.
Each recipient and discussion participant must be allowed to read the entire
receiving room; specialists do not inherit their Chief's access. Permissions and
routes are rechecked before dispatch and before returning results. The hierarchy
recipe uses one company section and separate groups for organizational layers.

From a source group, ask its agent, for example:

> Send a request to @Ren in the Development group to implement CSV export.
> Ask Ren to delegate implementation to @Sora in the Implementation group,
> then report the results here.

The agents integration exposes:

```text
list_room_targets()
discuss_room(member_ids, topic, request_key)
coordinate_bots(group_id?, bot_ids, message, request_key)
```

The destination list contains permitted bot/group names and member IDs, not their
history. The request forwards only the supplied brief. Each task is pinned to
the chosen conversation at acceptance, even if a user changes the active task.
The tool returns immediately. The source must finish its turn before queued
work starts. The receiving agent may send bounded downstream requests; it
releases its provider and room while waiting. After its children settle, it is
woken in the original room to review the results. Its final response is returned
to the parent, which resumes in the same way.

No automatic broadcast or responder selection runs on receipt. Bystanders,
including members mentioned incidentally in the brief or reply, do not start.

## Bounds and failure behavior

- At most 4 outgoing edges in an ancestry path, 24 requests per root, 48
  request/continuation executions, and a 30-minute root lifetime.
- Returning to any ancestor group is refused. Results use the recorded return
  path rather than creating another request.
- `request_key` deduplicates the same assignment under the same source run;
  reusing it for different work is refused.
- Work waits when the addressed bot or destination room is busy. The original
  destination task remains pinned. Membership and route grants are rechecked.
- Stopping a source group cancels its outstanding descendants. A failed source
  turn does not dispatch the work it queued.
- Receiving turns retain the target's permissions and downgrade elevated
  approval modes as peer-initiated work. They receive only the bounded room
  coordination tools in their agents integration, not an unrestricted recursive
  `delegate_bot` capability. Other engine tools remain subject to normal approval.
- Pending requests are persisted in `room-handoffs.json`. On restart they become
  explicit failures, without replaying potentially side-effecting tools. This is
  interruption recovery, not exactly-once execution across a process crash.
- Results are bounded to 12,000 characters. Files are not automatically copied.

## Reproduce in an isolated fixture

```powershell
node --experimental-strip-types scripts/verify-room-handoffs.ts artifacts/room-handoffs/verification.json
```

This uses `launchVerificationServer` and `runControlOmb`, the same shared control
surface as `control-omb launch`. It creates a temporary home, data, ports and fake
engine, runs the real injected agents MCP proxy, captures `wait` and `messages`
JSON plus provider input and the request tree, then stops its exact child and
removes its temporary data. The server log and evidence JSON remain available.

The scenario has **disjoint group membership within one company section**:

```text
経営会議: ミナト
  -> 開発部: @レン (リツ does not run)
    -> 実装チーム: @ソラ (ヒナ does not run)
    <- ソラ's result
  <- レン's reviewed result
ミナト resumes and reports
```

It also sends an identical request twice, tries an invalid recipient, attempts
to loop back to the executive group over an enabled reverse route, and tries
the old delegation tool from a receiving turn. All are checked explicitly.

To view the fixture after the checks:

```powershell
pnpm build
node --experimental-strip-types scripts/verify-room-handoffs.ts artifacts/room-handoffs/verification.json --preview
```

Open the printed preview URL. Ctrl-C stops the exact fixture and removes its
temporary data. Do not run these experiments against the user's normal server.

The equivalent route configuration on an explicitly launched fixture is:

```powershell
pnpm control:omb room-routes --channel DESTINATION_ID --from SOURCE_ID --url http://127.0.0.1:PORT
# Disable incoming routes:
pnpm control:omb room-routes --channel DESTINATION_ID --from "" --url http://127.0.0.1:PORT
```

## Verification scope

`server/room-handoffs.test.ts` covers the scheduler, limits, cancellation,
idempotency and restart handling. The two room-handoff e2e suites cover the real
provider/proxy/server path, failure return, busy queues, route revocation, allow
and deny cards, source interruption, and destination-task switching.

The provider is deliberately scripted. This proves delivery, scheduling,
conversation context, guard enforcement and return routing. It does not measure
how reliably a production model chooses the tool from natural-language requests,
the quality of its work, real token costs, or every engine's integration support.
