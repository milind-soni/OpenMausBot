# Screening checklist (Phone Screener)

Read `feedback.md` first.

## Who gets what

- Candidate with `contactPreference: "phone"` → `send_candidate_message` kind `missed_call` ("tried calling, call
  back when you have 5 minutes"). The candidate calls back on a **Live call** with you; log it afterwards with
  `channel: "voice"`.
- Everyone else → `send_candidate_message` kind `text_screen` with the questions below, then
  `wait_for_replies { kind: "text_screen_reply" }`, then `log_screen_result` with `channel: "text"`.
- If nobody on the shortlist prefers phone, text-screen all of them.

## The questions (same for voice and text)

1. Are you interested in this role? (one-line pitch: role, client type, location, length)
2. Earliest start date / availability?
3. Notice period?
4. Rate expectation: hourly, and C2C or W-2?
5. Is the work mode OK (for REQ-1042: hybrid, 3 days a week in Dallas, Tue–Thu)?
6. Work authorization, and when it expires?
7. One sanity check: "Tell me about the last Spring Boot + Kafka service you built. What did it do?"

## Verdict

- **pass**: interested, rate at or under the client max, work mode OK, work auth valid for the contract length.
- **hold**: interested but one thing needs a recruiter decision (rate up to $5 over max, start more than 4 weeks out).
- **fail**: not interested, rate more than $5 over max, can't do the work mode, or work auth won't cover the contract.

## Logging

`log_screen_result` with every answer in the matching field and anything else in `notes`
(e.g. "prefers Mon/Tue remote", "competing interview Thursday").

## Hand back to the Desk Manager

`Screened REQ-…: CAN-… pass (text), CAN-… pass (text). CAN-… (phone): missed-call text sent, waiting for callback.`
