package org.openmausbot.android

import android.app.Application
import org.openmausbot.android.data.Repo
import org.openmausbot.android.notify.Notifier

class MausApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Repo.init(this)
        Notifier.createChannels(this)
    }
}
