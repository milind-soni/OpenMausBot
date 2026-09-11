# Keep chatting — 2-compact baseline

Return point before micro state vectors. Branch `keep-chatting`, tag `keep-chatting-2compact-baseline`.

## Live proof (2026-09-10, Unsloth Gemma / Long Run)

- Bot: Long Run · canary `CANARY_LONGRUN_F6B3` · vault `/tmp/omb-vault-longrun-f6b3`
- Auto ceiling 128k (fire ~102.4k); same chat kept across recycles
- **Compact #1:** tokensBefore ~102.8k → SPT ~107; canary + vault in state vector
- **Compact #2:** tokensBefore ~104.8k → SPT ~162; canary + vault in state vector

## Included on this baseline

- Core Unsloth recycle + state-vector inject + host-proxy rebind
- Needle-only compact-turn clip (later fat pastes stay full)
- UNIQUE/pad demotion from Goal/Next
- Keep chatting **Off** kill switch
- `fillTokensFor` counts current paste on top of SPT
- Inflated Unsloth cumulative usage clamped to recycle ceiling

## Not in this baseline (next)

- Micro state vectors (Settings toggle; per-turn `.md` ledger; final compact reads ledger + prior vector + tail)
- Merge-from-prior so early truths are not dropped on rewrite
