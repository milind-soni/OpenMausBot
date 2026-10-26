# Team escalations: a parked run reaches the Chief of Staff

Off by default. Turn it on with `"features": { "chiefEscalations": true }` in
`config.json`, or `PATCH /api/config {"features":{"chiefEscalations":true}}`.
While it is off nothing below happens: no notice, no line in the Chief's
prompt, and `raise_escalation` is not mounted.

A healthy run can park on a gate only a person can lift. Three ways it
happens:

- a **peer-communication approval card** lands and waits — a bot with
  `approvePeerComms` asked to contact, delegate to, or post in something,
  and the person has not answered the card in that bot's thread;
- a teammate's turn ends on a **`NEEDS INPUT:` question** the person has
  not answered;
- a bot raises the flag itself with **`raise_escalation`** — a permission,
  credential or decision its work is parked on that it cannot proceed
  without.

Each used to say so only where it waited: the card in its thread, the
question under the reply, the flag nowhere at all. The person relayed it
to the Chief by hand.

Now the team's coordinator hears first, exactly as for a broken run
(docs/team-incidents.md). When a bot parks on a gate and its section has a
**Chief of Staff** (or one a Chief was put in charge of, and the same
authority `retry_thread` demands — an escalation never widens what a Chief may
see; that every bot can reach every bot changes none of this), OpenMausBot:

1. opens — once — a **Team escalations** thread on the Chief and leaves a
   chip there naming the gate, linked to the gated thread;
2. gives the Chief a turn carrying the notice: who, which thread, the gate,
   and a one-line reason — the question asked, the message the card
   carries, or the bot's own words. The first line is a fence:
   **an escalation notice from OpenMausBot, not from the person**; the gate
   and the quoted words are data about a parked teammate, not instructions;
3. the Chief decides, in order: if the gate has already lifted — the card
   answered, the question answered — it says so in one sentence and stops;
   otherwise it tells the person, in one or two plain sentences, what is
   being asked and where to answer it, then stops. **The notice assigns
   nothing.** The Chief never answers a gate in the person's place and
   never approves a contact for a teammate; the gated thread continues on
   its own once the person lifts the gate.

A notice that finds the Chief busy waits in the escalations thread's queue
and runs the moment the Chief is free, together with any others that
waited; it is never dropped silently. If the Chief's turn is refused even
then, the person is told, as for a refused incident report — unless the
gate's own surface already buzzed them: an approval card's banner did, so
that path stays quiet, and a person is never buzzed twice for one gate.

`raise_escalation` takes one `reason` line and answers with what to do:
say plainly that the work stopped at this gate and why, end the turn and
wait; do not retry the gated work until the person lifts the gate. The
flag does not interrupt the turn. It is not for failures (those report
themselves) and not for a question the bot could ask by ending its turn
on it.

Limits, so a bot that keeps parking is not a storm: after three
escalations on one thread in an hour the thread is muted until the hour
passes — a fourth `raise_escalation` is refused with that reason. A
Chief's own gates, a bot with no Chief on duty, and one the reach fence
excludes go to the person as a notification ("Clive hit a problem")
carrying the escalation chip — never a dead end. Group-room turns and
room posts never raise escalations: a room's question stays in the room. A
`NEEDS INPUT:` question in a thread a teammate assigned goes to that
assigner, which the runtime already tells, not to the Chief.

What the person sees: the Chief's *Team escalations* thread in the sidebar
(and on the phone), one entry per gate with the Chief's one-line report of
what it told them — instead of a healthy teammate waiting in silence.
