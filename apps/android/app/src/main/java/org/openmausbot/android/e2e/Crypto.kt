package org.openmausbot.android.e2e

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** P-256, AES-256-GCM and the HKDF/HMAC calls the wire spec pins. */
object Crypto {
    const val PUBLIC_KEY_BYTES = 65
    const val PRIVATE_KEY_BYTES = 32
    const val TAG_BYTES = 16

    data class P256KeyPair(val privateKey: ByteArray, val publicKey: ByteArray)

    private val random = SecureRandom()
    private val ecParams: ECParameterSpec by lazy {
        val parameters = AlgorithmParameters.getInstance("EC")
        parameters.init(ECGenParameterSpec("secp256r1"))
        parameters.getParameterSpec(ECParameterSpec::class.java)
    }

    fun randomBytes(size: Int): ByteArray = ByteArray(size).also(random::nextBytes)

    fun sha256(bytes: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(bytes)

    fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    /** RFC 5869 with the chaining key as salt and empty info, as Noise's HKDF. */
    fun hkdf(chainingKey: ByteArray, ikm: ByteArray, outputs: Int): List<ByteArray> {
        val temp = hmacSha256(chainingKey, ikm)
        val result = ArrayList<ByteArray>(outputs)
        var last = ByteArray(0)
        for (index in 1..outputs) {
            last = hmacSha256(temp, last + byteArrayOf(index.toByte()))
            result.add(last)
        }
        return result
    }

    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean =
        a.size == b.size && MessageDigest.isEqual(a, b)

    fun generateKeyPair(): P256KeyPair {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val privateKey = (pair.private as ECPrivateKey).s
        val publicKey = (pair.public as ECPublicKey).w
        return P256KeyPair(normalize32(privateKey), encodePoint(publicKey))
    }

    /** Null for anything the wire forbids: wrong length, compressed/hybrid
     *  encodings, off-curve points and coordinates at or above p. */
    fun publicKeyFromBytes(bytes: ByteArray): ECPublicKey? {
        if (bytes.size != PUBLIC_KEY_BYTES || bytes[0] != 0x04.toByte()) return null
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val y = BigInteger(1, bytes.copyOfRange(33, 65))
        val field = ecParams.curve.field as? ECFieldFp ?: return null
        val p = field.p
        if (x >= p || y >= p) return null
        val lhs = y.modPow(BigInteger.TWO, p)
        val rhs = x.modPow(BigInteger.valueOf(3), p)
            .add(ecParams.curve.a.multiply(x))
            .add(ecParams.curve.b)
            .mod(p)
        if (lhs != rhs) return null
        return try {
            KeyFactory.getInstance("EC")
                .generatePublic(ECPublicKeySpec(ECPoint(x, y), ecParams)) as ECPublicKey
        } catch (_: Exception) {
            null
        }
    }

    fun isValidPublicKey(bytes: ByteArray): Boolean = publicKeyFromBytes(bytes) != null

    /** The raw 32-byte X coordinate. Both keys are validated first, so a bad
     *  point fails before the provider sees it. */
    fun dh(privateKey: ByteArray, publicKey: ByteArray): ByteArray? {
        val privateSpec = try {
            KeyFactory.getInstance("EC").generatePrivate(
                ECPrivateKeySpec(BigInteger(1, privateKey), ecParams)
            ) as ECPrivateKey
        } catch (_: Exception) {
            return null
        }
        val publicSpec = publicKeyFromBytes(publicKey) ?: return null
        return try {
            val agreement = KeyAgreement.getInstance("ECDH")
            agreement.init(privateSpec)
            agreement.doPhase(publicSpec, true)
            agreement.generateSecret()
        } catch (_: Exception) {
            null
        }
    }

    fun nonceBytes(n: Long): ByteArray =
        ByteBuffer.allocate(12).putInt(0).putLong(n).array()

    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(ad)
        return cipher.doFinal(plaintext)
    }

    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray): ByteArray? =
        try {
            if (ciphertext.size < TAG_BYTES) {
                null
            } else {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
                cipher.updateAAD(ad)
                cipher.doFinal(ciphertext)
            }
        } catch (_: Exception) {
            null
        }

    private fun encodePoint(point: ECPoint): ByteArray =
        byteArrayOf(0x04) + normalize32(point.affineX) + normalize32(point.affineY)

    private fun normalize32(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == PRIVATE_KEY_BYTES -> raw
            raw.size == PRIVATE_KEY_BYTES + 1 && raw[0] == 0.toByte() ->
                raw.copyOfRange(1, raw.size)
            raw.size < PRIVATE_KEY_BYTES ->
                ByteArray(PRIVATE_KEY_BYTES - raw.size) + raw
            else -> raw.copyOfRange(raw.size - PRIVATE_KEY_BYTES, raw.size)
        }
    }
}
