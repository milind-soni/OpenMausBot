package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import android.graphics.Bitmap
import java.io.File
import org.robolectric.annotation.GraphicsMode
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.unit.dp
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ApprovalLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun screenshot(name: String) {
        val directory = System.getenv("OMB_UI_EVIDENCE_DIR") ?: return
        val file = File(directory, "$name.png")
        file.parentFile?.mkdirs()
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test fun `layout switches sides and compact keeps full answers clickable`() {
        val layout = mutableStateOf(ApprovalLayout.STANDARD)
        var answer: String? = null
        compose.setContent {
            MaterialTheme {
                Box(Modifier.width(300.dp).testTag("container")) {
                    UpdateApprovalButtons(listOf("Allow", "Deny"), layout.value, true) { answer = it }
                }
            }
        }
        screenshot("android-approval-standard")
        val original = compose.onNodeWithText("Allow").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { layout.value = ApprovalLayout.RIGHT_ALIGNED }
        screenshot("android-approval-right")
        val aligned = compose.onNodeWithText("Allow").fetchSemanticsNode().boundsInRoot
        assertTrue(aligned.left > original.left, "Right alignment must move the buttons toward the right edge")
        val deny = compose.onNodeWithText("Deny").fetchSemanticsNode().boundsInRoot
        val container = compose.onNodeWithTag("container").fetchSemanticsNode().boundsInRoot
        assertEquals(container.right, deny.right, 1f)
        compose.runOnIdle { layout.value = ApprovalLayout.COMPACT }
        screenshot("android-approval-compact")
        val compact = compose.onNodeWithText("Deny").fetchSemanticsNode().boundsInRoot
        assertTrue(compact.width < deny.width)
        assertTrue(compact.height >= 48f)
        compose.onNodeWithText("Allow").performClick()
        assertEquals("Allow", answer)
    }

    @Test fun `long choices wrap within the phone and remain disabled while answering`() {
        compose.setContent {
            MaterialTheme {
                Box(Modifier.width(220.dp).testTag("container")) {
                    UpdateApprovalButtons(listOf("Allow this operation", "Always allow this operation", "Deny"), ApprovalLayout.COMPACT, false) {}
                }
            }
        }
        val container = compose.onNodeWithTag("container").fetchSemanticsNode().boundsInRoot
        listOf("Allow this operation", "Always allow this operation", "Deny").forEach { label ->
            val node = compose.onNodeWithText(label)
            node.assertIsNotEnabled()
            val bounds = node.fetchSemanticsNode().boundsInRoot
            assertTrue(bounds.left >= container.left && bounds.right <= container.right)
        }
    }
}
