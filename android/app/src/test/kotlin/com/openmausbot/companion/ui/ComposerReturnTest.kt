package com.openmausbot.companion.ui

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ComposerReturnTest {
    @Test
    fun hardwareReturnSends() {
        assertTrue(ComposerReturn.sends(isReturnKey = true, keyDown = true, shift = false, fromSoftwareKeyboard = false))
    }

    @Test
    fun hardwareShiftReturnBreaksTheLine() {
        assertFalse(ComposerReturn.sends(isReturnKey = true, keyDown = true, shift = true, fromSoftwareKeyboard = false))
    }

    @Test
    fun softwareKeyboardReturnBreaksTheLine() {
        assertFalse(ComposerReturn.sends(isReturnKey = true, keyDown = true, shift = false, fromSoftwareKeyboard = true))
    }

    @Test
    fun keyUpAndOtherKeysAreLeftAlone() {
        assertFalse(ComposerReturn.sends(isReturnKey = true, keyDown = false, shift = false, fromSoftwareKeyboard = false))
        assertFalse(ComposerReturn.sends(isReturnKey = false, keyDown = true, shift = false, fromSoftwareKeyboard = false))
    }
}
