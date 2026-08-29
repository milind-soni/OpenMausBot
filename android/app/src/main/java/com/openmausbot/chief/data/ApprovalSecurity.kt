package com.openmausbot.chief.data

/** Centralized, testable policy for phone-side approval authentication. */
object ApprovalSecurity {
    fun isDeny(choice: String): Boolean {
        val normalized = choice.trim()
        return normalized.equals("deny", ignoreCase = true) ||
            normalized.startsWith("deny ", ignoreCase = true) ||
            normalized.equals("reject", ignoreCase = true)
    }

    fun requiresBiometric(card: OptionCard, choice: String): Boolean =
        !isDeny(choice) && (card.tool != null || card.allowKey != null || card.held != null)
}
