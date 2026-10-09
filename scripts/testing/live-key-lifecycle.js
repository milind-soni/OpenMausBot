// Evaluate with control:omb ui eval in its disposable threads preview only.
// No credential is saved and getUserMedia never touches a physical device.
(async () => {
  if (location.pathname !== "/__threads.html") throw new Error("Use the isolated ui launch preview");
  // Use the renderer's existing module instance, including after Vite HMR.
  const asset = (path) => performance.getEntriesByType("resource").filter((entry) => entry.name.includes(path)).at(-1)?.name ?? path;
  const media = await import(asset("/src/lib/live-call-media.ts"));
  const mode = await import(asset("/src/lib/call-mode.ts"));
  const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const select = (name) => {
    const row = [...document.querySelectorAll('[role="button"]')].find((node) => node.textContent.startsWith(name));
    if (!row) throw new Error(`Missing fixture chat: ${name}`);
    row.click();
  };
  const bridge = window.ogb;
  const previousMode = mode.callMode();
  let microphoneStarts = 0;
  const results = {};
  if (media.liveMedia().phase !== "idle") throw new Error("Start with an idle fixture");
  media.configureLiveMedia({
    getUserMedia: () => { microphoneStarts++; return new Promise(() => {}); },
    request: async () => { throw new Error("Unexpected Live request"); },
    playRemote: () => {}, stopRemote: () => {},
  });
  try {
    mode.setCallMode("live");
    for (const action of ["dismissal", "targetReplacement"]) {
      select("Pepper");
      await settle();
      const response = await fetch("/api/config", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: { key: "" } }),
      });
      if (!response.ok) throw new Error(`Fixture config failed: ${response.status}`);
      const status = await response.json();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await settle();
      let finishSave;
      window.ogb = { ...bridge, speechStop: async () => {}, setCredential: () => new Promise((resolve) => { finishSave = resolve; }) };
      document.querySelector('[aria-label="Live call with Pepper"]').click();
      await settle();
      const input = document.querySelector('input[aria-label="OpenAI API key for Live calls"]');
      if (!input) throw new Error("Key prompt did not open");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "sk-fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      input.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      if (!finishSave) throw new Error("Key save was not pending");
      if (action === "dismissal") document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      // Keyboard activation switches chat without the outside-pointer dismissal.
      else select("Fixture Starter");
      await settle();
      if (action === "targetReplacement" && !document.querySelector('[aria-label="Live call with Fixture Starter"]')) throw new Error("Chat did not switch");
      finishSave({ ...status, live: { ...status.live, configured: true } });
      await settle();
      results[action] = { oldPromptDetached: !input.isConnected, microphoneStarts, phase: media.liveMedia().phase };
      if (input.isConnected || microphoneStarts !== 0 || media.liveMedia().phase !== "idle") throw new Error(`${action}: ${JSON.stringify(results[action])}`);
    }
    return results;
  } finally {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await media.hangUpLiveCall();
    media.resetLiveMedia();
    window.ogb = bridge;
    mode.setCallMode(previousMode);
  }
})()
