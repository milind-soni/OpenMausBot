/** Main-process listener remains alive while the optional tray is running. No model calls. */
export function startScheduleNotifications(baseUrl, Notification) {
  const controller = new AbortController();
  let retry;
  const connect = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/events?notifications=1`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("Notifications unavailable");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n"); buffer = frames.pop() ?? "";
        if (buffer.length > 1_000_000) buffer = "";
        for (const frame of frames) {
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (!data) continue;
          let event; try { event = JSON.parse(data.slice(6)); } catch { continue; }
          if (event.kind === "schedule.started" && event.notify === true && Notification.isSupported()) new Notification({ title: "Scheduled task started", body: `${String(event.name ?? "Your Buddy").slice(0, 200)} started its scheduled task.` }).show();
        }
      }
    } catch { /* reconnect while the app is running */ }
    if (!controller.signal.aborted) retry = setTimeout(connect, 5000);
  };
  void connect();
  return () => { controller.abort(); clearTimeout(retry); };
}
