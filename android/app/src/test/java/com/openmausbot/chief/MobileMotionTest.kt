package com.openmausbot.chief

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MobileMotionTest {
    private val source = File("src/main/java/com/openmausbot/chief/MainActivity.kt").readText()

    @Test
    fun navigationUsesShortDirectionalTransitions() {
        assertTrue(source.contains("label = \"home-tab\""))
        assertTrue(source.contains("targetState.ordinal > initialState.ordinal"))
        assertTrue(source.contains("slideInHorizontally(tween(190))"))
    }

    @Test
    fun liveAndBusyStatesMoveWithoutAnimatingStaticCopy() {
        assertTrue(source.contains("LivePulseDot(active = live"))
        assertTrue(source.contains("rememberInfiniteTransition(label = \"live-pulse\")"))
        assertTrue(source.contains("expandVertically(tween(190))"))
    }

    @Test
    fun messagesAndReorderedAgentsAnimateInPlace() {
        assertTrue(source.contains("Box(Modifier.animateItem()) { MessageBubble"))
        assertTrue(source.contains("modifier = Modifier.animateItem().fillMaxWidth()"))
    }
}
