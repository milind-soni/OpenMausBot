package com.openmausbot.chief.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
data class QueuedNotificationMirror(
    val payload: NotificationMirrorPayload,
    val enqueuedAt: Long,
)

/** Sensitive notification text is encrypted with an Android Keystore key and
 * bounded by both age and count. Server-side event ids make replay idempotent. */
class EncryptedNotificationMirrorQueue(
    context: Context,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun enqueue(payload: NotificationMirrorPayload) {
        val items = load().filterNot { it.payload.id == payload.id }.toMutableList()
        items += QueuedNotificationMirror(payload, now())
        save(items.takeLast(MAX_ITEMS))
    }

    @Synchronized
    fun pending(): List<QueuedNotificationMirror> {
        val minimum = now() - MAX_AGE_MILLIS
        val current = load().filter { it.enqueuedAt >= minimum }.takeLast(MAX_ITEMS)
        save(current)
        return current
    }

    @Synchronized
    fun remove(id: String) = save(load().filterNot { it.payload.id == id })

    private fun load(): List<QueuedNotificationMirror> = runCatching {
        val encoded = preferences.getString(QUEUE, null) ?: return emptyList()
        val parts = encoded.split('.', limit = 2)
        if (parts.size != 2) return emptyList()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, decode(parts[0])))
        WireJson.decodeFromString(
            ListSerializer(QueuedNotificationMirror.serializer()),
            cipher.doFinal(decode(parts[1])).decodeToString(),
        )
    }.getOrElse { emptyList() }

    private fun save(items: List<QueuedNotificationMirror>) {
        if (items.isEmpty()) {
            preferences.edit().remove(QUEUE).apply()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val plaintext = WireJson.encodeToString(ListSerializer(QueuedNotificationMirror.serializer()), items)
        val encrypted = cipher.doFinal(plaintext.encodeToByteArray())
        preferences.edit().putString(QUEUE, "${encode(cipher.iv)}.${encode(encrypted)}").apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)

    companion object {
        private const val PREFERENCES = "openmaus-notification-mirror-queue"
        private const val QUEUE = "queue"
        private const val KEY_ALIAS = "openmaus-notification-mirror-queue"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val MAX_ITEMS = 200
        private val MAX_AGE_MILLIS = TimeUnit.DAYS.toMillis(7)
    }
}

class NotificationMirrorWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val session = ConnectionStore(applicationContext).load() ?: return Result.success()
        val queue = EncryptedNotificationMirrorQueue(applicationContext)
        for (item in queue.pending()) {
            val outcome = runCatching { OpenMausApi(session).mirrorNotification(item.payload) }
            if (outcome.isSuccess) {
                queue.remove(item.payload.id)
                continue
            }
            if (NotificationMirrorRetryPolicy.shouldRetry(outcome.exceptionOrNull())) return Result.retry()
            queue.remove(item.payload.id)
        }
        runCatching { OpenMausApi(session).mirrorHeartbeat() }
        return Result.success()
    }

    companion object {
        private const val UNIQUE_WORK = "notification-mirror-drain"
        private const val HEARTBEAT_WORK = "notification-mirror-heartbeat"

        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<NotificationMirrorWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            // The AndroidX startup provider initializes WorkManager in the
            // installed app. Test harnesses and restricted OEM boot phases may
            // not have done so yet; the next app/service event schedules again.
            runCatching {
                WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.KEEP, request)
            }
        }

        fun scheduleHeartbeat(context: Context) {
            val request = PeriodicWorkRequestBuilder<NotificationMirrorHeartbeatWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            runCatching {
                WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    HEARTBEAT_WORK,
                    androidx.work.ExistingPeriodicWorkPolicy.KEEP,
                    request,
                )
            }
        }
    }
}

/** Content-free liveness receipt used to distinguish a quiet phone from a
 * disconnected notification listener. WorkManager may delay this under OEM
 * battery policy; the server reports that honestly as stale. */
class NotificationMirrorHeartbeatWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val session = ConnectionStore(applicationContext).load() ?: return Result.success()
        return runCatching {
            OpenMausApi(session).mirrorHeartbeat()
            Result.success()
        }.getOrElse { Result.retry() }
    }
}
