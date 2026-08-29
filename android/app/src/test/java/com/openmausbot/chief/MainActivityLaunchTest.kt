package com.openmausbot.chief

import android.content.Intent
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 28, 33, 35])
class MainActivityLaunchTest {
    @Test
    fun coldLaunchKeepsMainActivityAlive() {
        val context = ApplicationProvider.getApplicationContext<MausApplication>()
        val intent = Intent(context, MainActivity::class.java)

        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            var reachedResumedActivity = false
            scenario.onActivity { activity ->
                reachedResumedActivity = !activity.isFinishing && !activity.isDestroyed
            }
            assertFalse("MainActivity closed during cold launch", !reachedResumedActivity)
        }
    }

    @Test
    fun keyboardResizesChatInsteadOfPanningAwayTheHeader() {
        val context = ApplicationProvider.getApplicationContext<MausApplication>()
        val intent = Intent(context, MainActivity::class.java)

        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            scenario.onActivity { activity ->
                val adjustment = activity.window.attributes.softInputMode and
                    WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST
                assertEquals(
                    "Typing must resize the chat while its navigation stays visible",
                    WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE,
                    adjustment,
                )
            }
        }
    }

    @Test
    fun messageComposerDoesNotDoubleApplyKeyboardInsets() {
        val source = File("src/main/java/com/openmausbot/chief/MainActivity.kt").readText()

        assertTrue(
            "The message composer must retain navigation-bar clearance",
            source.contains("Modifier.fillMaxWidth().padding(12.dp).navigationBarsPadding()"),
        )
        assertFalse(
            "The resized activity must not apply the keyboard height a second time",
            source.contains(".navigationBarsPadding().imePadding()"),
        )
    }

    @Test
    fun chatMessagesSupportSelectionAndOneTapCopy() {
        val source = File("src/main/java/com/openmausbot/chief/MainActivity.kt").readText()

        assertTrue("Message text must support native Android selection handles", source.contains("SelectionContainer"))
        assertTrue("Every textual message must expose an explicit copy action", source.contains("Icons.Default.ContentCopy"))
        assertTrue("Copy must use Android's clipboard", source.contains("clipboard.setClipEntry"))
    }

    @Test
    fun agentPresentationDoesNotDependOnReservedNames() {
        val source = File("src/main/java/com/openmausbot/chief/MainActivity.kt").readText()

        assertFalse("Agent ordering must not reserve the name Chief", source.contains("name.equals(\"Chief\""))
        assertTrue("Agent ordering should preserve user-pinned agents", source.contains("it.pinned == true"))
        assertTrue("The empty state should support arbitrary agent setups", source.contains("Create an agent or import a team"))
    }

    @Test
    fun notificationIntentCarriesItsConversationTarget() {
        val context = ApplicationProvider.getApplicationContext<MausApplication>()
        val intent = Intent(context, MainActivity::class.java)
            .putExtra("botId", "browser-agent")
            .putExtra("threadId", "thread-42")

        assertEquals("browser-agent", notificationBotId(intent))
        assertEquals("thread-42", notificationThreadId(intent))
    }

    @Test
    fun blankNotificationTargetsAreIgnored() {
        val context = ApplicationProvider.getApplicationContext<MausApplication>()
        val intent = Intent(context, MainActivity::class.java)
            .putExtra("botId", " ")
            .putExtra("threadId", "")

        assertEquals(null, notificationBotId(intent))
        assertEquals(null, notificationThreadId(intent))
    }
}
