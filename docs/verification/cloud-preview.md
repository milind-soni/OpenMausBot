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

The fixture tests actual image decoding, request cancellation, fresh frame
selection, and renderer feedback. It does not prove real Box provisioning,
native viewer windows, or account authentication. Test those separately with
an explicitly isolated provider fixture when changing those paths.
