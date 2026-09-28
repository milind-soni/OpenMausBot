package com.openmausbot.companion.ui

/**
 * Which Return presses send the draft.
 *
 * Only a hardware Return without Shift: the phone's own keyboard inserts a
 * newline, like Messages, and the arrow button on the chat bar is the one send.
 * Kept outside Compose so the rule is testable without a key event.
 */
object ComposerReturn {
    fun sends(
        isReturnKey: Boolean,
        keyDown: Boolean,
        shift: Boolean,
        fromSoftwareKeyboard: Boolean,
    ): Boolean = isReturnKey && keyDown && !shift && !fromSoftwareKeyboard
}
