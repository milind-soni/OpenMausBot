# Meeting notes

A bot can join an online meeting from its cloud computer, take notes, answer questions in the meeting chat and post a
**Meeting notes** card when it ends.

## What people see

- Ask a bot "join this meeting and take notes: <link>". Google Meet, Microsoft Teams and Jitsi links work; Zoom links
  get "Zoom meetings aren't supported yet."
- The bot joins as **"<Bot name> (notes)"** ("<Bot name> notes" on Teams, which refuses brackets in guest names), with
  mic and camera off, and waits up to 10 minutes for the host to let it in.
- The moment it is in, it posts one line in the meeting chat: *"Hi, I'm <Bot> (notes) from MausBot, taking notes for
  <person>. Ask me with @notes. Type "@notes stop" and I'll leave."* Nothing is captured before that line is posted; if
  it can't be posted, the bot leaves.
- `@notes <question>` in the meeting chat gets a short answer there. Posting in the chat follows the bot's **Sending on
  your behalf** setting, like any message it sends for the person.
- A live card in the conversation shows where it is (waiting for the host, in the meeting, ended) with a **Leave
  meeting** button. When the meeting ends the bot writes the notes: summary, decisions, action items with owners, open
  questions and attendees, with the full transcript attached.
- "Join my meetings and take notes" is an opt-in routine (ask the bot for it) that joins Google Calendar meetings with a
  Meet or Teams link as they start.

## Speech-to-text and keys

**The project's hosted ElevenLabs key is used only for MausBot Cloud plans**, through the Cloud's Admin voice relay,
metered from the plan's monthly voice allowance. When that allowance is used up the card says so plainly; the bot
never switches to another service on its own. The person can ask for transcription on the cloud computer itself
instead.

Everyone else uses their own keys, in this order, from the keys already in Settings (nothing new to enter):

1. their **ElevenLabs** key (Settings → Voice): realtime transcription;
2. their **Groq** key: `whisper-large-v3-turbo`;
3. their **OpenAI** key: `whisper-1`;
4. otherwise **Whisper on the cloud computer** (faster-whisper `small.en`, CPU), which installs itself on first use;
   the card shows "Setting up transcription (one-time, about a minute)…".

No provider key ever reaches the cloud computer. ElevenLabs gives the computer single-use 15-minute tokens minted on the
MausBot server (or by the Cloud's relay). With Groq or OpenAI, the computer cuts the meeting audio into short pieces at
the pauses and hands them back to the MausBot server over the same channel it reports events on; the server
transcribes them and hands the words back, so the computer can label each word with who was speaking.

## Limits

- Meetings run on a Linux cloud computer (Boat); a person's own Mac or PC isn't a meeting computer yet.
- Hosts must admit the bot. Google Meet often refuses guests from cloud networks ("You can't join this video call");
  the bot can also run with a Chrome profile signed in to a Google account, which is still being tried live.
- A meeting stops after 4 hours.
