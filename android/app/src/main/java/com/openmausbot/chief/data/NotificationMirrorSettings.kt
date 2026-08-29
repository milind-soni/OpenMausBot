package com.openmausbot.chief.data

import android.content.ComponentName
import android.content.Context
import android.provider.Settings

object NotificationMirrorSettings {
    fun isEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
        return enabled.split(':')
            .mapNotNull(ComponentName::unflattenFromString)
            .any { it.packageName == context.packageName && it.className == "${context.packageName}.MausNotificationMirrorService" }
    }
}
