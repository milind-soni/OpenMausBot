# Keep chatting → Bootstrap hybrid plan

**Goal (UX):** Chat feels unlimited. UI history never dies. Backend provider session resets at a **customizable Compact around** ceiling. Continuity survives recycles — especially coding.

**Status:** Plan only (2026-09-11). Fat **state vector (V)** remains shipped path on `keep-chatting` / PR #1080. Bootstrap is the **end shape**; hybrid is how we get there without regressing dogfood.

**Usage handoff rule:** Max Super Grok Plus — if an agent run starts around ~83% usage, **stop by ~95%**, write handoff, pass to OpenMausBot **GrokBot**. Never run to empty.

---

## 1. Intent vs mechanism

| | Today (V) | Target (bootstrap hybrid) |
|---|---|---|
| Host reset at Compact around | Yes (hard cap) | **Keep** |
| UI transcript | Untouched | **Keep** |
| Continuity payload | Fat folded **V** stuffed into next user text | **Thin bootstrap** + memory plane |
| Memory source of truth | Mostly inside V on prompt | **Notebook / facts / Addresses** (+ archives) |
| Codebase knowledge | Hope V remembered it | **Addresses → re-read files** + RAG |

Do **not** outsource compaction to the agent harness (Claude/Codex `/compact` alone). OMB owns reset + memory.

---

## 2. Design: bootstrap hybrid

### Every settle (no compact)
- Append rich turn page → live `notebook.md` (already shipped).
- Update structured pins: Goal, Open, Addresses, landmines, verified facts.
- **Do not** re-inject bootstrap each turn.

### On Compact around (hard fire)
1. Await in-flight notebook write.
2. Archive live notebook → `notebooks/session-NNN.md`.
3. **Hard reset** host (clear resume / session/new) — keep.
4. Build **bootstrap pack** (budgeted) + optional **RAG chunks**.
5. Inject bootstrap (+ chunks) + **live ask** (universal text path; Claude via hostProxy) — keep harness glue.
6. Seed new notebook from bootstrap; continue appending.

### Bootstrap pack (priority)

| Tier | Contents | Rule |
|---|---|---|
| **P0** | Goal, Open/in-flight, exact Addresses, landmines | **Never drop** for size |
| **P1** | Pinned verified facts, catalog index (what exists to fetch) | Prefer keep |
| **P2** | Last-N crumbs / short this-turn | Truncate first |
| **Never in bootstrap** | Full file bodies, whole codebase, long essays | Re-read / retrieve |

**Budget:** hard cap ~5–15% of Compact around (tune in dogfood), fill P0→P1→P2.

### Retrieval awareness (how it knows what to pull)
1. **Catalog** in bootstrap (pointers, not payload).
2. **Host RAG** (OMB): before send, retrieve on live ask + Open + Addresses against notebook/archives; attach top-k.
3. **Address → disk:** cue/enforce re-read listed paths before edit.
4. **Tool recall** (backup): model can `recall` — not the primary path.
5. **Fallback:** low confidence → thicken toward mini-V (never silently worse than today).

---

## 3. Proof gates → ~95% confidence vs fat V

1. **P0 packer** — Goal/Open/Addresses/landmines never dropped  
2. **Harvest gates** — bad pages repaired before compact  
3. **Host RAG** — canaries in top-k after compact #2 and #3  
4. **Address → re-read** — coding continues from real files  
5. **V-fallback** — low confidence thickens; never silent amnesia  
6. **A/B dogfood** — Long Run + Noodle; bootstrap ≤ V on amnesia/soft-park; smaller prompts  
7. **Multi-recycle** — proof on #2 and #3, not only #1  
8. **Both harnesses** — Gemma/Unsloth inject + Claude/Unsloth  

---

## 4. Milestone plan (execution order)

### M0 — Lock & flag (½ day)
- [ ] Feature flag e.g. `bootstrapHybrid` (or reuse/extend experimental Keep chatting settings)
- [ ] Default **off** → behavior = today’s V path
- [ ] Docs: this plan + quality contract one-pager in settings/help later

### M1 — P0 packer + thin inject (1–2 days)
- [ ] `buildBootstrapPack(notebook, pins, budget)` with tiered packer
- [ ] Wire compact path: if flag on → inject bootstrap; else → V
- [ ] Keep universal text inject + hostProxy
- [ ] Unit tests: P0 never truncated; budget respected
- [ ] Package/dogfood: one compact on Long Run or Noodle — continues task

### M2 — Harvest gates (½–1 day)
- [ ] Coding settle without Addresses → repair/reject page
- [ ] Open non-empty when mid-task (existing soft-park rails stay)
- [ ] Tests for gate behavior

### M3 — Catalog + host RAG v0 (2–3 days)
- [ ] Catalog section in bootstrap (archives, topics, top Addresses)
- [ ] Simple retrieve: keyword/embed over notebook + latest archive (start keyword if embed slow)
- [ ] Attach top-k on post-compact turns (and optionally when ask hits catalog)
- [ ] Canary/fact hit-rate checks in dogfood notes

