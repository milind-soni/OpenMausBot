// One-shot fault injection for the voice-note e2e suite. The verification
// launcher imports this prelude only when it forwards
// OMB_TEST_FAIL_AUDIO_APPEND_ONCE=1, so no other environment is affected.
// It makes the FIRST store.appendMessage call whose message carries an
// audio attachment throw; every later call runs untouched. That single
// failure lets a test prove a persistence error leaves this turn's parked
// voice note in place — the post can be retried and the clip still attaches.
import { Store } from "../store.ts";

if (process.env.OMB_TEST_FAIL_AUDIO_APPEND_ONCE === "1") {
  const original = Store.prototype.appendMessage;
  let armed = true;
  Store.prototype.appendMessage = function (...args) {
    const message = args[1];
    if (armed && (message?.attachments ?? []).some((attachment) => attachment?.kind === "audio")) {
      armed = false;
      throw new Error("test fault: the first audio append fails once");
    }
    return original.apply(this, args);
  };
}
