# Contract cases

`cases.json` holds recorded Bot API v1 exchanges. The TypeScript and Python test runners replay every case against a stub HTTP server.

- Top level: `bot` (`b1`), `key` (`k_test`), `cases`. Path is always `/hooks/api/v1/bots/b1/messages`, header `authorization: Bearer k_test`.
- `call`: `method` (`send | thread | wait | ask`), `message`, `thread` (for `thread` and `wait`), `options`.
- `options` holds only that method's own options, camelCase (Python maps to snake_case). `ask` and `wait` carry `pollInterval: 0.01`. Never `retryDelay`: runners always build the Bot with `retryDelay: 0` (and default `maxRetries: 2`).
- `exchanges`: the requests the stub accepts, in order. `request` has `method` plus `body` (exact JSON) for POST or `query` for GET.
- `response`: `status` plus `body` (JSON) or `rawBody` and `contentType`; optional `headers`; or `drop: true` to close the socket unanswered.
- `repeat: true` on an exchange answers every later request the same way.
- A request the exchanges don't list fails the case. That is how "never a second POST" and "GET stops after 3 tries" are checked.
- Every case ends with exactly one of `result` or `error`.
- `result`: the normalised answer, compared field by field for equality.
- `error`: `type` (class name) plus any of `status`, `thread`, `retryAfter`, `message`, compared exactly. `messageContains` is a substring check (used by `unknown-status`).
- An HTTP error with a non-JSON body, or JSON without a string `error`, has message `HTTP <status>`.
- `old-server` and `post-502` give no `message`: the runner doesn't check it.
