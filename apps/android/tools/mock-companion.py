#!/usr/bin/env python3
"""A faithful stand-in for the OpenMausBot companion, used to exercise the
Android client before a real harness is available. Shapes follow
server/index.ts, shared/wire.ts and companion/src/routes.ts."""
import json, time, threading, queue, uuid, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8810
TOKEN = "omb_pair_" + "A" * 43
CODE = "123456"
CLIENTS = []
BOTS = {}
GROUPS = {}
THREADS = {}


def msg(role, text, kind="text", **extra):
    row = {"id": "m-" + uuid.uuid4().hex[:10], "role": role, "kind": kind,
           "text": text, "createdAt": int(time.time() * 1000)}
    row.update(extra)
    return row


def seed():
    approval = msg("bot", "", kind="options", card={
        "title": "Run a command?",
        "subtitle": "The bot wants to run `npm test` in lemon-code.",
        "options": ["Allow once", "Deny"],
        "requestType": "permission", "requestId": "req-" + uuid.uuid4().hex[:8],
        "tool": "bash", "allowKey": "bash:npm test",
    })
    question = msg("bot", "", kind="options", card={
        "title": "Which folder should I deploy?",
        "subtitle": "Two matching projects exist.",
        "options": ["lemon-code", "book-posters"],
        "requestType": "question", "requestId": "req-" + uuid.uuid4().hex[:8],
    })
    history = [
        msg("user", "Hey Maus, tidy up the release notes."),
        msg("bot", "On it. Here is what I found:\n\n**Release notes** are in `docs/`.\n\n"
                   "1. Two entries name the wrong version\n2. One links a deleted file\n\n"
                   "```bash\nrg -n 'v3\\.[0-9]+' docs/\n```\n\n"
                   "| file | issue |\n|---|---|\n| notes.md | v3.19 |\n| changelog.md | missing |\n\n"
                   "> Want me to rewrite both?"),
        msg("bot", "", kind="activity", tool={"name": "rg", "label": "Searched docs for version strings", "ok": True}),
        approval,
        question,
    ]
    THREADS["t-maus"] = history
    THREADS["t-nova"] = [msg("bot", "I am Nova. Ask me for a plan.")]
    THREADS["t-room"] = [msg("bot", "Room ready.", from_={"botId": "nova", "name": "Nova", "color": "blue"})]
    BOTS["maus"] = {
        "id": "maus", "name": "Maus", "title": "Your right hand", "description": "Runs the workshop.",
        "color": "green", "threadId": "t-maus", "mainThreadId": "t-maus",
        "unread": True, "pinned": True, "hidden": False, "busy": False,
        "activity": "waiting-on-you", "notifications": True,
        "modelSelection": {"instanceId": "claude", "model": "claude-opus-4"},
        "tasks": [{"threadId": "t-maus", "title": "Release notes", "unread": True, "busy": False,
                   "updatedAt": int(time.time() * 1000), "createdAt": int(time.time() * 1000) - 60000,
                   "modelSelection": {"instanceId": "claude", "model": "claude-opus-4"}}],
    }
    BOTS["nova"] = {
        "id": "nova", "name": "Nova", "title": "Planner", "description": "Plans before anyone types.",
        "color": "blue", "threadId": "t-nova", "mainThreadId": "t-nova",
        "unread": False, "pinned": False, "hidden": False, "busy": True,
        "activity": "running", "notifications": True,
        "modelSelection": {"instanceId": "codex", "model": "gpt-5.2"},
        "tasks": [{"threadId": "t-nova", "title": "Q4 plan", "unread": False, "busy": True,
                   "updatedAt": int(time.time() * 1000), "createdAt": int(time.time() * 1000) - 120000,
                   "modelSelection": {"instanceId": "codex", "model": "gpt-5.2"}}],
    }
    GROUPS["room-1"] = {"id": "room-1", "name": "Workshop", "title": "3 bots", "threadId": "t-room",
                        "unread": False, "members": [{"botId": "maus"}, {"botId": "nova"}]}


seed()


def broadcast(frame):
    dead = []
    for client in CLIENTS:
        try:
            client.put_nowait(frame)
        except Exception:
            dead.append(client)
    for client in dead:
        CLIENTS.remove(client)


