package com.openmausbot.companion.dictation

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.openmausbot.companion.core.Dictation
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Assert.assertNotEquals

/**
 * Composer dictation lifecycle pinned to `ios/App/SpeechDictation.swift` and
 * the ChatView stop sites. Expectations come from the Swift behaviour and
 * PORT17 — not from inspecting [SpeechDictation] to decide what to assert.
 *
 * The recognizer is a fake; the controller under test is the real one, so a
 * stub that agreed with a wrong controller would still fail these cases.
 *
 * ## Stop triggers covered here (real paths)
 * - leaving the screen via [SpeechDictation.unbind]
 * - backgrounding via bound [Lifecycle.Event.ON_STOP]
 * - audio-focus interruption via the focus callback (generation-guarded)
 *
 * ## Device-plan triggers (Compose UI — no harness in this module)
 * Disconnecting these in `ChatScreen` would not fail a JVM test today; they
 * belong on a device/emulator pass rather than a simulated `stop()` call:
 * - submit via Composer `onSend`
 * - opening Computer / Tasks / Profile / Plus
 */
class SpeechDictationTest {

    @Test
    fun typedTextIsPreservedAcrossADictationSession() {
        // Swift: freeze base at mic-on; every partial is base + spoken.
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "please look")

        assertTrue(dictation.isListening.value)
        assertEquals("please look", dictation.base)
        assertEquals("", dictation.transcript.value)

        fake.engine!!.listener!!.onPartial("at the logs")
        assertEquals(
            "please look at the logs",
            Dictation.draft(base = dictation.base, transcript = dictation.transcript.value),
        )

