self.addEventListener("push", (event) => {
  if (!event.data) return;
  const { title, body, messageId, threadId, botId, silent } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: messageId, icon: "/app-icon-192.png", silent, data: { threadId, botId },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { threadId, botId } = event.notification.data;
  const query = new URLSearchParams({ thread: threadId, bot: botId });
  event.waitUntil(clients.openWindow("/?" + query));
});
