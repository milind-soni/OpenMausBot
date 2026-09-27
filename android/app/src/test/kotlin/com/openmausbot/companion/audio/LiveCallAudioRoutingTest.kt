package com.openmausbot.companion.audio

import android.media.AudioDeviceInfo.TYPE_BLE_HEADSET
import android.media.AudioDeviceInfo.TYPE_BLE_SPEAKER
import android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
import android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO
import android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
import android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
import android.media.AudioDeviceInfo.TYPE_HDMI
import android.media.AudioDeviceInfo.TYPE_HEARING_AID
import android.media.AudioDeviceInfo.TYPE_LINE_ANALOG
import android.media.AudioDeviceInfo.TYPE_USB_DEVICE
import android.media.AudioDeviceInfo.TYPE_USB_HEADSET
import android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES
import android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Where a Live call's voice goes. The speaker is on by default (plan Ruling 8),
 * so without the headset rule a person wearing earbuds would hear the bot's
 * replies, which may be private, out loud on the loudspeaker.
 */
class LiveCallAudioRoutingTest {
    private val phone = listOf(TYPE_BUILTIN_EARPIECE, TYPE_BUILTIN_SPEAKER)

    @Test
    fun `with no headset the speaker setting picks the loudspeaker or the earpiece`() {
        assertEquals(TYPE_BUILTIN_SPEAKER, LiveCallAudioRouting.communicationDevice(phone, speaker = true))
        assertEquals(TYPE_BUILTIN_EARPIECE, LiveCallAudioRouting.communicationDevice(phone, speaker = false))
    }

    @Test
    fun `a connected headset takes the call whatever the speaker setting`() {
        for (headset in listOf(
            TYPE_WIRED_HEADSET,
            TYPE_WIRED_HEADPHONES,
            TYPE_USB_HEADSET,
            TYPE_BLE_HEADSET,
            TYPE_BLUETOOTH_SCO,
            TYPE_HEARING_AID,
        )) {
            for (speaker in listOf(true, false)) {
                assertEquals(
                    headset,
                    LiveCallAudioRouting.communicationDevice(phone + headset, speaker),
                    "headset type $headset, speaker=$speaker",
                )
            }
        }
    }

    @Test
    fun `a hearing aid comes first, then a plug, then Bluetooth`() {
        val bluetooth = listOf(TYPE_BLUETOOTH_SCO, TYPE_BLE_HEADSET)
        val everything = phone + bluetooth + listOf(TYPE_USB_HEADSET, TYPE_WIRED_HEADSET, TYPE_HEARING_AID)
        assertEquals(TYPE_HEARING_AID, LiveCallAudioRouting.communicationDevice(everything, speaker = true))
        assertEquals(
            TYPE_WIRED_HEADSET,
            LiveCallAudioRouting.communicationDevice(everything - TYPE_HEARING_AID, speaker = true),
        )
        assertEquals(TYPE_BLE_HEADSET, LiveCallAudioRouting.communicationDevice(phone + bluetooth, speaker = true))
    }

    @Test
    fun `speakers, docks and screens are not headsets`() {
        val shared = phone + listOf(TYPE_BLE_SPEAKER, TYPE_USB_DEVICE, TYPE_HDMI, TYPE_LINE_ANALOG)
        assertEquals(TYPE_BUILTIN_SPEAKER, LiveCallAudioRouting.communicationDevice(shared, speaker = true))
        assertEquals(TYPE_BUILTIN_EARPIECE, LiveCallAudioRouting.communicationDevice(shared, speaker = false))
    }

    @Test
    fun `a missing built-in device leaves the choice to the system`() {
        // A tablet has no earpiece.
        assertNull(LiveCallAudioRouting.communicationDevice(listOf(TYPE_BUILTIN_SPEAKER), speaker = false))
        assertNull(LiveCallAudioRouting.communicationDevice(emptyList(), speaker = true))
    }

    @Test
    fun `below API 31 the speakerphone stays off while a plugged-in headset or a hearing aid is connected`() {
        for (headset in listOf(TYPE_WIRED_HEADSET, TYPE_WIRED_HEADPHONES, TYPE_USB_HEADSET, TYPE_HEARING_AID)) {
            assertFalse(LiveCallAudioRouting.speakerphone(phone + headset, speaker = true), "headset type $headset")
        }
        assertTrue(LiveCallAudioRouting.speakerphone(phone, speaker = true))
        assertFalse(LiveCallAudioRouting.speakerphone(phone, speaker = false))
        // Bluetooth below API 31 needs SCO started by hand, which the route does not do.
        val bluetooth = listOf(TYPE_BLUETOOTH_SCO, TYPE_BLUETOOTH_A2DP)
        assertTrue(LiveCallAudioRouting.speakerphone(phone + bluetooth, speaker = true))
    }
}
