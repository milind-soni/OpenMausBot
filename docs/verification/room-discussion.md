# Discussion and decisions within each layer

Existing members discuss a request in their own group conversation. The addressed
director or lead chairs the discussion, resolves proposals, and resumes after the
members respond. No bots are invited, moved, or created by this workflow.

## Workflow

Enable **Discuss with members before delegating or concluding incoming work** in
the destination's **Incoming work** panel. Configure allowed source groups and
ensure each room already has the members who should participate.

1. The addressed member states a proposal and the questions to resolve.
2. `list_room_targets` returns `currentRoom.members`.
3. `discuss_room(member_ids, topic, request_key)` queues 1–4 existing members.
   The chair finishes the turn. Participants speak in order, seeing the preceding
   opinions, and are asked for tradeoffs, concerns, and concrete amendments.
4. The chair resumes in the same conversation, accepts or rejects proposals,
   explains the decision, and may request another bounded discussion round.
5. The chair can send a revised brief downstream, or use `assign_room_member` to
   divide responsibility among existing members. Assigned members can themselves
   send downstream requests. See the [branching organization](room-pyramid.md).
6. The downstream group follows the same process. Results return to the original
   requester, who reviews and reports them up the recorded path.

Downstream work is refused while discussion is pending. A room that requires
discussion cannot delegate without a successful discussion. Discussion participants
cannot delegate or start another discussion. Incidental mentions do not start a
second set of participants. A completed recipient cannot be restarted merely to
acknowledge its work; concrete rework needs a new key and `rework: true`.

These guards establish ordering. They do not prove that the opinions are useful,
that the chair's reasoning is sound, or that an artifact satisfies its acceptance
criteria. Those are separate semantic checks of model output.

## Reproduce

```sh
node --experimental-strip-types scripts/verify-room-discussion.ts .omb-scratch/room-discussion/verification.json
```

The scripted fixture uses three rooms with three disjoint members each. It checks
revision of a proposal, preceding opinions in later participant input, refusal to
forward before/during discussion, chair continuation, and a three-layer round trip.
It uses the real server and injected agents MCP proxy.

For an optional real-model experiment, set `OMB_VERIFY_CC_CONFIG` to an existing
OpenMausBot configuration and `OMB_VERIFY_CC_CLI` to Claude Code. Select its profile
with `OMB_VERIFY_CC_INSTANCE` (default `claude`). The experiment expects that
profile to specify `ANTHROPIC_MODEL=glm-5.3`, and selects effort `low` for all bots.
Only the allow-listed connection environment is copied into a private, temporary
configuration. The original configuration and conversations are not changed.
On Windows, set `CLAUDE_CODE_GIT_BASH_PATH` when necessary. Do not put credentials
in command arguments or published evidence.

Add `--live --preview` to run without scripted responses and retain the fixture
for screenshots. Build the UI first with `pnpm build`. Create the output JSON's
`.stop` file to exit normally and remove the temporary data; Ctrl-C also requests
cleanup. The wait budget is 25 minutes and the root lifetime is 30 minutes.
Each participant's turn counts toward the shared execution limit.