        fake.engine!!.listener!!.onPartial("at the logs again")
        assertEquals(
            "please look at the logs again",
            Dictation.draft(base = dictation.base, transcript = dictation.transcript.value),
        )
        // The frozen base itself never grows — that is what prevents duplication.
        assertEquals("please look", dictation.base)
    }

    @Test
    fun partialsReplaceRatherThanStack() {
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "please")
        fake.engine!!.listener!!.onPartial("look")
        fake.engine!!.listener!!.onPartial("look at the logs")
        assertEquals("look at the logs", dictation.transcript.value)
        assertEquals(
            "please look at the logs",
            Dictation.draft(base = dictation.base, transcript = dictation.transcript.value),
        )
    }

    @Test
    fun lateCallbackFromStaleGenerationIsDiscarded() {
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "one")
        val first = fake.engine!!.listener!!
        dictation.stop()

        dictation.toggle(capturing = "two")
        assertEquals("two", dictation.base)
        assertEquals("", dictation.transcript.value)

        // Stale session tries to rewrite the new draft.
        first.onPartial("should not land")
        assertEquals("", dictation.transcript.value)
        assertEquals("two", dictation.base)
        assertTrue(dictation.isListening.value)
    }

    @Test
    fun stopOnLeavingTheScreenViaUnbind() {
        // Trigger: leaving the screen.
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        val screen = TestOwner()
        screen.registry.currentState = Lifecycle.State.RESUMED
        dictation.bind(screen)
        dictation.toggle(capturing = "bye")
        assertTrue(dictation.isListening.value)

        dictation.unbind(screen)
        assertFalse(dictation.isListening.value)
        assertEquals(1, fake.engine!!.cancels)
        assertEquals(1, fake.engine!!.destroys)
    }

    @Test
    fun stopOnBackgroundViaBoundLifecycleOnStop() {
        // Trigger: backgrounding — Activity ON_STOP while still bound.
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        val screen = TestOwner()
        screen.registry.currentState = Lifecycle.State.RESUMED
        dictation.bind(screen)
        dictation.toggle(capturing = "bg")
        assertTrue(dictation.isListening.value)

        screen.registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        screen.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        assertFalse(dictation.isListening.value)
    }

    @Test
    fun stopOnAudioInterruption() {
        // Trigger: audio focus loss for the active session.
        val fake = FakeEngineFactory()
        val focus = FakeFocus(grant = true)
        val dictation = SpeechDictation(
            engineFactory = fake,
            hasRecordAudio = { true },
            requestRecordAudio = { it(true) },
            focus = focus,
            preferredLanguages = { listOf("en-US") },
            currentLocale = { Locale.US },
            postMain = { it() },
        )
        dictation.toggle(capturing = "interrupt")
        assertTrue(dictation.isListening.value)
        focus.interrupt!!()
        assertFalse(dictation.isListening.value)
    }

    @Test
    fun staleAudioInterruptionDoesNotStopNewerSession() {
        // Delayed focus-loss runnable from session A must not kill session B.
        val fake = FakeEngineFactory()
        val focus = FakeFocus(grant = true)
        val deferred = CopyOnWriteArrayList<() -> Unit>()
        val dictation = SpeechDictation(
            engineFactory = fake,
            hasRecordAudio = { true },
            requestRecordAudio = { it(true) },
            focus = focus,
            preferredLanguages = { listOf("en-US") },
            currentLocale = { Locale.US },
            postMain = { block -> deferred += block },
        )
        dictation.toggle(capturing = "A")
        assertTrue(dictation.isListening.value)
        val interruptA = focus.interrupt!!
        // Focus loss posts a runnable (does not run yet).
        interruptA()
        assertEquals(1, deferred.size)

        // Drain nothing yet — stop A and start B on the calling thread.
        dictation.stop()
        // Run posted blocks synchronously again for B's start path.
        val pending = deferred.toList()
        deferred.clear()
        pending.forEach { it() }

        dictation.toggle(capturing = "B")
        // Flush B's start posts if any.
        while (deferred.isNotEmpty()) {
            val batch = deferred.toList()
            deferred.clear()
            batch.forEach { it() }
        }
        assertTrue(dictation.isListening.value)
        assertEquals("B", dictation.base)

        // Now the delayed A interruption runs — must be a no-op.
        interruptA()
        while (deferred.isNotEmpty()) {
            val batch = deferred.toList()
            deferred.clear()
            batch.forEach { it() }
        }
        assertTrue(dictation.isListening.value, "stale interruption stopped B")
        assertEquals("B", dictation.base)
    }

    @Test
    fun deniedPermissionSurfacesInline() {
        val fake = FakeEngineFactory()
        var asked = false
        val dictation = SpeechDictation(
            engineFactory = fake,
            hasRecordAudio = { false },
            requestRecordAudio = { callback ->
                asked = true
                callback(false)
            },
            focus = FakeFocus(grant = true),
            preferredLanguages = { listOf("en-US") },
            currentLocale = { Locale.US },
            postMain = { it() },
        )
        dictation.toggle(capturing = "hello")
        assertTrue(asked)
        assertFalse(dictation.isListening.value)
        assertFalse(dictation.isStarting.value)
        assertEquals(SpeechDictation.MIC_DENIED_MESSAGE, dictation.error.value)
        assertEquals(0, fake.created)
    }

    @Test
    fun recognizerFailureSurfacesInline() {
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "hello")
        fake.engine!!.listener!!.onError(SpeechEngine.ErrorKind.FAILED)
        assertFalse(dictation.isListening.value)
        assertEquals(SpeechDictation.TRANSCRIBE_FAILED_MESSAGE, dictation.error.value)
    }

    @Test
    fun missingRecognizerSurfacesLanguageCopy() {
        val dictation = SpeechDictation(
            engineFactory = SpeechEngineFactory { emptyList() },
            hasRecordAudio = { true },
            requestRecordAudio = { it(true) },
            focus = FakeFocus(grant = true),
            preferredLanguages = { listOf("en-US") },
            currentLocale = { Locale.US },
            postMain = { it() },
        )
        dictation.toggle(capturing = "hello")
        assertEquals(SpeechDictation.NO_RECOGNIZER_MESSAGE, dictation.error.value)
        assertFalse(dictation.isStarting.value)
    }

    @Test
    fun permissionResultAfterCancelIsDiscarded() {
        val fake = FakeEngineFactory()
        val pending = CopyOnWriteArrayList<(Boolean) -> Unit>()
        val dictation = SpeechDictation(
            engineFactory = fake,
            hasRecordAudio = { false },
            requestRecordAudio = { callback -> pending += callback },
            focus = FakeFocus(grant = true),
            preferredLanguages = { listOf("en-US") },
            currentLocale = { Locale.US },
            postMain = { it() },
        )
        dictation.toggle(capturing = "race")
        assertTrue(dictation.isStarting.value)
        dictation.stop()
        assertFalse(dictation.isStarting.value)
        // System sheet answers after the user already cancelled.
        pending.single().invoke(true)
        assertFalse(dictation.isListening.value)
        assertEquals(0, fake.created)
        assertNull(dictation.error.value)
    }

    @Test
    fun locksComposerWhileStartingAndListening() {
        val fake = FakeEngineFactory()
        val pending = CopyOnWriteArrayList<(Boolean) -> Unit>()
        val dictation = SpeechDictation(
            engineFactory = fake,
            hasRecordAudio = { false },
            requestRecordAudio = { callback -> pending += callback },
            focus = FakeFocus(grant = true),
            preferredLanguages = { listOf("en-US") },
            currentLocale = { Locale.US },
            postMain = { it() },
        )
        dictation.toggle(capturing = "lock")
        assertTrue(dictation.isStarting.value)
        assertTrue(dictation.locksComposer())
        pending.single().invoke(true)
        assertTrue(dictation.isListening.value)
        assertTrue(dictation.locksComposer())
        dictation.stop()
        assertFalse(dictation.locksComposer())
    }

    @Test
    fun defaultFallbackDoesNotForcePreferOffline() {
        // iOS leaves requiresOnDeviceRecognition unset on the fallback path.
        val fake = FakeEngineFactory(isOnDevice = false)
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "network ok")
        assertFalse(fake.engine!!.lastRequest!!.preferOffline)
    }

    @Test
    fun onDeviceEngineDoesNotNeedPreferOfflineHint() {
        val fake = FakeEngineFactory(isOnDevice = true)
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "local")
        assertFalse(fake.engine!!.lastRequest!!.preferOffline)
    }

    @Test
    fun onDeviceOpenFailureDegradesToDefaultRecognizer() {
        val fake = FakeEngineFactory(
            FakeEngineFactory.OpenerSpec(isOnDevice = true, failOpen = true),
            FakeEngineFactory.OpenerSpec(isOnDevice = false),
        )
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "degrade open")
        assertTrue(dictation.isListening.value)
        assertEquals(1, fake.created)
        assertFalse(fake.engine!!.isOnDevice)
        assertEquals("en-US", fake.engine!!.lastRequest!!.languageTag)
    }

    @Test
    fun onDeviceStartFailureDegradesToDefaultRecognizer() {
        val fake = FakeEngineFactory(
            FakeEngineFactory.OpenerSpec(isOnDevice = true, failStart = true),
            FakeEngineFactory.OpenerSpec(isOnDevice = false),
        )
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "degrade start")
        assertTrue(dictation.isListening.value)
        assertEquals(2, fake.created)
        assertFalse(fake.engine!!.isOnDevice)
    }

    @Test
    fun onDeviceAsyncFailureDegradesToDefaultRecognizer() {
        val fake = FakeEngineFactory(
            FakeEngineFactory.OpenerSpec(isOnDevice = true),
            FakeEngineFactory.OpenerSpec(isOnDevice = false),
        )
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "degrade async")
        assertTrue(fake.engine!!.isOnDevice)
        fake.engine!!.listener!!.onError(SpeechEngine.ErrorKind.FAILED)
        assertTrue(dictation.isListening.value)
        assertEquals(2, fake.created)
        assertFalse(fake.engine!!.isOnDevice)
        assertNull(dictation.error.value)
    }

    @Test
    fun languageErrorWalksLocaleCandidatesThenFallsBack() {
        val fake = FakeEngineFactory(
            FakeEngineFactory.OpenerSpec(isOnDevice = true),
            FakeEngineFactory.OpenerSpec(isOnDevice = false),
        )
        val dictation = SpeechDictation(
            engineFactory = fake,
            hasRecordAudio = { true },
            requestRecordAudio = { it(true) },
            focus = FakeFocus(grant = true),
            preferredLanguages = { listOf("pt-BR", "es-ES") },
            currentLocale = { Locale.FRANCE },
            postMain = { it() },
        )
        dictation.toggle(capturing = "locales")
        assertEquals("pt-BR", fake.engine!!.lastRequest!!.languageTag)

        fake.engine!!.listener!!.onError(SpeechEngine.ErrorKind.LANGUAGE)
        assertEquals("es-ES", fake.engine!!.lastRequest!!.languageTag)
        assertTrue(dictation.isListening.value)

        fake.engine!!.listener!!.onError(SpeechEngine.ErrorKind.LANGUAGE)
        assertEquals("fr-FR", fake.engine!!.lastRequest!!.languageTag)

        fake.engine!!.listener!!.onError(SpeechEngine.ErrorKind.LANGUAGE)
        assertEquals("en-US", fake.engine!!.lastRequest!!.languageTag)

        // Exhausted locales on on-device → default engine, first locale again.
        fake.engine!!.listener!!.onError(SpeechEngine.ErrorKind.LANGUAGE)
        assertFalse(fake.engine!!.isOnDevice)
        assertEquals("pt-BR", fake.engine!!.lastRequest!!.languageTag)
        assertTrue(dictation.isListening.value)
    }

    @Test
    fun finalResultStopsListening() {
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "base")
        fake.engine!!.listener!!.onFinal("done")
        assertEquals("done", dictation.transcript.value)
        assertFalse(dictation.isListening.value)
    }

    @Test
    fun generationBumpsAcrossStopAndRestart() {
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        dictation.toggle(capturing = "a")
        val firstEngine = fake.engine!!
        dictation.stop()
        dictation.toggle(capturing = "b")
        assertNotEquals(firstEngine, fake.engine)
        assertEquals(1, firstEngine.destroys)
    }

    @Test
    fun unbindClearsStickyErrorSoNextConversationStartsClean() {
        val fake = FakeEngineFactory()
        val dictation = newDictation(fake, granted = true)
        val screenA = TestOwner()
        screenA.registry.currentState = Lifecycle.State.RESUMED
        dictation.bind(screenA)
        dictation.toggle(capturing = "A")
        fake.engine!!.listener!!.onError(SpeechEngine.ErrorKind.FAILED)
        assertEquals(SpeechDictation.TRANSCRIBE_FAILED_MESSAGE, dictation.error.value)

        dictation.unbind(screenA)
        assertNull(dictation.error.value)

        val screenB = TestOwner()
        screenB.registry.currentState = Lifecycle.State.RESUMED
        dictation.bind(screenB)
        assertNull(dictation.error.value)
    }

    private fun newDictation(
        fake: FakeEngineFactory,
        granted: Boolean,
    ): SpeechDictation = SpeechDictation(
        engineFactory = fake,
        hasRecordAudio = { granted },
        requestRecordAudio = { it(granted) },
        focus = FakeFocus(grant = true),
        preferredLanguages = { listOf("en-US") },
        currentLocale = { Locale.US },
        postMain = { it() },
    )

    private class TestOwner : LifecycleOwner {
        val registry = LifecycleRegistry.createUnsafe(this)
        override val lifecycle: Lifecycle get() = registry
    }

    private class FakeEngineFactory(
        private vararg val specs: OpenerSpec,
    ) : SpeechEngineFactory {
        constructor(isOnDevice: Boolean = false) : this(OpenerSpec(isOnDevice = isOnDevice))

        data class OpenerSpec(
            val isOnDevice: Boolean = false,
            val failOpen: Boolean = false,
            val failStart: Boolean = false,
        )

        private val engines = mutableListOf<FakeEngine>()

        val created: Int get() = engines.size
        val engine: FakeEngine? get() = engines.lastOrNull()

        override fun openers(): List<EngineOpener> {
            val list = specs.toList().ifEmpty { listOf(OpenerSpec()) }
            return list.map { spec ->
                EngineOpener(isOnDevice = spec.isOnDevice) {
                    if (spec.failOpen) error("open failed")
                    FakeEngine(isOnDevice = spec.isOnDevice, failStart = spec.failStart)
                        .also { engines += it }
                }
            }
        }
    }

    private class FakeEngine(
        override val isOnDevice: Boolean,
        private val failStart: Boolean = false,
    ) : SpeechEngine {
        var listener: SpeechEngine.Listener? = null
            private set
        var lastRequest: RecognitionRequest? = null
            private set
        var cancels = 0
            private set
        var destroys = 0
            private set

        override fun start(request: RecognitionRequest, listener: SpeechEngine.Listener) {
            if (failStart) error("start failed")
            lastRequest = request
            this.listener = listener
        }

        override fun cancel() {
            cancels += 1
        }

        override fun destroy() {
            destroys += 1
            listener = null
        }
    }

    private class FakeFocus(
        private val grant: Boolean,
    ) : DictationAudioFocus {
        var interrupt: (() -> Unit)? = null
            private set
        var abandons = 0
            private set

        override fun request(onInterrupted: () -> Unit): Boolean {
            interrupt = onInterrupted
            return grant
        }

        override fun abandon() {
            abandons += 1
            interrupt = null
        }
    }
}

