---
name: connected-app-pages
description: "Build a page shown with show_html that reads from, or acts on, the person's connected apps (Gmail, Calendar, Notion, GitHub and others) or their own MCP tools, through tools the page declares. Use when the person asks for a mini app, a tool or a page over their own mail, calendar, tasks or other connected data."
---

# Pages that use connected apps

A page shown with `show_html` can call connected-app tools itself, after it loads and when the person clicks, with no
turn of yours in between. It runs with the person's own connection and your own access to that app: nothing is put in
the page. So the same page works for anyone who opens it with their own accounts, and a page someone shares never
carries an account.

## Declare each tool

Name every tool the page calls in `uses`, exactly, one entry each. No wildcards, at most 8 apps and 24 tools:

- a connected app's tool: `"gmail:GMAIL_FETCH_EMAILS"` (the app's name, a colon, the tool's exact name);
- an MCP tool the person added: `"mcp:notes:search"` (the word mcp, its name in Settings, the tool).

Use the exact tool names you would call yourself; check one you have not used. `uses` can also hold `"data"` and
`"state"`. A replacement without `uses` keeps what the page declared; one with `uses` replaces all of it.

## Call them from the page

- `await mausbot.connectors.list()`: each declared app with `connected` true or false, its `label` and its `tools`.
  Show "Connect Gmail in Apps" (with the label) for one that is not connected, instead of calling it.
- `await mausbot.connectors.call("gmail", "GMAIL_FETCH_EMAILS", { max_results: 10 })`: the tool's answer, the same
  data you would get. A very large answer comes back cut to its first items. Pass values as arguments only.

A tool whose own listing marks it read-only runs on load. Any other tool (sends, labels, moves, deletes, creates) runs
only from a click handler, and only when you are at Full access: below it, or when you ask before sending, the call is
refused with a sentence that says to ask you in the chat. When an app's listing does not mark its reads, even a read
needs a click and Full access: load on a button then. Each call is checked against your access to that app as it is
now, recorded, and limited: about 30 calls a minute per page, a minute each, 64 KB of arguments. A call that is
refused rejects with a plain sentence: show it in the page.

## Example: recent mail, with one button that changes something

```html
<button id="load">Show my inbox</button><ul id="list"></ul><p id="note"></p>
<script>
const note = (text) => { document.getElementById("note").textContent = text; };
async function load() {
  const [gmail] = await mausbot.connectors.list();
  if (!gmail.connected) return note(`Connect ${gmail.label} in Apps to see your mail here.`);
  const data = await mausbot.connectors.call("gmail", "GMAIL_FETCH_EMAILS", { user_id: "me", query: "in:inbox", max_results: 10 });
  const list = document.getElementById("list");
  list.innerHTML = "";
  for (const mail of data.messages ?? []) {
    const row = document.createElement("li");
    row.textContent = `${mail.sender ?? ""}: ${mail.subject ?? "(no subject)"} `;
    const reply = document.createElement("button");
    reply.textContent = "Draft a thank-you";
    reply.onclick = () => mausbot.connectors.call("gmail", "GMAIL_CREATE_EMAIL_DRAFT", {
      user_id: "me", recipient_email: mail.sender, subject: `Re: ${mail.subject}`, body: "Thank you!", thread_id: mail.threadId,
    }).then(() => { reply.textContent = "Drafted"; }, (error) => note(error.message));
    row.append(reply);
    list.append(row);
  }
}
load().catch((error) => note(error.message));
document.getElementById("load").onclick = () => load().catch((error) => note(error.message));
</script>
```

Show it with `uses: ["gmail:GMAIL_FETCH_EMAILS", "gmail:GMAIL_CREATE_EMAIL_DRAFT"]`. The draft button works only at
Full access; say so in one line when you are not. The arguments are the tool's own, as you would send them. A published page cannot call connected apps: keep these pages in the chat.
In a room, pages cannot call them either.
