# Cloud screen preview

Start the isolated renderer fixture directly in a terminal:

```sh
node --experimental-strip-types scripts/verify-cloud-preview.ts
```

Open the printed `previewUrl` in a browser or an isolated Electron window.
The fixture starts the standard fake-engine harness in a temporary home,
creates its own test bot through the mapped control command, and mounts the
real `ComputerPanel`. Only the cloud transport is simulated. It never needs
a Box API key and never contacts a cloud provider. Ctrl-C stops both servers
and removes their temporary data; the printed harness log remains.

Verify these transitions with computer use:

1. On initial connection, **Cloud screen connected** appears. The fixture
   deliberately injects an old blank SSE frame before mounting the connection;
   that frame must not hide the new screenshot. The old implementation fails
   this check by continuing to display a black rectangle.
2. Select **corrupt**, then **Reconnect panel**. The panel must show an image
   error and **Retry preview**, rather than a blank image with an Open button.
3. Select **slow**, then **Retry preview**. The panel immediately shows
   **Connecting to the screen…**, then displays the image after 12 seconds.
4. Select **failed**, then **Reconnect panel**. The provider error appears
   inside the preview. Select **connected**, then **Retry preview** to recover.
5. Turn **Busy** on, then **Publish live frame**. The new live frame appears.
   Stop publishing: within 14 seconds, screenshot polling resumes and restores
   **Cloud screen connected**, even though the bot is still busy.
6. Select **timeout**, then **Reconnect panel**. After 90 seconds, the loader
   becomes a timeout error with **Retry preview**. Choose **connected** and
   retry; the connection must recover without restarting the app.
7. While **slow** is pending, switch to **connected** and **Reconnect panel**.
   The new connection must display immediately; the cancelled request must
   neither block it nor overwrite its frame later.
8. Select **held**, turn **Busy** on, and wait for the next poll. Toggle
   **Busy** off: the pending capture must not be canceled. **Reconnect panel**
   does cancel its client request, but the simulated host capture continues.
   The replacement preview must retry contention without a disconnect alert.
   Select **connected**, then **Release held capture**; the preview recovers
   automatically and the old capture never overwrites it.
9. From a connected frame, select **failed** and turn **Busy** on. After the
   error appears, select **contended** and **Retry preview**. The last frame
   stays visible while retrying. After ten seconds the continuing contention
   becomes an actionable error, but retries continue: select **connected** to
   recover without clicking Retry again.
10. Open the live desktop. The fixture holds its join until **Release desktop
    join**; screenshot polling must pause throughout that wait. Repeat with
    **Panel → Remote desktop**. The viewer is simulated, never a native window.
11. Select **unconfigured** while **Busy** is on. Its permanent HTTP409 must
    show **VPS is not configured** with Retry, not an endless connecting state.

The automated browser regression runs these contention, cancellation, decoded
frame retention, and join-pause checks against the same fixture:

```sh
OMB_UI_E2E=1 node node_modules/vitest/vitest.mjs run scripts/testing/cloud-preview.e2e.test.ts
```

It reuses the standard isolated UI harness and prints the temporary data path
and persistent server log. To reuse already installed test binaries, set
`OMB_AGENT_BROWSER_PATH` and `AGENT_BROWSER_EXECUTABLE_PATH` explicitly.

The fixture tests actual image decoding, request cancellation, fresh frame
selection, and renderer feedback. Host work continuing after cancellation is
simulated in-page; `server/vps-routing.test.ts` separately covers the real HTTP
route with fake SSH/Docker. Neither fixture proves a real VPS connection, Box
provisioning, native viewer windows, or account authentication. Test those
separately with an explicitly isolated provider fixture when changing those paths.