/**
 * Call mode — `listenForTurn` on the call-mode branch of
 * `ios/App/SpeechDictation.swift`: the turn ends a gap after the transcript
 * last changed, or on the recognizer's final; an empty turn never ends on the
 * timer; stopping any other way ends it without a callback.
 */
class SpeechDictationTurnTest {
    private var now = 0L
    private val scheduled = ArrayDeque<() -> Unit>()

    private fun newDictation(fake: TurnFakeFactory): SpeechDictation = SpeechDictation(
        engineFactory = fake,
        hasRecordAudio = { true },
        requestRecordAudio = { it(true) },
        focus = object : DictationAudioFocus {
            override fun request(onInterrupted: () -> Unit): Boolean = true
            override fun abandon() = Unit
        },
        preferredLanguages = { listOf("en-US") },
        currentLocale = { Locale.US },
        postMain = { it() },
        postDelayed = { _, block -> scheduled.addLast(block) },
        clock = { now },
    )

    /** Advance the clock and run every endpoint check that was queued. */
    private fun tick(millis: Long) {
        now += millis
        val due = scheduled.toList()
        scheduled.clear()
        due.forEach { it() }
    }

    @Test
    fun theTurnEndsAGapAfterTheTranscriptLastChanged() {
        val fake = TurnFakeFactory()
        val dictation = newDictation(fake)
        val turns = mutableListOf<String>()
        dictation.listenForTurn(850) { turns += it }
        assertTrue(dictation.isListening.value)

        fake.listener!!.onPartial("read the")
        tick(500)
        fake.listener!!.onPartial("read the logs")
        tick(500)
        // 500 ms since the last change: not yet.
        assertTrue(turns.isEmpty())
        // The recognizer re-emits the same partial; that is not a change.
        fake.listener!!.onPartial("read the logs")
        tick(400)
        assertEquals(listOf("read the logs"), turns)
        assertFalse(dictation.isListening.value)
    }

