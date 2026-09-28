# Team incidents: a broken run reaches the Chief of Staff

A bot's run can fail (the engine exits before a result), stall (no activity
for twenty minutes), fail to start (a setting, a missing engine), or a
scheduled routine can fail. Each used to leave one chip in the thread it died
in and nothing anywhere else — the person found it hours later, from a phone,
by opening the desktop and reading every thread, then retried by hand.

Now the team's coordinator hears first. When a run breaks on a bot whose
section has a **Chief of Staff** (or that a Chief was allowed to coordinate),
OpenMausBot:

1. opens — once — a **Team incidents** thread on the Chief and leaves a chip
   there naming what broke, linked to the broken thread;
2. gives the Chief a turn carrying the report: who, which thread, what the
   run said when it stopped, the last request and the last reply there, and
   what to do next. The report is marked as **not from the person**; the
   quoted text is data from a failed run, not instructions;
3. the Chief decides: `retry_thread` resumes the broken thread where it
   stopped (same conversation, same files, a line saying who asked and why);
   `delegate_bot` re-assigns with a corrected brief; or, when only a person
   can fix the cause — a sign-in, a missing credential, an unanswered
   question, a setting — it says so in one or two plain sentences and stops.

Limits, so a crash loop is one incident and not a storm: a thread may be
retried twice; the third report tells the Chief to stop and explain; after
five incidents in an hour the thread is muted until the hour passes. A
Chief's own failures, and a bot with no Chief on duty, go to the person as a
notification ("Ada hit a problem") — for a failure or stall mid-run; a run
that could not start and a failed routine already notified, and are never
announced twice. A thread another bot opened and is
watching (a delegation) is that bot's to handle — it is woken with the
failure already — so it raises no incident. A run the person stopped is not
an incident.

`retry_thread` is Chief-only, for a teammate the Chief can reach, never a
room thread (coordinate in the room instead), and never a thread that is
still running. The retried thread keeps its own approval level; the Chief is
not woken for its result — it stays in that thread, findable with
`list_threads` or `session_search`.

What the person sees: the Chief's *Team incidents* thread in the sidebar (and
on the phone), with one entry per incident and the Chief's one-line report of
what it did — instead of a silent stall somewhere in the team.
