package org.openmausbot.android.e2e

class NoiseException(val reason: String) : Exception("e2e: $reason")

/** Noise_NKpsk0_P256_AESGCM_SHA256 plus the transport records in wire spec v1. */
object Noise {
    const val PROTOCOL_NAME = "Noise_NKpsk0_P256_AESGCM_SHA256"
    const val PUBLIC_KEY_BYTES = 65
    const val TAG_BYTES = 16
    const val MAX_RECORD_BYTES = 65_535
    const val MAX_RECORD_PLAINTEXT = MAX_RECORD_BYTES - TAG_BYTES
    const val MAX_HANDSHAKE_PAYLOAD = 512
    const val MAX_HANDSHAKE_MESSAGE = PUBLIC_KEY_BYTES + MAX_HANDSHAKE_PAYLOAD + TAG_BYTES
    const val CONN_BYTES = 16
    const val MAX_APP_CHARS = 40
    const val NONCE_LIMIT = 1L shl 32
    const val TRANSPORT_RELAY = 0x01
    const val TRANSPORT_DIRECT = 0x02

    fun prologue(transport: Int): ByteArray =
        "omb-e2e/1".toByteArray(Charsets.UTF_8) + byteArrayOf(0, transport.toByte())

    fun newConn(): ByteArray = Crypto.randomBytes(CONN_BYTES)

    fun encodePayload1(conn: ByteArray, app: String): ByteArray {
        if (app.length > MAX_APP_CHARS) throw NoiseException("app_too_long")
        return """{"v":1,"conn":"${B64u.encode(conn)}","app":"${jsonEscape(app)}"}"""
            .toByteArray(Charsets.UTF_8)
    }

    fun encodePayload2(conn: String): ByteArray =
        """{"v":1,"conn":"$conn"}""".toByteArray(Charsets.UTF_8)

    /** Deliberately tiny: the two handshake payloads are fixed shapes, and the
     *  core must run in a plain JVM test without Android's JSON stubs. */
    fun checkPayload2(bytes: ByteArray, conn: String): Boolean {
        if (bytes.size > MAX_HANDSHAKE_PAYLOAD) return false
        val text = String(bytes, Charsets.UTF_8)
        val version = Regex("\"v\"\\s*:\\s*1\\s*[,}]").containsMatchIn(text)
        val echoed = Regex("\"conn\"\\s*:\\s*\"([A-Za-z0-9_-]+)\"").find(text)?.groupValues?.get(1)
        return version && echoed == conn
    }