### M4 — Address → re-read cue (½ day)
- [ ] Bootstrap system/continuity line: re-read Addresses before edits
- [ ] Dogfood: Noodle-class coding after compact touches listed paths

### M5 — V-fallback (1 day)
- [ ] Confidence score (retrieve hit / missing P0 / empty Open)
- [ ] Below threshold → attach mini-V or full V once
- [ ] Metrics/log which path fired

### M6 — A/B dogfood to 95% (several days wall-clock)
- [ ] **Gemma 4** (local Gemma 4): fill → compact #2, #3; canaries / continuity (primary local inject)
- [ ] Long Run (prior Gemma path): fill → compact #2, #3; canary F6B3 / vault as needed
- [ ] Noodle (Claude+Unsloth): coding continuity + SPT/hard cap still honest
- [ ] Compare prompt size, soft-park, amnesia vs V flag off
- [ ] Only then consider default-on / PR narrative shift

### M7 — Productize (optional, after proof)
- [ ] Settings copy: Bootstrap hybrid under Experimental
- [ ] Separate PR from UI chrome (#1112); Keep chatting PR #1080 stays V until ready
- [ ] Do **not** combine with mascot sidebar / one-line composer PRs

---

## 5. Non-goals (this phase)
- Replacing hard host reset with soft-only 80% hope  
- Harness-native compact as sole continuity  
- Storing full file contents in bootstrap  
- Blocking #1080 merge on bootstrap (flag off = V)

---

## 6. Done so far (context for GrokBot)

### Shipped / in flight (state vector Keep chatting)
- Rolling notebook append + archive/seed on compact  
- Hard Compact around cap + real session reset  
- Universal state vector on main user `text`; Claude inject via hostProxy  
- SPT vs `lastReportedPromptTokens` usage chip honesty  
- Long Run multi-compact dogfood; Noodle hard-cap + coding-amnesia fixes  
- PR **#1080** Keep chatting only (milind-soni)  
- PR **#1112** UI only: mascot right-sidebar + one-line composer (separate)  
- Local dogfood apps through **0.1.93** (UI accordion collapsed default, etc.)  
- Design consensus (2026-09-11): bootstrap hybrid is better **end** shape; V is proven **now**

### Not started
- All M0–M7 implementation above  
- No `bootstrapHybrid` flag yet  
- No packer / host RAG / V-fallback code  

### Worktree
- Orca: `/Users/maxkongerskov/orca/workspaces/OpenMausBot/Development`  
- Keep chatting branch: `keep-chatting` → also `feat/keep-chatting-onto-main` for #1080  
- UI branch: `ui/mascot-sidebar-one-line-composer` for #1112  
- **Single worktree rule:** all Keep chatting work only in Development  

### User prefs
- Critique as problem→fix; **no code until go** (unless he says begin)  
- If unsure what Max means → ask before implementing  
- Separate PRs: never combine Keep chatting + UI chrome  
- Propose design alternatives early when UX goal is clear  

---

## 7. Handoff template (stop ≤95% usage)

Copy to GrokBot when pausing:

```
HANDOFF → GrokBot (Keep chatting bootstrap hybrid)

Usage: stopped at ~__% Super Grok Plus (limit 95% before empty)

PLAN: docs/keep-chatting/bootstrap-hybrid-plan.md (authoritative)

DONE this session:
- …

NEXT (pick up here):
- [ ] M0 flag …
- [ ] …

DO NOT:
- Merge bootstrap into #1112 / UI PR
- Remove V path until M6 gates pass
- Outsource continuity to harness /compact alone

Dogfood targets: **Gemma 4** (primary local) + Noodle (Claude/Unsloth); Long Run as needed
Developer bot / handoff: **Grok Bot HO**
Canary reference: CANARY_LONGRUN_F6B3 / book-fill thread comps proof pattern
```

---

## 8. First action when Max says go
1. M0 flag on Development `keep-chatting`  
2. M1 packer + thin inject behind flag  
3. Package/dogfood one recycle  
4. Watch usage; at ~95% fill §7 handoff → GrokBot

## 9. Bots for dogfood / handoff

| Role | Bot | Notes |
|---|---|---|
| **Developer / handoff** | **Grok Bot HO** (`15af8ebc-c32f-4c9d-a720-4bbfabc9568c`, thread `fe7247ad-289b-48bf-af97-8475156e7e55`) | Receives plan + done + next near usage limit; continues implementation |
| **Primary local test** | **Gemma 4** | Local Gemma 4 LLM loaded — use for bootstrap hybrid dogfood (fill → compact #2/#3, canaries, continuity) |
| Also keep | Long Run (Gemma inject history) + Noodle (Claude/Unsloth) | Prior proof paths; still use for harness coverage |

Update M6: prefer **Gemma 4** for local inject A/B; keep Noodle for Claude/Unsloth.
