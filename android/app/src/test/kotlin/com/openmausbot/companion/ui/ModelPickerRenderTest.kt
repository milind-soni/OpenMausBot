package com.openmausbot.companion.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ModelPickerRenderTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `the model field keeps its label separate from the selected model`() {
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                ChoicePicker(
                    label = "Model",
                    choices = listOf(VoiceChoice("test-model", "Test Model", null, true)),
                    selected = "test-model",
                    onSelect = {},
                )
            }
        }
        compose.onNodeWithText("Model").assertIsDisplayed()
        compose.onNodeWithText("Test Model").assertIsDisplayed()
    }
}