    @Test
    fun anEmptyTurnNeverEndsOnTheTimer() {
        val fake = TurnFakeFactory()
        val dictation = newDictation(fake)
        val turns = mutableListOf<String>()
        dictation.listenForTurn(850) { turns += it }
        tick(5_000)
        tick(5_000)
        assertTrue(turns.isEmpty())
        assertTrue(dictation.isListening.value)
    }

    @Test
    fun theRecognizersFinalEndsTheTurnAtOnce() {
        val fake = TurnFakeFactory()
        val dictation = newDictation(fake)
        val turns = mutableListOf<String>()
        dictation.listenForTurn(850) { turns += it }
        fake.listener!!.onPartial("hello")
        fake.listener!!.onFinal("hello there")
        assertEquals(listOf("hello there"), turns)
        assertFalse(dictation.isListening.value)
    }

    @Test
    fun silenceTheRecognizerGaveUpOnIsAnEmptyTurnNotAFailure() {
        val fake = TurnFakeFactory()
        val dictation = newDictation(fake)
        val turns = mutableListOf<String>()
        dictation.listenForTurn(850) { turns += it }
        fake.listener!!.onError(SpeechEngine.ErrorKind.FAILED)
        assertEquals(listOf(""), turns)
        assertNull(dictation.error.value)
    }

    @Test
    fun stoppingAnyOtherWayEndsTheTurnWithoutACallback() {
        val fake = TurnFakeFactory()
        val dictation = newDictation(fake)
        val turns = mutableListOf<String>()
        dictation.listenForTurn(850) { turns += it }
        fake.listener!!.onPartial("hello")
        dictation.stop()
        tick(2_000)
        assertTrue(turns.isEmpty())
        // A later composer session is not a call: no endpointer applies.
        dictation.toggle(capturing = "")
        fake.listener!!.onPartial("typed")
        tick(2_000)
        assertTrue(turns.isEmpty())
        assertTrue(dictation.isListening.value)
    }

    private class TurnFakeFactory : SpeechEngineFactory {
        var listener: SpeechEngine.Listener? = null
        override fun openers(): List<EngineOpener> = listOf(
            EngineOpener(isOnDevice = false) {
                object : SpeechEngine {
                    override val isOnDevice: Boolean = false
                    override fun start(request: RecognitionRequest, listener: SpeechEngine.Listener) {
                        this@TurnFakeFactory.listener = listener
                    }
                    override fun cancel() = Unit
                    override fun destroy() = Unit
                }
            },
        )
    }
}
