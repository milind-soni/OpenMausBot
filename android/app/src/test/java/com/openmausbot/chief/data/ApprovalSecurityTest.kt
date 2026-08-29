package com.openmausbot.chief.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalSecurityTest {
    @Test
    fun denyIsAlwaysImmediateEvenForToolCards() {
        val card = OptionCard(tool = "shell", allowKey = "shell:git")
        assertFalse(ApprovalSecurity.requiresBiometric(card, "Deny"))
        assertFalse(ApprovalSecurity.requiresBiometric(card, "deny this request"))
        assertFalse(ApprovalSecurity.requiresBiometric(card, "Reject"))
    }

    @Test
    fun allowAndAlwaysAllowRequireAuthenticationForToolCards() {
        val card = OptionCard(tool = "shell", allowKey = "shell:git")
        assertTrue(ApprovalSecurity.requiresBiometric(card, "Allow"))
        assertTrue(ApprovalSecurity.requiresBiometric(card, "Always allow"))
    }

    @Test
    fun informationalCardsDoNotRequireAuthentication() {
        assertFalse(ApprovalSecurity.requiresBiometric(OptionCard(options = listOf("Yes", "No")), "Yes"))
    }
}
