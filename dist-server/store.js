// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { mkdirSync, unlinkSync } from "node:fs";
import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { newId } from "./contracts.js";
import { pickBotName } from "./names.js";
const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const messagesFile = (threadId) => join(DATA_DIR, `messages-${threadId}.json`);
const COLORS = [
    "green",
    "blue",
    "red",
    "orange",
    "purple",
    "cyan",
    "pink",
    "yellow",
    "teal",
    "coral",
];
/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, names match case-insensitively, longest name wins (so "@New Bot 2"
 * never half-matches "New Bot"), hidden bots skipped, results deduped.
 * Callers pre-filter the sender out of `peers`. */
export function mentionedBots(text, peers) {
    const candidates = peers
        .filter((p) => !p.hidden && p.name.trim())
        .sort((a, b) => b.name.length - a.name.length);
    const lower = text.toLowerCase();
    const found = [];
    let at = -1;
    while ((at = lower.indexOf("@", at + 1)) !== -1) {
        if (at > 0 && !/[\s*_~([>{]/.test(text[at - 1]))
            continue; // user@host and mid-word @ are not tags
        const rest = lower.slice(at + 1);
        const hit = candidates.find((p) => rest.startsWith(p.name.toLowerCase()));
        if (hit && !found.includes(hit))
            found.push(hit);
    }
    return found;
}
export function automaticHandoffBots(enabled, text, peers) {
    if (!enabled)
        return [];
    const textWithoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
    return mentionedBots(textWithoutCode, peers);
}
const onboardingCard = () => ({
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});
export class Store {
    bots = [];
    groups = [];
    threads = new Map();
    defaultSelection;
    constructor(defaultSelection) {
        this.defaultSelection = defaultSelection;
        mkdirSync(DATA_DIR, { recursive: true });
        this.bots = readJsonFile(BOTS_FILE, []);
        this.groups = readJsonFile(GROUPS_FILE, []);
        // busy never survives a restart — no turn does either
        for (const b of this.bots)
            b.busy = false;
        for (const g of this.groups) {
            g.autoHandoffs = g.autoHandoffs === true;
            g.busyBotId = null;
            g.queuedBotIds = [];
        }
    }
    saveBots() {
        writeJsonAtomic(BOTS_FILE, this.bots);
    }
    saveGroups() {
        writeJsonAtomic(GROUPS_FILE, this.groups.map(({ busyBotId, queuedBotIds, ...g }) => g));
    }
    // ── groups ────────────────────────────────────────────────────────────
    group(id) {
        return this.groups.find((g) => g.id === id);
    }
    groupByThread(threadId) {
        return this.groups.find((g) => g.threadId === threadId);
    }
    createGroup(name, memberIds, dm = false) {
        const group = {
            id: newId(),
            threadId: newId(),
            name,
            memberIds,
            bulletin: "",
            autoHandoffs: false,
            unread: false,
            createdAt: Date.now(),
            dm: dm || undefined,
            busyBotId: null,
            queuedBotIds: [],
        };
        this.groups.unshift(group);
        this.saveGroups();
        return group;
    }
    /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
    dmGroup(a, b) {
        return this.groups.find((g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b));
    }
    patchGroup(id, patch) {
        const group = this.group(id);
        if (!group)
            return null;
        Object.assign(group, patch);
        this.saveGroups();
        return group;
    }
    deleteGroup(id) {
        const group = this.group(id);
        if (!group)
            return false;
        this.groups = this.groups.filter((g) => g.id !== id);
        this.threads.delete(group.threadId);
        this.saveGroups();
        try {
            unlinkSync(messagesFile(group.threadId));
        }
        catch { }
        return true;
    }
    /** Toggle an emoji reaction on a message ("user" or a member botId). */
    toggleReaction(threadId, messageId, emoji, by) {
        const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
        if (!existing)
            return null;
        const reactions = existing.reactions ?? [];
        const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
        const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
        return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
    }
    thread(threadId) {
        let t = this.threads.get(threadId);
        if (t)
            return t;
        let messages = [];
        let activeLeafId = null;
        const raw = readJsonFile(messagesFile(threadId), null);
        if (Array.isArray(raw))
            messages = raw; // pre-branching flat file
        else if (raw) {
            messages = raw.messages ?? [];
            activeLeafId = raw.activeLeafId ?? null;
        }
        // legacy rows carry no parentId — chain them in array order
        let prev = null;
        for (const m of messages) {
            if (m.parentId === undefined)
                m.parentId = prev;
            prev = m.id;
        }
        if (!activeLeafId)
            activeLeafId = messages.at(-1)?.id ?? null;
        t = { messages, activeLeafId };
        this.threads.set(threadId, t);
        return t;
    }
    saveThread(threadId) {
        const t = this.thread(threadId);
        writeJsonAtomic(messagesFile(threadId), { activeLeafId: t.activeLeafId, messages: t.messages });
    }
    messagesFor(threadId) {
        return this.thread(threadId).messages;
    }
    activeLeaf(threadId) {
        return this.thread(threadId).activeLeafId;
    }
    /** Keep a thread addressable while irreversibly replacing its transcript. */
    clearThread(threadId) {
        this.threads.set(threadId, { messages: [], activeLeafId: null });
        this.saveThread(threadId);
        const bot = this.botByThread(threadId);
        if (bot) {
            bot.resumeCursors = {};
            bot.rewound = false;
            bot.unread = false;
            this.saveBots();
        }
        const group = this.groupByThread(threadId);
        if (group) {
            group.unread = false;
            this.saveGroups();
        }
    }
    /** The visible conversation: root → activeLeafId. */
    activePath(threadId) {
        const t = this.thread(threadId);
        const byId = new Map(t.messages.map((m) => [m.id, m]));
        const path = [];
        let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
        while (cur) {
            path.push(cur);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return path.reverse();
    }
    appendMessage(threadId, message) {
        const t = this.thread(threadId);
        const full = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...message };
        t.messages.push(full);
        t.activeLeafId = full.id;
        this.saveThread(threadId);
        return full;
    }
    /** Fork the conversation: a new user message that replaces `sourceId`
     * (same parent, new text) and becomes the active leaf. */
    branchMessage(threadId, sourceId, text, attachments) {
        const t = this.thread(threadId);
        const source = t.messages.find((m) => m.id === sourceId);
        if (!source)
            return null;
        const full = {
            id: newId(),
            at: Date.now(),
            role: "user",
            kind: "text",
            text,
            attachments: attachments !== undefined ? attachments : source.attachments,
            parentId: source.parentId ?? null,
        };
        t.messages.push(full);
        t.activeLeafId = full.id;
        this.saveThread(threadId);
        return full;
    }
    /** Point the visible conversation at the branch containing `messageId`,
     * descending to that branch's most recently active leaf. */
    setActiveLeaf(threadId, messageId) {
        const t = this.thread(threadId);
        if (!t.messages.some((m) => m.id === messageId))
            return null;
        let cur = messageId;
        for (;;) {
            const children = t.messages.filter((m) => m.parentId === cur);
            if (!children.length)
                break;
            cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
        }
        t.activeLeafId = cur;
        this.saveThread(threadId);
        return cur;
    }
    patchMessage(threadId, messageId, patch) {
        const t = this.thread(threadId);
        const idx = t.messages.findIndex((m) => m.id === messageId);
        if (idx === -1)
            return null;
        t.messages[idx] = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
        this.saveThread(threadId);
        return t.messages[idx];
    }
    bot(id) {
        return this.bots.find((b) => b.id === id) ?? null;
    }
    botByThread(threadId) {
        return this.bots.find((b) => b.threadId === threadId) ?? null;
    }
    createBot() {
        const name = pickBotName(this.bots.map((b) => b.name));
        const bot = {
            id: newId(),
            threadId: newId(),
            name,
            title: "",
            description: "",
            notifications: true,
            color: COLORS[this.bots.length % COLORS.length],
            unread: false,
            modelSelection: this.defaultSelection(),
            resumeCursors: {},
            createdAt: Date.now(),
        };
        this.bots.unshift(bot);
        this.saveBots();
        this.appendMessage(bot.threadId, {
            role: "bot",
            kind: "text",
            text: `Hey — I'm ${name}. Nice to meet you.`,
        });
        this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
        return bot;
    }
    deleteBot(id) {
        const bot = this.bot(id);
        if (!bot)
            return false;
        this.bots = this.bots.filter((b) => b.id !== id);
        this.threads.delete(bot.threadId);
        this.saveBots();
        try {
            unlinkSync(messagesFile(bot.threadId));
        }
        catch { }
        return true;
    }
    patchBot(id, patch) {
        const bot = this.bot(id);
        if (!bot)
            return null;
        Object.assign(bot, patch);
        this.saveBots();
        return bot;
    }
    setResumeCursor(botId, instanceId, cursor) {
        const bot = this.bot(botId);
        if (!bot)
            return;
        bot.resumeCursors[instanceId] = cursor;
        this.saveBots();
    }
    /** First-run seed: one bot so the app never opens empty — it gets a
     * random friendly name like every other bot. */
    seedIfEmpty() {
        if (this.bots.length)
            return;
        this.createBot();
    }
}
