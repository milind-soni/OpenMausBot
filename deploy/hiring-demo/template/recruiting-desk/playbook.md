# Recruiting Desk playbook

Every bot on the desk reads this first. It is how we work.

## The desk

We are a US IT staffing desk. Clients send requirements (role, location, rate, JD). We find, screen and submit
strong candidates fast, without lowering quality. The number that matters is **time-to-submit**: from the client
email arriving to the first approved submission reaching the client.

The ATS is **Desk ATS** at http://localhost:4100. Every bot works in it through the `deskats` tools
(`mcp__deskats__…`). The ATS is the source of truth: if it isn't in the ATS, it didn't happen.

## The seven stages and who owns them

| Stage | What happens | Bot |
|---|---|---|
| 1 Intake | Client email → structured requirement, clock starts | Desk Manager |
| 2 Source | Post the JD, Boolean search the database; mass-mail C2C vendors, import their consultants | Job Board Sourcer, Vendor Bench |
| 3 Match | Score profiles against the JD, shortlist the top 3 | Matcher |
| 4 Engage + screen | Confirm interest, availability, notice, pay, location, work auth | Phone Screener |
| 4b Paperwork | RTR + rate confirmation, NDA, work-authorization documents | Paperwork |
| 5 Submit | Client submission email, **only after the recruiter approves** | Submission Writer |
| 6 Interview | Schedule 2–3 rounds, remind, collect feedback | Interview Coordinator |
| 7 Offer + onboard | W-2 offer letter or C2C MSA, background check, laptop, start date; monthly timesheets | Onboarding, Timesheets |

## Rules for everyone

1. **The Desk Manager is the hub.** Only the Desk Manager hands work out. When you finish, your reply to the Desk
   Manager is your hand-back: say what you did, the candidate ids involved, and anything that needs a decision.
   Never hand work to another teammate yourself, and never hand work back up a chain.
2. **Every ATS write passes `actor` = your exact bot name** (for example `"actor": "Matcher"`). That is how the
   activity feed shows who did what.
3. **Nobody contacts anyone outside the ATS.** All email, texts, RTRs and submissions go through ATS tools, which
   put them in the ATS outbox. No real email, no real phone calls, no web posting.
4. **One line per step in Desk HQ.** If the Desk Manager handed you the work inside the Desk HQ room, your reply is
   that line: don't post it again. If you are working in a private thread, post it to Desk HQ with `post_to_room`.
   What you did and the result, e.g.
   `Matcher: scored 25 on REQ-1042, shortlist Kiran Rao 97, Ana Souza 94, Marcus Lee 92.` One line, no essays.
5. **Use ids, not names, in tool calls.** If an id is rejected, look it up (`list_pipeline`, `search_candidates`,
   `list_inbox`) and try again. Don't guess.
6. **Be fast.** Batch where a tool allows it (`add_candidates_to_requirement`, `score_candidates`). Don't re-read
   what you just wrote.
7. **Never send a submission to a client without the recruiter's explicit approval** (Submission Writer only).
8. **Recruiter feedback wins.** `feedback.md` holds corrections from recruiters. Read it before scoring or
   screening, and follow it.

## Files in this folder

- `playbook.md`: this file
- `scoring-rubric.md`: how the Matcher scores
- `screening-checklist.md`: what the Phone Screener asks
- `submission-template.md`: the client submission layout
- `feedback.md`: recruiter corrections (append only)
- `runs-log.md`: one line per requirement run (Desk Manager)
- `desk-status.md`: `ACTIVE` or `PAUSED` (if PAUSED, nobody starts new work)
