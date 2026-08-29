package com.openmausbot.chief.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationDeduperTest {
    private class FakeStore(initial: Map<String, Long> = emptyMap()) : NotificationDedupeStore {
        var entries: Map<String, Long> = initial
        override fun load(): Map<String, Long> = entries
        override fun save(entries: Map<String, Long>) { this.entries = entries }
    }

    @Test
    fun suppressesReplayWithinRetentionWindow() {
        var now = 1_000L
        val deduper = NotificationDeduper(retentionMillis = 100, nowMillis = { now })

        assertTrue(deduper.accept("event-1"))
        assertFalse(deduper.accept("event-1"))
        now += 100
        assertTrue(deduper.accept("event-1"))
    }

    @Test
    fun boundsMemoryAndKeepsNewestEntries() {
        var now = 1_000L
        val deduper = NotificationDeduper(maxEntries = 2, nowMillis = { now })

        assertTrue(deduper.accept("one"))
        now++
        assertTrue(deduper.accept("two"))
        now++
        assertTrue(deduper.accept("three"))
        assertTrue(deduper.accept("one"))
        assertFalse(deduper.accept("three"))
    }

    @Test
    fun blankKeysAreNeverSuppressed() {
        val deduper = NotificationDeduper()
        assertTrue(deduper.accept(""))
        assertTrue(deduper.accept(""))
    }

    @Test
    fun persistsOnlyOneWayKeysAcrossASecondDeduperInstance() {
        val store = FakeStore()
        val first = NotificationDeduper(store = store)

        assertTrue(first.accept("private thread title"))
        assertEquals(1, store.entries.size)
        assertTrue(store.entries.keys.single().matches(Regex("[0-9a-f]{64}")))
        assertFalse(store.entries.keys.single().contains("private"))

        val second = NotificationDeduper(store = store)
        assertFalse(second.accept("private thread title"))
    }

    @Test
    fun dropsExpiredPersistedEntriesAndKeepsTheStoreBounded() {
        var now = 1_000L
        val store = FakeStore()
        val deduper = NotificationDeduper(retentionMillis = 100, maxEntries = 2, store = store, nowMillis = { now })

        assertTrue(deduper.accept("old"))
        now += 100
        assertTrue(deduper.accept("new"))
        assertTrue(deduper.accept("newer"))
        assertTrue(store.entries.size <= 2)
        assertTrue(deduper.accept("old"))
    }
}
