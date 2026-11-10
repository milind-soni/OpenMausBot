# Minimum AI automations: work in progress

Related issue: #4997

This document describes an experimental implementation. It is incomplete and is not ready to merge or deploy. It is enabled only when `OMB_MINIMUM_AI_EXPERIMENT=1` on a supported self-hosted installation.

## Intended behavior

An automation can opt into Minimum AI. A first setup run uses a model to prepare or learn an inspectable workflow. The owner reviews and approves it; subsequent scheduled and manual runs execute the approved workflow without model calls. Runs stop on errors. Automatic AI recovery, retries and learned error handling are deferred.

## Current implementation

- The automation editor has an opt-in selector and a review flow. Existing automations retain their default behavior.
- Connected-app workflows use a bounded declarative executor with tool calls, references, conditions, iteration and pagination. Account identity, schemas and permissions are checked; a partially failed or interrupted run is held for review.
- The experimental built-in Chrome path can record certain page opens, named clicks and non-secret text-field fills. A model may propose a changing-item pattern, which is simulated against the observed first run before it is shown for approval. A fixed recording is identified as such in the review UI.
- Local fixture tests cover synthetic connected apps and browser pages, including failed and cancelled runs. A real Chrome fixture exercises recording and replay. These tests do not establish compatibility with arbitrary websites or tools.

## Work remaining before review for merge

1. Support and verify the requested range of tools, including custom MCP servers and VM/computer actions; avoid treating an unsupported or partial recording as a completed task.
2. Validate learned patterns for changing data, empty results, page changes, ambiguity and side effects across substantially different real-world workflows. Review the safety of persisting URLs and field values.
3. Exercise restart, cancellation, overlap, permission changes and uncertain side effects across all supported execution paths; avoid repeating an action with an unknown outcome.
4. Review the user experience, accessibility, localization and the wording around first-run effects, exact-item recordings and approval.
5. Complete isolated end-to-end tests, applicable project checks and a user test before removing the experimental gate or requesting merge review.

A connected-app tool that moves an item to a recoverable trash must not be described as permanently deleting it. Do not assume a local or cloud computer operation can be replayed through the browser path.

## Sample verification data

- A synthetic task collection contains `alpha` and `gamma` in Trash and `beta` in Inbox. A cleanup must affect only the two matching records, including when results span multiple pages.
- A synthetic inbox contains unread and read messages. A report must use current unread items and leave messages unchanged.
- Browser fixtures use named sample controls and unrelated controls. Replays must find current matching targets, leave unrelated controls untouched and stop if a target is missing or ambiguous.
- Fault cases include changed schemas or permissions, disconnected services, timeouts, cancellation, restart and overlapping runs. Tests should verify that no model is called during replay and that partial or uncertain actions are surfaced for review.
