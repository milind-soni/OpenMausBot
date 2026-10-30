# Browser dictation verification

Use the isolated fixture described in [README](README.md). Do not point these
checks at a running personal workspace, account, microphone or transcription
service.

```sh
pnpm exec vitest run server/routes/dictation.test.ts src/components/Composer.server-dictation.test.ts src/components/Composer.dictation.test.ts src/components/Composer.ime.test.ts scripts/control-omb.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

For the real browser, run:

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/server-dictation.e2e.test.ts
```

This installs the repository's pinned browser tooling when necessary. The
test launches its own fake-engine workspace and loopback transcription
stand-in. It substitutes a synthetic WebAudio stream for microphone input,
records real WebM through MediaRecorder, verifies its upload through the
workspace API, cancels an earlier capture without uploading, and checks that
the response appears only in the draft. An explicit click on Send creates
exactly one user message. Screenshots of ready, recording, transcription and
review states are saved under
`.omb-scratch/verify-evidence/server-dictation/`. The stand-in returns fixed
text; this check proves transport and draft behavior, not recognition quality.

The component tests cover permission denial, late microphone grants,
unsupported/insecure browsers, cancellation during capture and transcription,
conversation changes, manual editing and the duration limit. The existing
native dictation regression tests run alongside them.
Escape is also checked with focus on the microphone button or document body,
while opening the microphone and during transcription, including IME guards
and a late microphone grant. The Chromium fixture presses Escape outside
the textarea during both recording and transcription.

After installing the optional worker's dependencies in an isolated Python
environment, test decoding, duration limits, concurrent inference refusal,
empty speech and error redaction without downloading a model:

```sh
python -B -m unittest discover -s deploy/dictation -p test_server.py
```

The worker fixture also sends a trickling upload against an absolute deadline,
checks the HTTP 408 response, rejects an incomplete body with HTTP 400, and
proves that both failures release the inference slot without invoking the model.
Worker upload deadlines use the distinct `upload_timeout` code, retained as
HTTP 408 by the workspace route. Route and component regressions check error
redaction, a later successful recording, and preservation of the existing draft
without labelling a transfer timeout as invalid audio.
The Windows component fixture declares its desktop platform before the first
mount, so it checks the Windows capability path and browser fallback.

The worker checks include browser Origin/fetch metadata, unexpected or
duplicate Host headers, simple browser Content-Types, and refusal before
inference even when an authorized transcription is already running.
Unexpected inference errors return only a generic response. The worker writes
only the exception class to stderr; the test checks that diagnostic output
excludes exception messages and private model paths.

To check real recognition, separately stage a model as described in
[server dictation](../server-dictation.md), generate a WAV containing synthetic
speech, and post it to a disposable worker. Do not use personal recordings.

Physical microphone capture and permission prompts on Windows, macOS, Linux,
iOS Safari and Android Chrome still require manual checks. Confirm that
denying permission preserves the draft, recording releases the device on
cancel/navigation, text is retained for review, and nothing sends itself.
