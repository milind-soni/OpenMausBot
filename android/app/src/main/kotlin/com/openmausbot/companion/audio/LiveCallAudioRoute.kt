package com.openmausbot.companion.audio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Where a Live call's audio goes and who owns it: MODE_IN_COMMUNICATION for
 * the call's lifetime, voice-communication audio focus (voice notes and
 * previews pause on it, as they already do for dictation), and the route.
 * A headset the person has on (wired, USB, Bluetooth, a hearing aid) always
 * takes the call, so the bot's replies are not played out loud to the room
 * while earbuds are in; the speaker setting only chooses between the
 * loudspeaker and the earpiece when no headset is connected. Behind an
 * interface so the manager's tests need no AudioManager. Needs
 * MODIFY_AUDIO_SETTINGS, declared in the manifest.
 */
interface LiveCallAudioRoute {
    /**
     * Take the mode, the focus and the first route. [onFocusLost] fires when
     * another app takes the audio for good or for a while (a phone call);
     * a chime that may duck the call is not reported.
     */
    fun begin(speaker: Boolean, onFocusLost: () -> Unit)

    /**
     * The loudspeaker (true) or the earpiece (false) while no headset is
     * connected. Before [begin] it is only remembered.
     */
    fun setSpeaker(speaker: Boolean)

    /** Give it all back. Safe without [begin]. */
    fun end()
}

/**
 * The routing rule, kept apart from AudioManager so a plain JVM test can pin
 * it. Device types are `AudioDeviceInfo.TYPE_*` values: compile-time
 * constants that are only compared, so the newer ones (`TYPE_HEARING_AID`,
 * API 28; `TYPE_BLE_HEADSET`, API 31) are safe on older phones, which never
 * list such a device.
 */
@SuppressLint("InlinedApi")
internal object LiveCallAudioRouting {
    /**
     * Devices the person wears or has plugged in, most preferred first. The
     * order is close to Android's own call routing: a hearing aid, then a
     * plug, then Bluetooth, which can stay connected while not being worn.
     */
    val HEADSETS: List<Int> = listOf(
        AudioDeviceInfo.TYPE_HEARING_AID,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    )

    /**
     * The headsets the system routes a call to by itself once the
     * speakerphone is off. Below API 31, Bluetooth also needs SCO started by
     * hand, which this route does not do.
     */
    private val SELF_ROUTED: List<Int> = listOf(
        AudioDeviceInfo.TYPE_HEARING_AID,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
    )

    /**
     * API 31 and up: the type of the communication device to select from
     * [available], or null to leave the choice to the system (for example a
     * tablet that has no earpiece).
     */
    fun communicationDevice(available: List<Int>, speaker: Boolean): Int? {
        HEADSETS.firstOrNull { it in available }?.let { return it }
        val builtIn = if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        return builtIn.takeIf { it in available }
    }

    /**
     * API 26 to 30: whether to turn the speakerphone on. It stays off while a
     * headset from [SELF_ROUTED] is among [outputs], because a forced
     * speakerphone would override that headset.
     */
    fun speakerphone(outputs: List<Int>, speaker: Boolean): Boolean = speaker && SELF_ROUTED.none { it in outputs }
}

internal class AndroidLiveCallAudioRoute(context: Context) : LiveCallAudioRoute {
    private val audioManager = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null

    /** The last speaker setting; applied whenever the route is recomputed. */
    private var speaker = true

    /** Between [begin] and [end]: the route is ours to set. */
    private var routing = false

    private val attributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /**
     * Earbuds that connect mid-call take the call, and a pulled plug hands it
     * back to the speaker setting. An explicitly selected device (the
     * loudspeaker) would otherwise keep the call after a headset arrives.
     */
    private val deviceChanges = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = route()

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = route()
    }

    override fun begin(speaker: Boolean, onFocusLost: () -> Unit) {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener { change ->
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> onFocusLost()
                }
            }
            .build()
        focusRequest = request
        // Refused while a phone or VoIP call holds the audio: this call must
        // not share the microphone and route with it, and no loss will ever
        // come for focus that was never granted.
        if (audioManager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            focusRequest = null
            onFocusLost()
            return
        }
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        this.speaker = speaker
        routing = true
        route()
        // The main looper, where the manager calls begin, setSpeaker and end,
        // so a device change never runs in the middle of one of them.
        audioManager.registerAudioDeviceCallback(deviceChanges, Handler(Looper.getMainLooper()))
    }

    override fun setSpeaker(speaker: Boolean) {
        this.speaker = speaker
        route()
    }

    override fun end() {
        if (routing) audioManager.unregisterAudioDeviceCallback(deviceChanges)
        routing = false
        if (Build.VERSION.SDK_INT >= 31) audioManager.clearCommunicationDevice()
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = false
        audioManager.mode = AudioManager.MODE_NORMAL
        focusRequest?.let(audioManager::abandonAudioFocusRequest)
        focusRequest = null
    }

    /**
     * Apply [LiveCallAudioRouting] to the devices connected now. A device
     * change already queued when [end] ran finds [routing] false and does
     * nothing.
     */
    private fun route() {
        if (!routing) return
        if (Build.VERSION.SDK_INT >= 31) {
            val available = audioManager.availableCommunicationDevices
            val wanted = LiveCallAudioRouting.communicationDevice(available.map { it.type }, speaker)
            val device = available.firstOrNull { it.type == wanted }
            if (device != null) audioManager.setCommunicationDevice(device) else audioManager.clearCommunicationDevice()
            return
        }
        val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = LiveCallAudioRouting.speakerphone(outputs, speaker)
    }
}
