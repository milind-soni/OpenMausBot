# Avatar attachment lifecycle

Bot avatars intentionally reuse the image attachment store. Upload and GPT
Image output therefore get the same size checks, owner-only filesystem
permissions, immutable serving URL, and raster-only MIME allowlist as message
images.

## Deferred cleanup

Replacing or removing an avatar does **not** delete the prior file yet. The
current attachment record has no provenance: the same generated filename can
be referenced by a bot profile, by one or more persisted messages, or by both.
Deleting a file merely because no current bot uses it could break a historical
message, so broad "unreferenced file" cleanup is not reference-safe.

A future bounded cleanup may delete only files recorded as avatar-owned at
creation time. Before deleting one candidate it must still verify that:

1. no bot has that `avatarUrl`;
2. no active or archived task/room message references its stored path; and
3. the filename belongs to the avatar-owned registry, not the legacy shared
   attachment pool.

Cleanup should process a small fixed number of candidates per run and retain a
grace period. Until that provenance registry exists, retaining an old avatar is
the safe non-destructive behavior.
