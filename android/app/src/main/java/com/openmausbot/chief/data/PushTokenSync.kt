package com.openmausbot.chief.data

import com.google.firebase.messaging.FirebaseMessaging

/** Starts Firebase's installation registration; callbacks deliver the target. */
object PushTokenSync {
    fun register() { runCatching { FirebaseMessaging.getInstance().register() } }
}
