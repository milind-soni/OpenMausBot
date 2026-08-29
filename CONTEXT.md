# Agent Centipede V3 Outcome Mode

This context names the durable concepts used when Centipede turns a requested outcome into bounded, verifiable work.

## Outcome language

**Outcome**:
The user-visible result Shane wants, expressed with a quality bar and a definition of success.
_Avoid_: Task, prompt, wish

**Outcome Contract**:
The versioned agreement that makes an Outcome executable: its success criteria, deadline, budget, quality bar, authority, escalation rules, evidence requirements, and rollback or termination behavior.
_Avoid_: Plan, settings, goal

**Constraint**:
A limit the Outcome must respect, such as time, money, scope, quality, privacy, or allowed systems.
_Avoid_: Preference, hint

**Authority Grant**:
An exact, bounded permission to perform a named action for a named purpose; absent a matching grant, authority is denied.
_Avoid_: Permission, approval

## Work and proof

**Work**:
The canonical executable unit owned by the existing Work system and linked to one Outcome Contract version.
_Avoid_: Subtask, job

**Evidence**:
An attributed, time-bound observation or artifact reference that can be checked against a Contract’s success criteria.
_Avoid_: Log, output

**Capture Evidence**:
Evidence observed through a Capture source and offered as a first-class intake path for inferring or linking an Outcome; it does not authorize execution by itself.
_Avoid_: Trigger, instruction

**Contractual Judgment**:
The existing contract and authority verdict applied before consequential Work proceeds. Its product labels preserve the repository's canonical policy semantics: green permits only when the contract allows the exact work, yellow means durable Needs-you input, and red means refused, blocked, or parked.
_Avoid_: Confidence score, execution shortcut

**Verification**:
An independent judgment that the exact Contract version’s success criteria are satisfied by the supplied Evidence and artifacts.
_Avoid_: Completion, self-report

**Receipt**:
The durable record of a material decision or result, including the identities, version, evidence, and outcome needed to replay what happened.
_Avoid_: Notification, status update

**Needs-you Input**:
A durable request for a specific human answer when execution cannot proceed safely without it; the answer becomes a Receipt.
_Avoid_: Chat prompt, approval card

**Terminal State**:
An Outcome state after which no further execution is permitted: completed, failed, cancelled, or rolled back.
_Avoid_: Done, inactive
