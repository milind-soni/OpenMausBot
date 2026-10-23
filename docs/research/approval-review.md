# Approval review design

Provider-native approval remains the first choice. App-owned API tool loops use
an isolated reviewer; Claude can use it only after confirming its own reviewer
is inactive. Native Muse remains separate from the Meta Model API chat runtime.

A configured registered provider/model is used exactly. Otherwise review follows
the session model and variant. Review uses `none` when advertised, otherwise
the lowest supported effort (Low for Claude), independently of the working agent.
Variant-only providers retain their variant without an extra effort. An explicit
unsupported reviewer effort is refused. A missing model,
unsupported variant, unavailable provider, invalid verdict, changed settings,
changed execution, incomplete authority, or exhausted context budget requires a
human decision.

The rubric has a stable system message, then standing instructions, genuine user
authority, and the exact action. Tool output, relays and assistant statements
supply context but cannot grant permission. Original user restrictions remain
available, including any source IDs referenced by a cumulative checkpoint when
that independent feature is installed.

The helper has no tools, MCP access, hooks or durable session. It enforces a
bounded verdict output and meaningful-output idle deadline; slow prefill remains
interruptible. Synthetic verification proves routing and refusal behavior; this
independent reconstruction does not claim new live-model quality or cache-hit
measurements.
