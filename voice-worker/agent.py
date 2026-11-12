"""OpenMausBot's LiveKit voice worker: Deepgram nova-3 ears, an OpenRouter live-tier
brain, Deepgram aura-2 speech, Silero turn detection with barge-in. A Twilio call is
bridged here by the app's telephony door (LIVEKIT_SIP_URI); everything the call hears
and says is posted to the app's ingest door so it lands in the same cross-channel
store as the desktop chat and SMS.
"""

import asyncio
import logging
import os
import uuid
from typing import Any

import aiohttp
from dotenv import load_dotenv

from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.agents.llm import function_tool
from livekit.plugins import deepgram, openai, silero

logger = logging.getLogger("voice-worker")

load_dotenv()

OPENROUTER_API_KEY = os.getenv("OMB_OPENROUTER_API_KEY") or os.getenv("OPENROUTER_API_KEY") or ""
LIVE_MODEL = os.getenv("VOICE_LIVE_MODEL", "openai/gpt-6-luna")
DEEPGRAM_API_KEY = os.getenv("OMB_DEEPGRAM_API_KEY") or os.getenv("DEEPGRAM_API_KEY") or ""
TTS_MODEL = os.getenv("VOICE_TTS_MODEL", "aura-2-asteria-en")
INGEST_URL = os.getenv("TELEPHONY_INGEST_URL", "").rstrip("/")
INGEST_TOKEN = os.getenv("TELEPHONY_INGEST_TOKEN", "")

OWNER_NUMBER = os.getenv("USER_AUTHORIZED_PHONE_NUMBER", "")
BOT_NUMBER = os.getenv("TWILIO_PHONE_NUMBER", "")

INSTRUCTIONS = (
    "You are OpenMausBot, the owner's assistant, on a phone call. "
    "Reply in plain spoken words only: no markdown, bullets, links, emoji or special characters. "
    "Keep every answer under 60 words. Be warm and direct. "
    "Remember anything worth keeping across calls and messages with the remember tool."
)


class MemoryBridge:
    """Posts what the call hears and says into the app's shared telephony store."""

    def __init__(self, call_id: str) -> None:
        self.call_id = call_id
        self.session = aiohttp.ClientSession()

    async def close(self) -> None:
        await self.session.close()

    async def post(self, payload: dict[str, Any]) -> None:
        if not INGEST_URL or not INGEST_TOKEN:
            return
        try:
            await self.session.post(
                INGEST_URL,
                json=payload,
                headers={"Authorization": f"Bearer {INGEST_TOKEN}"},
                timeout=aiohttp.ClientTimeout(total=5),
            )
        except Exception:
            logger.exception("ingest post failed")

    def record_turn(self, who: str, text: Any) -> None:
        if isinstance(text, list):
            text = " ".join(str(part) for part in text)
        if isinstance(text, str) and text.strip():
            asyncio.create_task(self.post({"kind": "turn", "callId": self.call_id, "who": who, "text": text}))


def _remember_factory(bridge: MemoryBridge):
    @function_tool
    async def remember(text: str) -> str:
        """Save a fact about the owner for future calls and messages.

        Args:
            text: The fact to remember, one short sentence.
        """
        await bridge.post({"kind": "fact", "text": text})
        return "remembered"

    return remember


class AssistantAgent(Agent):
    def __init__(self, bridge: MemoryBridge) -> None:
        super().__init__(instructions=INSTRUCTIONS, tools=[_remember_factory(bridge)])


async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    call_id = f"call_worker_{uuid.uuid4().hex[:12]}"
    bridge = MemoryBridge(call_id)
    ctx.add_shutdown_callback(bridge.close)

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=deepgram.STT(model="nova-3", api_key=DEEPGRAM_API_KEY or None),
        tts=deepgram.TTS(model=TTS_MODEL, api_key=DEEPGRAM_API_KEY or None),
        llm=openai.LLM(
            model=LIVE_MODEL,
            api_key=OPENROUTER_API_KEY or None,
            base_url="https://openrouter.ai/api/v1",
        ),
        allow_interruptions=True,
    )

    @session.on("conversation_item_added")
    def _on_item(event) -> None:
        item = event.item
        if item.role == "user":
            bridge.record_turn("caller", item.text_content)
        elif item.role == "assistant":
            bridge.record_turn("bot", item.text_content)

    @ctx.add_shutdown_callback
    async def _record_end() -> None:
        await bridge.post({"kind": "call_end", "callId": call_id, "status": "done"})

    await session.start(room=ctx.room, agent=AssistantAgent(bridge))
    await bridge.post({"kind": "call", "id": call_id, "from": OWNER_NUMBER, "to": BOT_NUMBER})


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
