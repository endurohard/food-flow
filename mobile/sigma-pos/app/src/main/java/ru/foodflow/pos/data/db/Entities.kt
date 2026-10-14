package ru.foodflow.pos.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/** Категория меню, выгруженная с сервера для работы без сети. */
@Entity(tableName = "menu_categories")
data class CategoryEntity(
    @PrimaryKey val id: String,
    val name: String,
    @ColumnInfo(name = "sort_order") val sortOrder: Int = 0
)

/** Позиция меню. Цена в копейках, чтобы не ловить ошибки округления Double. */
@Entity(tableName = "menu_items")
data class MenuItemEntity(
    @PrimaryKey val id: String,
    val name: String,
    @ColumnInfo(name = "category_id") val categoryId: String?,
    @ColumnInfo(name = "price_kopecks") val priceKopecks: Long,
    @ColumnInfo(name = "is_available") val isAvailable: Boolean = true,
    /** Стоп-лист: время постановки и срок, как в веб-кассе. */
    @ColumnInfo(name = "stopped_at") val stoppedAt: Long? = null,
    @ColumnInfo(name = "stop_until") val stopUntil: Long? = null,
    @ColumnInfo(name = "vat_rate") val vatRate: String? = null
) {
    /** Повторяет POS.isStopped() из pos.html. */
    fun isStopped(now: Long = System.currentTimeMillis()): Boolean {
        if (!isAvailable) return true
        if (stoppedAt == null) return false
        if (stopUntil != null && stopUntil < now) return false
        return true
    }
}

/** Модификатор позиции (добавка). */
@Entity(tableName = "menu_modifiers")
data class ModifierEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "menu_item_id") val menuItemId: String,
    val name: String,
    @ColumnInfo(name = "price_adjustment_kopecks") val priceAdjustmentKopecks: Long,
    @ColumnInfo(name = "group_name") val groupName: String? = null
)

/**
 * Продажа, оформленная на терминале. Источник истины для оффлайна:
 * чек пробивается локально, а заказ/платёж доезжают на сервер отдельно.
 */
@Entity(tableName = "sales")
data class SaleEntity(
    /** Локальный UUID — он же idempotency-key создания заказа. */
    @PrimaryKey val id: String,
    @ColumnInfo(name = "restaurant_id") val restaurantId: String,
    @ColumnInfo(name = "register_id") val registerId: String?,
    @ColumnInfo(name = "order_type") val orderType: String,
    @ColumnInfo(name = "payment_method") val paymentMethod: String,
    @ColumnInfo(name = "total_kopecks") val totalKopecks: Long,
    @ColumnInfo(name = "cash_got_kopecks") val cashGotKopecks: Long? = null,
    /** Позиции чека в JSON — хранить отдельной таблицей избыточно. */
    @ColumnInfo(name = "lines_json") val linesJson: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,

    // ── фискализация ──────────────────────────────────────────────────────
    /** pending | printed | failed | disabled */
    @ColumnInfo(name = "fiscal_status") val fiscalStatus: String = "pending",
    @ColumnInfo(name = "fiscal_receipt_number") val fiscalReceiptNumber: String? = null,
    @ColumnInfo(name = "fiscal_document_number") val fiscalDocumentNumber: String? = null,
    @ColumnInfo(name = "fiscal_sign") val fiscalSign: String? = null,
    @ColumnInfo(name = "fiscal_shift_number") val fiscalShiftNumber: String? = null,
    @ColumnInfo(name = "ofd_url") val ofdUrl: String? = null,
    @ColumnInfo(name = "fiscal_error") val fiscalError: String? = null,

    // ── синхронизация с бэкендом ──────────────────────────────────────────
    /** pending | synced | failed */
    @ColumnInfo(name = "sync_status") val syncStatus: String = "pending",
    /** id заказа, присвоенный order-service после синхронизации. */
    @ColumnInfo(name = "server_order_id") val serverOrderId: String? = null,
    @ColumnInfo(name = "server_order_number") val serverOrderNumber: String? = null,
    /** Отдельный ключ идемпотентности для POST /api/finance/payments. */
    @ColumnInfo(name = "payment_idempotency_key") val paymentIdempotencyKey: String,
    @ColumnInfo(name = "payment_synced") val paymentSynced: Boolean = false,
    @ColumnInfo(name = "cash_operation_synced") val cashOperationSynced: Boolean = false,
    @ColumnInfo(name = "fiscal_synced") val fiscalSynced: Boolean = false,
    @ColumnInfo(name = "sync_attempts") val syncAttempts: Int = 0,
    @ColumnInfo(name = "last_sync_error") val lastSyncError: String? = null,
    @ColumnInfo(name = "synced_at") val syncedAt: Long? = null
)
