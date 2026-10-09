// The desktop app's private parent port, for the verification launcher's
// desktop mode. The launcher imports this prelude only when it forwards
// OMB_TEST_DESKTOP_OWNER_TOKEN, and then also sets OMB_DESKTOP_PARENT=1, so
// the server runs as Electron's utility process runs it. The owner
// capability Electron would hand over is the one the test chose; nothing
// else crosses this port.
const token = process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
delete process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
if (token) {
  Object.defineProperty(process, "parentPort", {
    value: {
      on(event, listener) {
        if (event === "message") queueMicrotask(() => listener({ data: { type: "openmausbot:desktop-mutation-token", token } }));
      },
      postMessage() {},
    },
  });
}
