# Grok Bot vs. Agent Centipede — August 27, 2026

## Scope and method

This audit reconstructed work attempted between 10:34 AM and 8:52 PM CT from four local Grok Bot persistence archives under `C:\Users\shane\AppData\Roaming\Grok Bot\sand-client-persistence\*.blob`. The archives contained 428 raw records. Mirrored agent messages mean that record count is not a count of unique actions.

No message bodies, credentials, or private source content are reproduced here. Outcomes were grouped by the real-world job being attempted, then compared against Agent Centipede's current execution model and the failure controls in this repository.

## What happened today

### 1. Capture and personal operations

Grok recovered a signed-out Messages session, stopped at the authentication boundary, read inbound items without replying, triaged Plaud/email/calendar changes, sent one explicitly authorized SMS, updated one joint-expense record, and monitored later replies without taking unauthorized follow-up action.

This was Grok at its best: signed-in browser access, broad inbound context, and good restraint. The structural weakness was reconciliation. At least one gift-card amount was inconsistent between task state and later Capture reporting.

**Centipede should do better by:** retaining Grok's access and restraint, but making every obligation and authorized action a `WorkLock`, recording provenance, and flagging source disagreement instead of silently selecting one value.

### 2. Amplo agreement

Grok produced a useful revised agreement and rendered PDF, but project routing drifted. It first targeted the wrong existing project location, then created the Amplo project under a different root than the path requested by Shane.

**Centipede should do better by:** treating the requested project root as part of the completion contract. An exact bind succeeds; any other path returns a blocker. “Created somewhere” is not completion.

### 3. USRV redesign and deployment

The design work was useful: Grok found weak copy, headline wrapping, and image-polish issues, and the final local artifact passed Shane's taste check. Deployment then became the day's largest failure:

- a design-runtime artifact was treated as a guest-deployable page;
- Railway success and HTTP 200 were accepted while a normal guest browser still exposed template tokens;
- repeated approval handling and polling consumed hours;
- the same serving/export strategy was retried without a decisive verification gate;
- Shane ultimately hosted the page and sent the email himself.

**Centipede should do better with one typed contract:**

`selected artifact → deploy → normal guest-browser verification → zero template tokens → mobile check → prepared draft/receipt`

No provider status, build log, or headless render may substitute for the normal-browser and mobile checks.

### 4. Approval and worker visibility

Grok repeatedly attempted to change global approval behavior, while the live run retained its original snapshot. It then created approval-cleanup work and generated visible friction without advancing the underlying outcome.

**Centipede should do better by:** binding policy to each live worker lease, auto-continuing only safe action classes, holding sensitive classes, and projecting every batch as one accountable inline lifecycle: queued, running, waiting, verified, blocked, or stopped. There should be no approval-hunting worker.

### 5. Trusted AI draft update

Grok monitored the revised URL and updated an existing email draft without sending. This was the correct yellow-path behavior: prepare the exact last inch and leave the consequential boundary with Shane.

**Centipede should preserve this pattern:** a prepared payload, a single approval, execution of the exact approved bytes, and fresh post-action verification.

## Where Grok was genuinely better

- Direct access to Shane's signed-in desktop and browser state.
- Broad inbound capture and useful cross-source triage.
- Good restraint around send, spend, reply, RSVP, and authentication boundaries.
- Reasonable handoff when human authentication was truly required.

## Where Centipede should be better

- Durable ownership and deduplication across workers.
- Explicit artifact identity and post-action verification.
- Bounded retry with a changed strategy, then an honest blocker.
- Exact project/account/path binding.
- Reconciliation when connected sources disagree.
- One coherent chat-native activity projection instead of worker chatter.

## Product decisions from the audit

Implemented in desktop `0.1.94` and Android `0.1.84`:

1. One durable inline worker-batch card in the owner chat.
2. Per-lane queued/running/completed/failed/canceled state.
3. Live progress patches through the existing persisted message stream.
4. Restart-safe batch identity and recovery projection.
5. Hidden prompts, tool transcripts, results, and errors excluded from the progress projection.
6. One consolidated terminal receipt instead of separate worker replies.
7. Active cards expand; successful cards collapse; failed/stopped cards remain explicit and inspectable.
8. Responsive desktop/Android rendering and reduced-motion-safe animation.

Highest-value follow-ups:

1. Live-run permission propagation and safe-class auto-continue.
2. Reusable deployment completion contracts with guest-browser and mobile verification.
3. Artifact provenance: source path, content hash, destination URL, verifier result, and draft/send state.
4. Exact project-root enforcement.
5. Cross-source reconciliation for money, orders, calendar state, and other conflicting facts.

## Architectural verdict

The “Contractual” thesis belongs inside Centipede as an execution kernel, not as its personality or entire product category:

`Chief understands outcome → WorkLock owns obligation → ActionPolicy classifies boundary → prepared action executes → fresh read verifies → receipt closes lock`

Open-ended research, taste, planning, and relationship judgment remain flexible Chief work. Repeatable consequential execution becomes typed, bounded, replay-tested, and verifiable. Chat remains the interface; the machinery appears only when work is moving or Shane has a real decision.

## Code evidence

- Durable worker state and recovery: `server/worker-jobs.ts`
- Safe client projection: `shared/worker-batch.ts`
- Owner-thread projection and consolidated receipt: `server/index.ts`, `server/worker-batch-receipt.ts`
- Desktop card: `src/components/WorkerBatchCard.tsx`
- Android card: `android/app/src/main/java/com/openmausbot/chief/MainActivity.kt`
- Execution substrate: `server/work-lock-store.ts`, `server/action-policy.ts`, `server/account-directory.ts`, `server/capture-supervisor.ts`
