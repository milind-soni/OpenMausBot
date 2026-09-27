package com.openmausbot.companion.audio

import com.openmausbot.companion.core.CompanionJson
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** One data-channel event, reduced to what the bar and the manager need. */
data class LiveChannelEvent(val type: String, val delta: String?, val reason: String?)

/** The captions rule, the same as the desktop's `applyCaption` (`src/lib/live-call-media.ts`). */
object LiveCaptions {
    /** Null for anything that is not a JSON object with a string `type`. */
    fun parse(text: String): LiveChannelEvent? = runCatching {
        val value = CompanionJson.parseToJsonElement(text).jsonObject
        val type = value["type"]?.jsonPrimitive?.contentOrNull ?: return@runCatching null
        LiveChannelEvent(
            type = type,
            delta = value["delta"]?.jsonPrimitive?.contentOrNull,
            reason = value["reason"]?.jsonPrimitive?.contentOrNull,
        )
    }.getOrNull()

    /** The voice's words replace what the person was saying; the person's words accumulate while they speak. */
    fun apply(caption: String, heard: String, event: LiveChannelEvent): Pair<String, String> = when (event.type) {
        "session.output_transcript.delta" ->
            (caption + event.delta.orEmpty()).takeLast(LiveCallSnapshot.CAPTION_CHARS) to ""
        "session.input_transcript.delta" ->
            caption to (heard + event.delta.orEmpty()).takeLast(LiveCallSnapshot.HEARD_CHARS)
        else -> caption to heard
    }
}
