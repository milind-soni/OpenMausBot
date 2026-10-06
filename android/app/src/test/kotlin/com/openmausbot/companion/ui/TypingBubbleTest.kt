package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The typing bubble says whose it is, in the reader's language: "Pepper is typing"
 * is the whole of what TalkBack hears when the row appears.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TypingBubbleTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>(
        // The dots request frames for as long as they move. The reduce-motion
        // path holds them still, so the rule can reach idle.
        effectContext = object : MotionDurationScale { override val scaleFactor = 0f },
    )

    @Test
    fun theBubbleIsNamedForTheBotThatIsTyping() {
        compose.setContent { WorkingBubble(name = "Maus") }
        compose.onNodeWithContentDescription("Maus is typing").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "zh-rCN")
    fun simplifiedChineseSaysItInChinese() {
        compose.setContent { WorkingBubble(name = "Maus") }
        compose.onNodeWithContentDescription("Maus 正在输入").assertIsDisplayed()
    }
}
