package ru.foodflow.pos.data.db

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Dao
interface MenuDao {

    @Query("SELECT * FROM menu_categories ORDER BY sort_order, name")
    fun observeCategories(): Flow<List<CategoryEntity>>

    @Query("SELECT * FROM menu_items ORDER BY name")
    fun observeItems(): Flow<List<MenuItemEntity>>

    @Query("SELECT * FROM menu_modifiers WHERE menu_item_id = :itemId")
    suspend fun modifiersFor(itemId: String): List<ModifierEntity>

    @Query("SELECT COUNT(*) FROM menu_items")
    suspend fun itemCount(): Int

    /**
     * Полная замена меню одной транзакцией: при обрыве посреди обновления
     * касса не останется с половиной позиций.
     */
    @Transaction
    suspend fun replaceMenu(
        categories: List<CategoryEntity>,
        items: List<MenuItemEntity>,
        modifiers: List<ModifierEntity>
    ) {
        clearCategories()
        clearItems()
        clearModifiers()
        insertCategories(categories)
        insertItems(items)
        insertModifiers(modifiers)
    }

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertCategories(rows: List<CategoryEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertItems(rows: List<MenuItemEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertModifiers(rows: List<ModifierEntity>)

    @Query("DELETE FROM menu_categories")
    suspend fun clearCategories()

    @Query("DELETE FROM menu_items")
    suspend fun clearItems()

    @Query("DELETE FROM menu_modifiers")
    suspend fun clearModifiers()
}

@Dao
interface SaleDao {

    @Insert
    suspend fun insert(sale: SaleEntity)

    @Query("SELECT * FROM sales WHERE id = :id")
    suspend fun byId(id: String): SaleEntity?

    @Query("SELECT * FROM sales ORDER BY created_at DESC LIMIT :limit")
    fun observeRecent(limit: Int = 100): Flow<List<SaleEntity>>

    /** Очередь на отправку: берём самые старые, чтобы порядок чеков сохранялся. */
    @Query(
        """SELECT * FROM sales
           WHERE sync_status != 'synced'
           ORDER BY created_at ASC
           LIMIT :limit"""
    )
    suspend fun pendingSync(limit: Int = 50): List<SaleEntity>

    @Query("SELECT COUNT(*) FROM sales WHERE sync_status != 'synced'")
    fun observePendingCount(): Flow<Int>

    /** Чеки, которые не удалось пробить на ФР — кассир должен их видеть. */
    @Query("SELECT COUNT(*) FROM sales WHERE fiscal_status = 'failed'")
    fun observeFiscalFailedCount(): Flow<Int>

    @Query(
        """UPDATE sales SET
             fiscal_status = :status,
             fiscal_receipt_number = :receiptNumber,
             fiscal_document_number = :documentNumber,
             fiscal_sign = :fiscalSign,
             fiscal_shift_number = :shiftNumber,
             ofd_url = :ofdUrl,
             fiscal_error = :error
           WHERE id = :id"""
    )
    suspend fun updateFiscal(
        id: String,
        status: String,
        receiptNumber: String?,
        documentNumber: String?,
        fiscalSign: String?,
        shiftNumber: String?,
        ofdUrl: String?,
        error: String?
    )

    @Query(
        """UPDATE sales SET
             sync_status = :status,
             server_order_id = :orderId,
             server_order_number = :orderNumber,
             payment_synced = :paymentSynced,
             cash_operation_synced = :cashSynced,
             fiscal_synced = :fiscalSynced,
             sync_attempts = sync_attempts + 1,
             last_sync_error = :error,
             synced_at = :syncedAt
           WHERE id = :id"""
    )
    suspend fun updateSync(
        id: String,
        status: String,
        orderId: String?,
        orderNumber: String?,
        paymentSynced: Boolean,
        cashSynced: Boolean,
        fiscalSynced: Boolean,
        error: String?,
        syncedAt: Long?
    )

    /** Итоги смены по локальным данным — нужны даже когда сервер недоступен. */
    @Query(
        """SELECT COALESCE(SUM(total_kopecks), 0) FROM sales
           WHERE payment_method = :method AND created_at >= :since"""
    )
    suspend fun totalSince(method: String, since: Long): Long

    @Query("SELECT COUNT(*) FROM sales WHERE created_at >= :since")
    suspend fun countSince(since: Long): Int
}

@Database(
    entities = [
        CategoryEntity::class,
        MenuItemEntity::class,
        ModifierEntity::class,
        SaleEntity::class
    ],
    version = 3,
    exportSchema = false
)
abstract class PosDatabase : RoomDatabase() {
    abstract fun menuDao(): MenuDao
    abstract fun saleDao(): SaleDao

    companion object {
        /**
         * 1 → 2: клиент лояльности в продаже. Только ADD COLUMN: в таблице
         * может лежать очередь неотправленных продаж, терять её нельзя
         * (деструктивная миграция в приложении выключена намеренно).
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE sales ADD COLUMN customer_profile_id TEXT")
                db.execSQL("ALTER TABLE sales ADD COLUMN customer_name TEXT")
            }
        }

        /**
         * 2 → 3: «без скидки» у позиции, сорта у модификаторов, скидка по карте
         * в продаже. Снова только ADD COLUMN — очередь продаж сохраняется.
         * DEFAULT совпадает с defaultValue в сущностях: иначе Room при проверке
         * схемы сочтёт таблицу не той и уронит приложение на старте.
         */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                MIGRATION_2_3_SQL.forEach { db.execSQL(it) }
            }
        }

        /** Вынесено списком, чтобы тест сверял его с колонками сущностей. */
        val MIGRATION_2_3_SQL = listOf(
            "ALTER TABLE menu_items ADD COLUMN no_discount INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE menu_modifiers ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE menu_modifiers ADD COLUMN variety TEXT",
            "ALTER TABLE menu_modifiers ADD COLUMN variety_item_id TEXT",
            "ALTER TABLE sales ADD COLUMN discount_kopecks INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE sales ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE sales ADD COLUMN customer_tier TEXT"
        )
    }
}
