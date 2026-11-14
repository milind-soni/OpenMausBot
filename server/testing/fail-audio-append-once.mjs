// Loaded only with OMB_TEST_FAIL_AUDIO_APPEND_ONCE=1: the first store.appendMessage carrying an audio
// attachment throws, so a test can prove a persistence error leaves the parked voice note retryable.
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
