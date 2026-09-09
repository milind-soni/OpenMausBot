package com.openmausbot.companion.core

import kotlinx.serialization.Serializable

/**
 * What the harness says it did with a message the moment it was posted.
 *
 * A send is not one outcome. When the bot is idle the line lands in the
 * transcript and a turn starts. When the bot is mid-turn there are two more:
 * an engine with a live session can take the words INTO the running turn
 * ([Sent.steered]), and one that cannot has the harness hold them
 * off-transcript until the turn settles ([Queued]) — deliberately
 * off-transcript, because a held line appended now would become the active
 * leaf and the rest of the running turn would hang off something the model
 * never saw.
 *
 * The distinction only exists in the POST's 202 body. A client that throws
 * that body away, as this one used to, shows nothing at all for a queued
 * send: the composer clears and the words reappear minutes later, or not at
 * all. So the receipt is the contract, and it is decoded, not ignored.
 */
sealed interface SendReceipt {
    /**
     * In the transcript now. [steered] means it went into a turn that was
     * already running rather than starting one.
     */
    data class Sent(val threadId: String?, val steered: Boolean) : SendReceipt

    /** Held in the harness's steer queue until the current turn settles. */
    data class Queued(val queueId: String, val threadId: String) : SendReceipt
}

/**
 * The 202 body, read leniently. Every field is optional on purpose: a harness
 * older than this app answers `{ok:true}` and nothing else, and that is a
 * plain send, not a failure.
 */
@Serializable
data class SendReceiptBody(
    val threadId: String? = null,
    val queued: Boolean? = null,
    val queueId: String? = null,
    val steered: Boolean? = null,
) {
    fun receipt(): SendReceipt =
        if (queued == true && queueId != null && threadId != null) {
            SendReceipt.Queued(queueId, threadId)
        } else {
            SendReceipt.Sent(threadId, steered == true)
        }
}

/** A message waiting in the harness's steer queue, as this client knows it. */
data class QueuedSend(val queueId: String, val text: String)
