package ru.foodflow.pos.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import ru.foodflow.pos.PosApplication
import ru.foodflow.pos.data.SaleSyncer
import java.util.concurrent.TimeUnit

/**
 * Догоняет бэкенд: отправляет все продажи, оформленные локально.
 * Запускается при появлении сети, периодически и вручную из UI.
 */
class SyncWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as? PosApplication ?: return Result.success()
        val repo = app.repository
        val syncer = SaleSyncer(app.api, repo)

        val pending = repo.pendingSales()
        if (pending.isEmpty()) return Result.success()

        var needRetry = false
        for (sale in pending) {
            // Чеки отправляем строго по порядку: если упёрлись в отсутствие
            // сети — дальше идти бессмысленно, выходим и ждём следующий запуск.
            when (syncer.sync(sale)) {
                is SaleSyncer.Outcome.Synced -> Unit
                is SaleSyncer.Outcome.Retry -> {
                    needRetry = true
                    break
                }
                is SaleSyncer.Outcome.Failed -> {
                    // Продажа помечена failed и видна кассиру в журнале;
                    // очередь не блокируем, иначе встанут все остальные чеки.
                    continue
                }
            }
        }
        return if (needRetry) Result.retry() else Result.success()
    }

    companion object {
        private const val UNIQUE_PERIODIC = "ff_pos_sync_periodic"
        private const val UNIQUE_NOW = "ff_pos_sync_now"

        private val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        /** Регулярная догрузка — страховка, если разовый запуск был потерян. */
        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setBackoffCriteria(
                    androidx.work.BackoffPolicy.EXPONENTIAL,
                    30, TimeUnit.SECONDS
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }

        /** Отправить очередь прямо сейчас (после продажи или по кнопке). */
        fun syncNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(
                    androidx.work.BackoffPolicy.EXPONENTIAL,
                    15, TimeUnit.SECONDS
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_NOW,
                androidx.work.ExistingWorkPolicy.REPLACE,
                request
            )
        }
    }
}
