package com.astra.companion.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.astra.companion.core.TokenStore
import java.security.KeyStoreException
import javax.crypto.AEADBadTagException
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Keystore-backed device-token storage — iOS Keychain analogue.
 *
 * File name [PREFS_NAME] is excluded from Auto Backup and device-transfer via
 * `backup_rules.xml` / `data_extraction_rules.xml`. Keystore material is
 * ThisDeviceOnly-equivalent (not migratable).
 *
 * Two properties are load-bearing, and neither is free:
 *
 * - **Nothing here runs on the caller's thread.** [openPrefs] is not a field
 *   read: it derives a `MasterKey` through the Android Keystore, opens an
 *   encrypted file and decrypts its index — Keystore IPC plus disk I/O, on
 *   first touch. Every reader and writer below is reached from `Session`, whose
 *   scope in `AstraApp` is `Dispatchers.Main.immediate`; without the hop
 *   the launch-time restore would do that work on the main thread, and so
 *   would the token write in the middle of a pairing. [io] is where it goes
 *   instead — the same injected-context shape [OnboardingPreferences] uses,
 *   and overridable so tests can observe which thread the work landed on.
 * - **A write is durable before it returns.** [SharedPreferences.Editor.commit]
 *   rather than `apply()`, for the reason the ordering in `Session.pair` gives:
 *   the token is saved *before* the connection becomes restorable, so that a
 *   process which stops between them leaves a token with no pairing (harmless)
 *   rather than a restorable pairing whose token never landed (a phone that
 *   comes back unable to reach its computer and cannot say why). `apply()`
 *   hands that write to a background thread and returns, which gives the
 *   ordering back.
 *
 * Cancellation is re-thrown rather than reported as a store failure: a caller
 * that went away has not discovered anything about the Keystore.
 */
class KeystoreTokenStore(
    private val prefsProvider: () -> SharedPreferences,
    /** Where the Keystore work and the blocking disk I/O go; overridden in tests. */
    private val io: CoroutineContext = Dispatchers.IO,
) : TokenStore {
    constructor(context: Context) : this({ openPrefs(context.applicationContext) })

    private val prefs: SharedPreferences by lazy(prefsProvider)

    override suspend fun save(connectionId: String, token: String) {
        try {
            withContext(io) {
                check(prefs.edit().putString(key(connectionId), token).commit()) {
                    "The device token write did not land."
                }
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            throw TokenStoreException(locked = isLocked(error), cause = error)
        }
    }

    override suspend fun read(connectionId: String): TokenStore.ReadResult {
        return try {
            val value = withContext(io) { prefs.getString(key(connectionId), null) }
            if (value == null) TokenStore.ReadResult.Missing
            else TokenStore.ReadResult.Found(value)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            TokenStore.ReadResult.Unavailable(
                locked = isLocked(error),
                message = error.message
                    ?: "Couldn't access the pairing securely.",
            )
        }
    }

    override suspend fun remove(connectionId: String) {
        try {
            withContext(io) { prefs.edit().remove(key(connectionId)).commit() }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            // Sign-out proceeds either way: a token that could not be erased is
            // already unusable without the connection this call is deleting.
        }
    }

    private fun key(connectionId: String): String = "token.$connectionId"

    companion object {
        const val PREFS_NAME = "companion_device_token"

        fun openPrefs(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        private fun isLocked(error: Throwable): Boolean {
            val chain = generateSequence(error) { it.cause }.toList()
            return chain.any {
                it is KeyStoreException ||
                    it is AEADBadTagException ||
                    "User not authenticated" in (it.message.orEmpty()) ||
                    "keystore" in (it.message.orEmpty().lowercase()) &&
                    "locked" in (it.message.orEmpty().lowercase())
            }
        }
    }
}

class TokenStoreException(
    val locked: Boolean,
    cause: Throwable,
) : Exception(cause.message ?: "Couldn't access the pairing securely.", cause)
