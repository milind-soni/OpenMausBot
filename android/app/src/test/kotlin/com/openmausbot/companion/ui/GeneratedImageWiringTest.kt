package com.openmausbot.companion.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openmausbot.companion.core.*
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentLinkedQueue
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
import kotlin.test.assertNotNull

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GeneratedImageWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private val requests = ConcurrentLinkedQueue<RecordedRequest>()
    private var scene: WiringScene? = null

    @After fun cleanup() {
        compose.runOnIdle { scene?.session?.disconnect() }
        server.shutdown()
    }

    @Test fun imageOnlyReplyLoadsAndOpensWithOriginalMessage() = exercise(imageOnly = true, failFirst = false)
    @Test fun lateImagePatchCanRetryFailedDownload() = exercise(imageOnly = false, failFirst = true)

    private fun exercise(imageOnly: Boolean, failFirst: Boolean) {
        val bytes = ByteArrayOutputStream().also { stream ->
            Bitmap.createBitmap(20, 20, Bitmap.Config.ARGB_8888).apply {
                eraseColor(android.graphics.Color.BLUE)
                compress(Bitmap.CompressFormat.PNG, 100, stream)
                recycle()
            }
        }.toByteArray()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path != "/api/threads/first/messages/reply/file") return MockResponse().setResponseCode(404)
                requests.add(request)
                if (failFirst && requests.size == 1) return MockResponse().setResponseCode(503)
                return MockResponse().setHeader("Content-Type", "image/png")
                    .setHeader("Content-Disposition", "attachment; filename=screenshot.png")
                    .setBody(Buffer().write(bytes))
            }
        }
        server.start()
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val wiring = WiringScene(
            connection = Connection(id = "image-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        val original = Message("reply", Message.Role.BOT, Message.Kind.TEXT, 1.0, text = if (imageOnly) null else "Screenshot attached")
        val shown = mutableStateOf(original)
        var opened: DownloadedFile? = null
        var openedMessage: Message? = null
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme(darkTheme = imageOnly) {
                    MessageRow(Chat.BotChat(fixture), shown.value, openAttachment = { attachment, message, download ->
                        assertEquals("/fixture/screenshot.png", attachment.path)
                        opened = download
                        openedMessage = message
                    })
                }
            }
        }
        compose.runOnIdle { wiring.session.connect() }
        compose.waitUntil(5_000) { wiring.session.state.value.bot(fixture.id) != null }
        val imageNode = compose.onNodeWithContentDescription("Image attachment: screenshot.png. Tap to preview.")
        imageNode.assertDoesNotExist()
        compose.runOnIdle {
            // Same message ID and text, as in the server's late message patch.
            shown.value = original.copy(attachments = listOf(MessageImageAttachment("image", "/fixture/screenshot.png", "image/png")))
        }
        imageNode.assertIsDisplayed()
        if (failFirst) {
            compose.waitUntil(5_000) { requests.size == 1 }
            compose.waitForIdle()
            compose.onNodeWithText("Image unavailable").assertIsDisplayed()
            compose.onNodeWithText("Retry").performClick()
        }
        compose.waitUntil(10_000) {
            imageNode.performClick()
            opened != null
        }
        assertEquals("reply", openedMessage?.id)
        assertEquals("image/png", assertNotNull(opened).contentType)
        assertEquals(if (failFirst) 2 else 1, requests.size)
        requests.forEach { request ->
            assertEquals("POST", request.method)
            assertEquals("Bearer device-token", request.getHeader("Authorization"))
            assertEquals("/fixture/screenshot.png", CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["path"]?.jsonPrimitive?.content)
        }
    }
}
