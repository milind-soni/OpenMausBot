package com.astra.companion.storage

import android.content.Context
import com.astra.companion.core.ActivityDetail
import com.astra.companion.core.QuickReply
import kotlin.test.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Local chat choices survive the Activity/process boundary and stay non-secret. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatPreferencesTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    private fun store(name: String): ChatPreferences = ChatPreferences(
        context.getSharedPreferences(name, Context.MODE_PRIVATE),
    )

    @Test
    fun `activity detail survives a new preferences instance`() {
        val name = "chat-activity-detail"
        store(name).setActivityDetail(ActivityDetail.HIDDEN)

        assertEquals(ActivityDetail.HIDDEN, store(name).activityDetail.value)
    }

    @Test
    fun `an intentionally empty quick reply list stays empty after relaunch`() {
        val name = "chat-empty-quick-replies"
        store(name).setQuickReplies(emptyList())

        assertEquals(emptyList(), store(name).quickReplies.value)
    }

    @Test
    fun `custom quick replies persist in their selected order`() {
        val name = "chat-custom-quick-replies"
        val replies = listOf(
            QuickReply(id = "deploy", title = "Deploy", prompt = "Deploy staging", icon = "send"),
            QuickReply(id = "logs", title = "Logs", prompt = "Show logs", icon = "document"),
        )
        store(name).setQuickReplies(replies)

        assertEquals(replies, store(name).quickReplies.value)
    }

    @Test
    fun `last share destination is remembered per computer`() {
        val name = "chat-share-destination"
        val prefs = store(name)
        assertEquals(null, prefs.lastShareDestination("air"))
        prefs.setLastShareDestination("air", "bot:vision")
        prefs.setLastShareDestination("pro", "channel:team")
        assertEquals("bot:vision", store(name).lastShareDestination("air"))
        assertEquals("channel:team", store(name).lastShareDestination("pro"))
    }
}
