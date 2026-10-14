package ru.foodflow.pos.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * После перезагрузки терминала очередь продаж должна продолжить доезжать
 * сама, без запуска приложения кассиром.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            SyncWorker.schedulePeriodic(context)
            SyncWorker.syncNow(context)
        }
    }
}
