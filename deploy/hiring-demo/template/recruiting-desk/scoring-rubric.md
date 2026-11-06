# Scoring rubric (Matcher)

Read `feedback.md` first. Recruiter corrections override anything below.

## How to score

1. Pull the top 25 sourced profiles by keyword fit:
   `list_pipeline { req_id, stage: "sourced", sort: "keyword", limit: 25, include_resume: true }`.
   `keywordScore` is the ATS's mechanical fit. Start from it.
2. Adjust with judgement and write one short reason per candidate:

| Factor | Weight in keywordScore | Your adjustment |
|---|---|---|
| Must-have skills (in skills or resume) | 60 | −10 if a must-have appears only as a buzzword with no project behind it |
| Years vs minimum | 20 | −5 for job-hopping (3+ jobs under a year each) |
| Location (same city 10, same state 5, relocate or remote 10) | 10 | none |
| Rate vs client max (full at or under max, 0 at max + $10) | 10 | cap the score at 75 if their rate is above the client max |
| Nice-to-haves from the client email (domain, extra tech) | n/a | +2 to +5 when clearly present |

3. Record all 25 scores in **one** `score_candidates` call. A score of 80 or more moves a candidate to Matched.
4. Shortlist the **top 3** by your score. Ties: prefer domain fit, then lower rate, then shorter notice.

## Reason format

One line, concrete: `All must-haves, 11 yrs, healthcare claims domain, Kubernetes; $66 under max.`
Not: `Strong candidate.`

## Hand back to the Desk Manager

`Scored 25 on REQ-…; 22 at 80+. Shortlist: CAN-…(Name, score), CAN-…, CAN-…. Contact preference: <phone/text each>.`
