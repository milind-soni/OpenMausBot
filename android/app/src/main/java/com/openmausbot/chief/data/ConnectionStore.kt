package com.openmausbot.chief.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class PairedSession(val connection: SavedConnection, val token: String)

class ConnectionStore(context: Context) {
    private val preferences = context.getSharedPreferences("openmaus-chief", Context.MODE_PRIVATE)

    fun load(): PairedSession? = runCatching {
        val rawConnection = preferences.getString(CONNECTION, null) ?: return null
        val encrypted = preferences.getString(TOKEN, null) ?: return null
        val parts = encrypted.split('.', limit = 2)
        if (parts.size != 2) return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, decode(parts[0])))
        val token = cipher.doFinal(decode(parts[1])).decodeToString()
        PairedSession(WireJson.decodeFromString(rawConnection), token)
    }.getOrNull()

    fun save(connection: SavedConnection, token: String) {
        require(token.startsWith("omb_")) { "Invalid device token" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(token.encodeToByteArray())
        preferences.edit()
            .putString(CONNECTION, WireJson.encodeToString(SavedConnection.serializer(), connection))
            .putString(TOKEN, "${encode(cipher.iv)}.${encode(ciphertext)}")
            .apply()
    }

    fun clear() {
        preferences.edit().remove(CONNECTION).remove(TOKEN).apply()
        runCatching {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            store.deleteEntry(KEY_ALIAS)
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)

    companion object {
        private const val KEY_ALIAS = "openmaus-chief-device-token"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val CONNECTION = "connection"
        private const val TOKEN = "token"
    }
}
