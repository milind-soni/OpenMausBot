package org.openmausbot.android.e2e

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs the same wire-format vectors the desktop side ships. Nothing here
 *  touches Android; a failure is a protocol bug, not an emulator problem. */
class E2EVectorsTest {
    private val root: JSONObject by lazy {
        val text = javaClass.classLoader!!.getResourceAsStream("e2e-vectors-v1.json")!!
            .bufferedReader()
            .use { it.readText() }
        JSONObject(text)
    }

    private val v1: JSONObject get() = root.getJSONObject("V1")
    private val inputs: JSONObject get() = root.getJSONObject("inputs")

    @Test
    fun handshakeMatchesV2AndV3() {
        for (name in listOf("V2", "V3")) {
            val vector = root.getJSONObject(name)
            val credential = credential(vector.getString("psk"))
            val ephemeral = Crypto.P256KeyPair(
                hex(inputs.getString("phoneEphemeralPrivate")),
                hex(v1.getString("phoneEphemeralPublic")),
            )
            val hello = Noise.phoneHello(
                remoteStatic = hex(v1.getString("transportPublic")),
                psk = hex(credential.getString("psk")),
                transport = vector.getInt("transport"),
                payload1 = hex(vector.getString("payload1")),
                conn = inputs.getString("connB64u"),
                ephemeral = ephemeral,
            )
            assertEquals("$name message1", vector.getString("message1"), toHex(hello.message1))
            val keys = hello.finish(hex(vector.getString("message2")))
            assertEquals("$name kPc", vector.getString("kPc"), toHex(keys.kPc))
            assertEquals("$name kCp", vector.getString("kCp"), toHex(keys.kCp))
            assertEquals("$name handshakeHash", vector.getString("handshakeHash"), toHex(keys.handshakeHash))
            if (name == "V2") {
                val records = root.getJSONObject("V4").getJSONArray("records")
                val pc = (0 until records.length()).map { records.getJSONObject(it) }
                    .first { it.getString("direction") == "pc" }
                val cp = (0 until records.length()).map { records.getJSONObject(it) }
                    .first { it.getString("direction") == "cp" }
                assertEquals(
                    "phone receives kPc",
                    pc.getString("frame"),
                    toHex(keys.receive.open(hex(pc.getString("record")))),
                )
                assertEquals(
                    "phone sends kCp",
                    cp.getString("record"),
                    toHex(keys.send.seal(hex(cp.getString("frame")))),
                )
            }
        }
    }

    @Test
    fun descriptorParsesAndRejectsBadPins() {
        val json = JSONObject()
            .put("v", 1)
            .put("k", v1.getString("transportPublicB64u"))
            .put("h", v1.getString("hostIdB64u"))
            .put("r", org.json.JSONArray(listOf("relay1.openmausbot.com")))
            .put("routes", "any")
        val descriptor = E2EDescriptor.parse(json)!!
        assertEquals(v1.getString("transportPublicB64u"), descriptor.keyB64u)
        assertEquals(v1.getString("hostIdB64u"), descriptor.hostIdB64u)
        assertEquals("relay1.openmausbot.com", descriptor.relays.single())
        val encoded = B64u.encode(json.toString().toByteArray(Charsets.UTF_8))
        assertEquals(descriptor.keyB64u, E2EDescriptor.parse(encoded)!!.keyB64u)
        assertEquals(null, E2EDescriptor.parse(JSONObject().put("v", 2).put("k", descriptor.keyB64u)))
        assertEquals(
            null,
            E2EDescriptor.parse(
                JSONObject(json.toString()).put("r", org.json.JSONArray(listOf("evil.example.com")))
            ),
        )
    }

    @Test
    fun payloadEncodingMatchesInputs() {
        assertEquals(
            inputs.getString("payload1"),
            String(Noise.encodePayload1(hex(inputs.getString("conn")), "vector/1"), Charsets.UTF_8),
        )
        assertEquals(
            inputs.getString("payload2"),
            String(Noise.encodePayload2(inputs.getString("connB64u")), Charsets.UTF_8),
        )
        assertTrue(
            Noise.checkPayload2(
                inputs.getString("payload2").toByteArray(Charsets.UTF_8),
                inputs.getString("connB64u"),
            )
        )
    }

    @Test
    fun recordVectorsOpenWithSessionKeys() {
        val v4 = root.getJSONObject("V4")
        val pc = Noise.RecordCipher(Noise.CipherState(hex(v4.getString("kPc"))))
        val cp = Noise.RecordCipher(Noise.CipherState(hex(v4.getString("kCp"))))
        val records = v4.getJSONArray("records")
        for (index in 0 until records.length()) {
            val record = records.getJSONObject(index)
            val decrypt = if (record.getString("direction") == "pc") pc else cp
            assertEquals(
                "record $index nonce",
                record.getLong("n"),
                decrypt.nonce,
            )
            val opened = decrypt.open(hex(record.getString("record")))
            assertEquals("record $index frame", record.getString("frame"), toHex(opened))
        }
    }

    @Test
    fun yamuxFrameVectorsRoundTrip() {
        val frames = root.getJSONArray("V5")
        for (index in 0 until frames.length()) {
            val item = frames.getJSONObject(index)
            val raw = hex(item.getString("hex"))
            val type = item.getInt("type")
            val length = item.getInt("length")
            val data = if (type == Yamux.TYPE_DATA) raw.copyOfRange(Yamux.HEADER_BYTES, Yamux.HEADER_BYTES + length) else null
            val frame = Yamux.Frame(type, item.getInt("flags"), item.getInt("streamId"), length, data)
            assertEquals("frame ${item.getString("name")} encode", item.getString("hex"), toHex(Yamux.encodeFrame(frame)))
            val decoded = Yamux.decodeFrame(raw)
            assertEquals(type, decoded.type)
            assertEquals(item.getInt("flags"), decoded.flags)
            assertEquals(item.getInt("streamId"), decoded.streamId)
            assertEquals(length, decoded.length)
            if (data != null) assertEquals(item.getString("hex"), toHex(Yamux.encodeFrame(decoded)))
        }
    }

    @Test
    fun base64UrlIsStrict() {
        assertEquals("XkCuA2LSB-yRqiCTmMwKqQ", B64u.encode(hex(inputs.getString("conn"))))
        assertNotNull(B64u.decode("XkCuA2LSB-yRqiCTmMwKqQ"))
        assertEquals(null, B64u.decode("XkCuA2LSB-yRqiCTmMwKqQ="))
        assertEquals(null, B64u.decode("A"))
        assertEquals(null, B64u.decode("!!!!"))
    }

    private fun credential(name: String): JSONObject {
        val array = v1.getJSONArray("credentials")
        for (index in 0 until array.length()) {
            val item = array.getJSONObject(index)
            if (item.getString("name") == name) return item
        }
        error("missing credential $name")
    }

    private fun hex(text: String): ByteArray {
        require(text.length % 2 == 0) { "odd hex length" }
        return ByteArray(text.length / 2) { index ->
            text.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    private fun toHex(bytes: ByteArray): String = buildString(bytes.size * 2) {
        for (byte in bytes) append("%02x".format(byte.toInt() and 0xff))
    }
}
