# Deferred chat tool catalogs

Run the isolated acceptance fixture:

```sh
node node_modules/vitest/vitest.mjs run server/token-efficiency.e2e.test.ts
```

The fixture launches the real server in a disposable home and uses a loopback scripted Chat Completions provider. It mounts the built-in agents catalog and synthetic mail and desktop catalogs. Large catalogs offer `search_tools`, `describe_tool`, and `call_tool`; their original definitions stay in the host. A small catalog remains directly callable.

The fixture checks prompt-preview discovery guidance, ordinary chat without tool execution, computer search without an action, mail search and schema retrieval, an approval card naming the original mail operation and arguments, denial without a receipt, and an explicit approved retry with exactly one synthetic receipt. It saves its command results, requests, approval-card summary, and receipt beside the persistent server log printed at completion. The desktop executor is synthetic and never controls the host computer.

Directory and driver unit tests also cover scope filtering, hidden original names, original JSON-schema validation, catalog limits, compact search results, full-description hints, common screenshot/browser search vocabulary, and tool-free requests without added discovery guidance. Data integrations use the same driver guidance and execution path.

Set `OMB_TOKEN_EVIDENCE_DIR` to export synthetic provider requests to `provider-requests.json`. To render and count an existing capture with a separately running local tokenizer:

```sh
node --experimental-strip-types scripts/measure-chat-tokens.ts \
  --requests /absolute/path/provider-requests.json \
  --tokenizer http://127.0.0.1:PORT/v1 \
  --out /absolute/path/token-report.json
```

The helper calls only `/apply-template` and `/tokenize`, rejects remote URLs, credentials, and redirects, and reports counts and shared-prefix lengths without storing prompt text or token IDs. Set `OMB_TOKENIZER_URL` on the acceptance fixture to measure its requests and enforce the initial 10K-token budget. Counts depend on the loaded tokenizer and the catalog; they are not hosted-provider billing measurements.

For opt-in local model quality checks, `scripts/verify-qwen-tool-discovery.ts` exercises synthetic inbox reading, newsletter archiving, and an unsent urgent reply draft. `scripts/verify-qwen-computer-discovery.ts` accepts `OMB_COMPUTER_CATALOG_FILE`, searches an exported catalog, retrieves full screenshot instructions, and refuses every underlying desktop action. Both require explicit `OMB_BENCHMARK_URL` (a loopback origin) and `OMB_BENCHMARK_MODEL` (the exact loaded model ID). They use disposable servers and a local forwarding proxy, write owner-only synthetic captures, and close their own resources. They contact the separately running local model and must be invoked deliberately.

This acceptance fixture covers tool exposure and discovery. The same branch preserves cross-turn protocol history; the history fixtures cover that behavior separately. The [benchmark report](token-efficiency-benchmark.md) compares both components and the simpler wider-replay alternative. Scripted providers prove request boundaries and resulting synthetic state; live model quality and token measurements require their own evidence.
