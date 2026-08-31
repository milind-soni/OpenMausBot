# Channels

## Sub-features

- Create a channel from existing bots.
- Send to its active task.
- Wait for the room-level run rather than one member's transient state.
- Read a bounded channel transcript.

## User path

Create a channel from the sidebar, choose its members, and send a message in
the channel composer.

## Driving it

Create two fixture bots with `new-bot`, then:

```sh
pnpm control:omb new-channel --name Review --members BOT_A_ID,BOT_B_ID --url http://127.0.0.1:PORT
# Copy channel.id from the JSON above as CHANNEL_ID.
pnpm control:omb send-channel --channel CHANNEL_ID --text "Reply once" --url http://127.0.0.1:PORT
pnpm control:omb wait --channel CHANNEL_ID --timeout 60 --url http://127.0.0.1:PORT
pnpm control:omb messages --channel CHANNEL_ID --limit 20 --url http://127.0.0.1:PORT
```

Capture the returned channel ID from `new-channel`. The wait result must be
`settled`; the transcript is the evidence.

## Gotchas

- Do not wait directly on a bot while it is speaking for a channel.
- A confirmation card produces `needs-user`; it is not a timeout.
- This first map does not claim to verify channel layout or sidebar UI.