def wire_bot(bot):
    return bot


class Handler(BaseHTTPRequestHandler):
    # One request per connection keeps the fixture from desyncing on keep-alive.
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        """Body must always be drained, or the next keep-alive request is
        parsed starting inside this one's payload."""
        if hasattr(self, "_body"):
            return self._body
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            self._body = json.loads(raw or b"{}")
        except Exception:
            self._body = {}
        return self._body

    def authorized(self):
        token = (self.headers.get("Authorization") or "").replace("Bearer ", "", 1)
        return token == TOKEN

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path == "/api/health":
            return self.json(200, {"ok": True, "name": "Mock Mac"})
        if not self.authorized():
            return self.json(401, {"error": "pair this phone first"})
        if path == "/api/config":
            return self.json(200, {"computerName": "Mock Mac", "providers": {"claude": True, "codex": True}})
        if path == "/api/instances":
            return self.json(200, {"instances": [
                {"instanceId": "claude", "models": ["claude-opus-4", "claude-sonnet-4"]},
                {"instanceId": "codex", "models": ["gpt-5.2", "gpt-5-mini"]},
            ]})
        if path == "/api/bots":
            return self.json(200, {"bots": list(BOTS.values()), "groups": list(GROUPS.values()),
                                   "sections": [], "computerControl": {}, "botQueuedMessages": {}})
        match = re.match(r"^/api/threads/([\w-]+)/messages$", path)
        if match:
            thread = match.group(1)
            query = parse_qs(url.query)
            limit = int(query.get("limit", ["50"])[0])
            rows = THREADS.get(thread, [])[-limit:]
            return self.json(200, {"messages": rows, "hasMore": len(THREADS.get(thread, [])) > limit})
        if path == "/api/events":
            self.stream_events()
            return
        if path.startswith("/api/attachments/"):
            return self.json(404, {"error": "no such attachment"})
        return self.json(404, {"error": "unknown route " + path})

    def do_POST(self):
        url = urlparse(self.path)
        path = url.path
        if path == "/api/pair":
            body = self.read_json()
            credential = body.get("credential") or body.get("code") or ""
            if credential not in (CODE, TOKEN):
                return self.json(401, {"error": "that code is not valid"})
            return self.json(200, {"token": TOKEN,
                                   "device": {"id": "dev-phone", "name": body.get("deviceName") or "Phone",
                                              "createdAt": int(time.time()), "lastSeenAt": int(time.time())},
                                   "serverName": "Mock Mac"})
        body = self.read_json()
        if not self.authorized():
            return self.json(401, {"error": "pair this phone first"})
        match = re.match(r"^/api/bots/([\w-]+)/messages$", path)
        if match:
            body = self.read_json()
            bot_id = match.group(1)
            thread = body.get("threadId") or BOTS[bot_id]["threadId"]
            text = body.get("text") or ""
            user = msg("user", text)
            THREADS.setdefault(thread, []).append(user)
            broadcast({"kind": "message", "threadId": thread, "message": user})
            threading.Thread(target=self.reply, args=(bot_id, thread, text), daemon=True).start()
            return self.json(202, {"ok": True})
        match = re.match(r"^/api/threads/([\w-]+)/respond$", path)
        if match:
            thread = match.group(1)
            body = self.read_json()
            behavior = body.get("behavior")
            request_id = body.get("requestId")
            for row in THREADS.get(thread, []):
                card = row.get("card")
                if card and card.get("requestId") == request_id:
                    card["answered"] = "allow" if behavior == "allow" else ("deny" if behavior == "deny" else behavior)
                    if behavior == "answer":
                        card["answeredText"] = body.get("message")
                    card["options"] = []
                    broadcast({"kind": "message.patch", "threadId": thread, "message": row})
                    break
            return self.json(200, {"ok": True, "outcome": "allowed-once" if behavior == "allow" else "rejected"})
        match = re.match(r"^/api/bots/([\w-]+)/(interrupt|read|always-allow)$", path)
        if match:
            return self.json(200, {"ok": True})
        match = re.match(r"^/api/bots/([\w-]+)/tasks$", path)
        if match:
            thread = "t-" + uuid.uuid4().hex[:8]
            THREADS[thread] = []
            return self.json(200, {"threadId": thread})
        if path == "/api/bots":
            body = self.read_json()
            bot_id = uuid.uuid4().hex[:8]
            thread = "t-" + bot_id
            THREADS[thread] = [msg("bot", "Hi, I am new here.")]
            BOTS[bot_id] = {"id": bot_id, "name": body.get("name") or "Bot", "title": "", "description": "",
                            "color": "purple", "threadId": thread, "mainThreadId": thread, "unread": False,
                            "pinned": False, "hidden": False, "busy": False, "notifications": True,
                            "modelSelection": {"instanceId": "claude", "model": "claude-opus-4"},
                            "tasks": [{"threadId": thread, "title": "New chat", "unread": False, "busy": False}]}
            broadcast({"kind": "bot", "bot": BOTS[bot_id]})
            return self.json(201, {"bot": BOTS[bot_id]})
        if path == "/api/groups/room-1/messages":
            body = self.read_json()
            thread = body.get("threadId") or "t-room"
            user = msg("user", body.get("text") or "")
            user["from"] = {"botId": "you", "name": "You", "color": "silver"}
            THREADS.setdefault(thread, []).append(user)
            broadcast({"kind": "message", "threadId": thread, "message": user})
            return self.json(202, {"ok": True})
        if path == "/api/attachments":
            return self.json(200, {"url": "/api/attachments/mock.png", "path": "/api/attachments/mock.png"})
        return self.json(404, {"error": "unknown route " + path})

    def do_PATCH(self):
        url = urlparse(self.path)
        path = url.path
        if not self.authorized():
            return self.json(401, {"error": "pair this phone first"})
        body = self.read_json()
        match = re.match(r"^/api/bots/([\w-]+)(/model|/profile)?$", path)
        if match:
            bot_id = match.group(1)
            bot = BOTS.get(bot_id)
            if not bot:
                return self.json(404, {"error": "no such bot"})
            if match.group(2) == "/model":
                bot["modelSelection"] = body.get("modelSelection") or bot["modelSelection"]
            else:
                for key in ("name", "pinned", "hidden", "notifications", "title"):
                    if key in body:
                        bot[key] = body[key]
            broadcast({"kind": "bot", "bot": bot})
            return self.json(200, {"ok": True, "bot": bot})
        return self.json(404, {"error": "unknown route " + path})

    def do_DELETE(self):
        if not self.authorized():
            return self.json(401, {"error": "pair this phone first"})
        return self.json(200, {"ok": True})

    def reply(self, bot_id, thread, text):
        """A streaming turn: a placeholder message patched with growing text,
        exactly the way the harness delivers a reply."""
        placeholder = msg("bot", "")
        placeholder["turnId"] = "turn-" + uuid.uuid4().hex[:6]
        THREADS[thread].append(placeholder)
        broadcast({"kind": "message", "threadId": thread, "message": placeholder})
        sentence = f"Got it — working on \u201c{text[:60]}\u201d.\n\nI will check the **two** files first, then report."
        for index in range(0, len(sentence), 12):
            time.sleep(0.09)
            placeholder["text"] = sentence[: index + 12]
            broadcast({"kind": "message.patch", "threadId": thread, "message": placeholder})
        time.sleep(0.2)
        placeholder["text"] = sentence + "\n\nReady for the next step."
        broadcast({"kind": "message.patch", "threadId": thread, "message": placeholder})
        BOTS[bot_id]["busy"] = False
        broadcast({"kind": "bot", "bot": BOTS[bot_id]})

    def stream_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        queue_ = queue.Queue()
        CLIENTS.append(queue_)
        try:
            self.wfile.write(b"id: 1\ndata: " + json.dumps({"kind": "hello", "resumed": True}).encode() + b"\n\n")
            self.wfile.flush()
            while True:
                try:
                    frame = queue_.get(timeout=20)
                    payload = "id: %d\ndata: %s\n\n" % (int(time.time() * 1000), json.dumps(frame))
                    self.wfile.write(payload.encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except Exception:
            pass
        finally:
            if queue_ in CLIENTS:
                CLIENTS.remove(queue_)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"mock companion on :{PORT}", flush=True)
    server.serve_forever()
