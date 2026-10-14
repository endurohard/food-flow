package ru.foodflow.pos

import android.app.Application
import androidx.room.Room
import ru.foodflow.pos.data.PosRepository
import ru.foodflow.pos.data.Settings
import ru.foodflow.pos.data.db.PosDatabase
import ru.foodflow.pos.data.net.ApiClient
import ru.foodflow.pos.fiscal.FiscalDriver
import ru.foodflow.pos.fiscal.driver.AtolDriverFiscalDriver
import ru.foodflow.pos.fiscal.driver.StubFiscalDriver
import ru.foodflow.pos.sync.SyncWorker

/**
 * Ручной DI: приложение маленькое, Hilt сюда тащить незачем.
 */
class PosApplication : Application() {

    lateinit var settings: Settings
        private set
    lateinit var api: ApiClient
        private set
    lateinit var database: PosDatabase
        private set
    lateinit var repository: PosRepository
        private set

    /** Реальный драйвер ККТ; подменяется на заглушку, если фискализация выключена. */
    lateinit var fiscalDriver: FiscalDriver
        private set

    private val stubDriver = StubFiscalDriver()

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        api = ApiClient(settings)
        database = Room.databaseBuilder(this, PosDatabase::class.java, "ff_pos.db")
            // Схему меняем только вверх по версии; данные продаж терять нельзя,
            // поэтому деструктивная миграция НЕ включена.
            .build()
        repository = PosRepository(database, api, settings)
        fiscalDriver = AtolDriverFiscalDriver(this)

        SyncWorker.schedulePeriodic(this)
        SyncWorker.syncNow(this)
    }

    /** Драйвер с учётом настройки «печатать фискальный чек». */
    fun activeFiscalDriver(): FiscalDriver =
        if (settings.fiscalEnabled) fiscalDriver else stubDriver
}
