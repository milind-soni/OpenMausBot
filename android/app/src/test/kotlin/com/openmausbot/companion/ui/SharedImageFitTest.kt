package com.openmausbot.companion.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.*
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A wide screenshot was drawn cropped into a fixed 4:3 window and zoomed far
 * past legible. Every image is now drawn whole at its own shape: the frame
 * takes the bubble's width, stops at 300 dp tall, and narrows to 3:4 for a
 * tall image rather than cropping it. Same shapes as iOS's
 * ImageAttachmentLayoutUITests, on a 393 dp phone.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SharedImageFitTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private var scene: WiringScene? = null

    @After fun cleanup() {
        compose.runOnIdle { scene?.session?.disconnect() }
        server.shutdown()
    }

    @Test fun everyShapeIsDrawnWholeInsideTheBubble() {
        val shapes = listOf(2_400 to 260, 1_600 to 240, 1_920 to 1_080, 1_024 to 1_024, 600 to 1_300, 1_179 to 2_556)
        val served = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path != "/api/threads/first/messages/reply/file") return MockResponse().setResponseCode(404)
                val path = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["path"]?.jsonPrimitive?.content
                val size = path?.removePrefix("/fixture/")?.removeSuffix(".png")?.split("x")?.mapNotNull(String::toIntOrNull)
                if (size?.size != 2) return MockResponse().setResponseCode(404)
                served.incrementAndGet()
                return MockResponse().setHeader("Content-Type", "image/png")
                    .setHeader("Content-Disposition", "attachment; filename=${size[0]}x${size[1]}.png")
                    .setBody(Buffer().write(png(size[0], size[1])))
            }
        }
        server.start()
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val wiring = WiringScene(
            connection = Connection(id = "image-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        val reply = Message(
            "reply", Message.Role.BOT, Message.Kind.TEXT, 1.0,
            text = "Every shape",
            attachments = shapes.map { (w, h) -> MessageImageAttachment("image", "/fixture/${w}x$h.png", "image/png") },
        )
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme(darkTheme = false) {
                    // The transcript's own margins, and room for every card at full height.
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                        MessageRow(Chat.BotChat(fixture), reply)
                    }
                }
            }
        }
        compose.runOnIdle { wiring.session.connect() }
        compose.waitUntil(10_000) { served.get() == shapes.size }
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate), useUnmergedTree = true).fetchSemanticsNodes().isEmpty()
        }

        val density = compose.activity.resources.displayMetrics.density
        val frames = compose.onAllNodesWithTag(SHARED_IMAGE_FRAME_TAG, useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals(shapes.size, frames.size)
        // 393 dp less the 16 dp margins, the bot side's 44 dp gutter and the bubble's 15 dp padding.
        val bubble = 393f - 32f - 44f - 30f
        frames.zip(shapes).forEach { (node, shape) ->
            val (w, h) = shape
            // Laid-out size, not the on-screen bounds: the tall ones run below the window.
            val width = node.size.width / density
            val height = node.size.height / density
            val aspect = AttachmentImageRules.inlineAspect(w, h)!!
            val label = "${w}x$h drawn at ${width}x$height dp"
            assertTrue(width <= bubble + 0.5f, "$label fits the bubble")
            assertTrue(height <= AttachmentImageRules.INLINE_MAX_HEIGHT_DP + 0.5f, "$label stops at the height cap")
            assertTrue((node.positionInRoot.x + node.size.width) / density <= 393f, "$label ends on screen")
            assertEquals(aspect, width / height, 0.02f, "$label keeps the card's shape")
            val expectedWidth = minOf(bubble, AttachmentImageRules.inlineMaxWidthDp(aspect))
            assertEquals(expectedWidth, width, 0.5f, "$label is as wide as the bubble allows")
        }
    }

    private fun png(width: Int, height: Int): ByteArray = ByteArrayOutputStream().also { stream ->
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply {
            eraseColor(android.graphics.Color.BLUE)
            compress(Bitmap.CompressFormat.PNG, 100, stream)
            recycle()
        }
    }.toByteArray()
}