    private fun jsonEscape(value: String): String = buildString {
        for (ch in value) {
            when (ch) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (ch.code < 0x20) append("\\u%04x".format(ch.code)) else append(ch)
            }
        }
    }

    class CipherState(
        private var key: ByteArray? = null,
        private var nonce: Long = 0L,
    ) {
        val hasKey: Boolean get() = key != null
        val nonceValue: Long get() = nonce
        val keyBytes: ByteArray? get() = key

        fun encryptWithAd(ad: ByteArray, plaintext: ByteArray): ByteArray {
            val current = key ?: return plaintext.copyOf()
            if (nonce >= NONCE_LIMIT) throw NoiseException("nonce_exhausted")
            val out = Crypto.aesGcmSeal(current, Crypto.nonceBytes(nonce), ad, plaintext)
            nonce += 1
            return out
        }

        fun decryptWithAd(ad: ByteArray, ciphertext: ByteArray): ByteArray {
            val current = key ?: return ciphertext.copyOf()
            if (nonce >= NONCE_LIMIT) throw NoiseException("nonce_exhausted")
            val out = Crypto.aesGcmOpen(current, Crypto.nonceBytes(nonce), ad, ciphertext)
                ?: throw NoiseException("aead")
            nonce += 1
            return out
        }
    }

    class SymmetricState(var h: ByteArray, var ck: ByteArray) {
        var cipher = CipherState()

        fun mixHash(data: ByteArray) {
            h = Crypto.sha256(h + data)
        }

        fun mixKey(ikm: ByteArray) {
            val out = Crypto.hkdf(ck, ikm, 2)
            ck = out[0]
            cipher = CipherState(out[1])
        }

        fun mixKeyAndHash(ikm: ByteArray) {
            val out = Crypto.hkdf(ck, ikm, 3)
            ck = out[0]
            mixHash(out[1])
            cipher = CipherState(out[2])
        }

        fun encryptAndHash(plaintext: ByteArray): ByteArray {
            val out = cipher.encryptWithAd(h, plaintext)
            mixHash(out)
            return out
        }

        fun decryptAndHash(ciphertext: ByteArray): ByteArray {
            val out = cipher.decryptWithAd(h, ciphertext)
            mixHash(ciphertext)
            return out
        }

        /** k_pc then k_cp. */
        fun split(): Pair<CipherState, CipherState> {
            val out = Crypto.hkdf(ck, ByteArray(0), 2)
            return CipherState(out[0]) to CipherState(out[1])
        }

        companion object {
            fun initialize(): SymmetricState {
                val name = PROTOCOL_NAME.toByteArray(Charsets.UTF_8)
                val h = if (name.size <= 32) name + ByteArray(32 - name.size) else Crypto.sha256(name)
                return SymmetricState(h, h.copyOf())
            }
        }
    }

    class RecordCipher(private val state: CipherState) {
        val nonce: Long get() = state.nonceValue

        fun seal(plaintext: ByteArray): ByteArray {
            if (plaintext.size > MAX_RECORD_PLAINTEXT) throw NoiseException("record_too_large")
            return state.encryptWithAd(ByteArray(0), plaintext)
        }

        fun open(record: ByteArray): ByteArray {
            if (record.size > MAX_RECORD_BYTES) throw NoiseException("record_too_large")
            return state.decryptWithAd(ByteArray(0), record)
        }
    }

    data class SessionKeys(
        val send: RecordCipher,
        val receive: RecordCipher,
        val handshakeHash: ByteArray,
        val kPc: ByteArray,
        val kCp: ByteArray,
    )

    class PhoneHello internal constructor(
        val message1: ByteArray,
        private val finisher: (ByteArray) -> SessionKeys,
    ) {
        private var done = false

        fun finish(message2: ByteArray): SessionKeys {
            if (done) throw NoiseException("finished")
            done = true
            return finisher(message2)
        }
    }

    /** The initiator. Every failure is a hard stop; the reason never goes on the wire. */
    fun phoneHello(
        remoteStatic: ByteArray,
        psk: ByteArray,
        transport: Int,
        payload1: ByteArray,
        conn: String,
        ephemeral: Crypto.P256KeyPair? = null,
    ): PhoneHello {
        if (!Crypto.isValidPublicKey(remoteStatic)) throw NoiseException("bad_point")
        if (psk.size != 32) throw NoiseException("bad_psk")
        if (payload1.size > MAX_HANDSHAKE_PAYLOAD) throw NoiseException("payload_too_large")
        val state = SymmetricState.initialize()
        state.mixHash(prologue(transport))
        state.mixHash(remoteStatic)
        state.mixKeyAndHash(psk)
        val e = ephemeral ?: Crypto.generateKeyPair()
        state.mixHash(e.publicKey)
        state.mixKey(e.publicKey)
        val es = Crypto.dh(e.privateKey, remoteStatic) ?: throw NoiseException("bad_point")
        state.mixKey(es)
        val message1 = e.publicKey + state.encryptAndHash(payload1)
        return PhoneHello(message1) { message2 ->
            if (message2.size < PUBLIC_KEY_BYTES + TAG_BYTES || message2.size > MAX_HANDSHAKE_MESSAGE) {
                throw NoiseException("message2_size")
            }
            val re = message2.copyOfRange(0, PUBLIC_KEY_BYTES)
            val ee = Crypto.dh(e.privateKey, re) ?: throw NoiseException("bad_point")
            state.mixHash(re)
            state.mixKey(re)
            state.mixKey(ee)
            val payload2 = state.decryptAndHash(message2.copyOfRange(PUBLIC_KEY_BYTES, message2.size))
            if (!checkPayload2(payload2, conn)) throw NoiseException("payload2")
            val (pc, cp) = state.split()
            // kPc encrypts computer-to-phone; the phone sends with kCp.
            SessionKeys(
                send = RecordCipher(cp),
                receive = RecordCipher(pc),
                handshakeHash = state.h.copyOf(),
                kPc = pc.keyBytes!!.copyOf(),
                kCp = cp.keyBytes!!.copyOf(),
            )
        }
    }
}
