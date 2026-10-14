package ru.foodflow.pos.fiscal

/** Ставка НДС в терминах 54-ФЗ. */
enum class VatRate(val code: String, val title: String) {
    NONE("none", "без НДС"),
    VAT_0("vat0", "НДС 0%"),
    VAT_10("vat10", "НДС 10%"),
    VAT_20("vat20", "НДС 20%"),
    VAT_110("vat110", "НДС 10/110"),
    VAT_120("vat120", "НДС 20/120");

    companion object {
        fun from(code: String?): VatRate =
            entries.firstOrNull { it.code.equals(code, ignoreCase = true) } ?: NONE
    }
}

/** Система налогообложения. Коды — по тегу 1055 в заданиях драйвера ККТ. */
enum class TaxationType(val code: String, val title: String) {
    OSN("osn", "ОСН"),
    USN_INCOME("usnIncome", "УСН доход"),
    USN_INCOME_OUTCOME("usnIncomeOutcome", "УСН доход-расход"),
    ESN("esn", "ЕСХН"),
    PATENT("patent", "Патент");

    companion object {
        fun from(code: String?): TaxationType =
            entries.firstOrNull { it.code.equals(code, ignoreCase = true) } ?: USN_INCOME
    }
}

/** Тип оплаты в чеке. */
enum class PaymentType(val code: String) {
    CASH("cash"),
    ELECTRONIC("electronic")
}

/** Позиция фискального чека. Все суммы — в копейках. */
data class FiscalItem(
    val name: String,
    val priceKopecks: Long,
    val quantity: Double,
    val vat: VatRate,
    /** Признак предмета расчёта (тег 1212): для блюд — товар. */
    val paymentObject: String = "commodity",
    /** Признак способа расчёта (тег 1214): полный расчёт. */
    val paymentMethod: String = "fullPayment"
) {
    val sumKopecks: Long get() = Math.round(priceKopecks * quantity)
}

/** Запрос на чек прихода / возврата прихода. */
data class FiscalReceiptRequest(
    /** Локальный id продажи — сквозной ключ для сопоставления с бэкендом. */
    val saleId: String,
    val items: List<FiscalItem>,
    val paymentType: PaymentType,
    /** Фактически полученная сумма (для наличных — с учётом сдачи). */
    val paidKopecks: Long,
    val taxation: TaxationType,
    val isRefund: Boolean = false,
    val cashierName: String? = null,
    /** Email или телефон покупателя для электронного чека. */
    val customerContact: String? = null,
    val placeName: String? = null
) {
    val totalKopecks: Long get() = items.sumOf { it.sumKopecks }
}

/** Фискальные реквизиты напечатанного чека. */
data class FiscalReceiptResult(
    val receiptNumber: String?,
    val fiscalDocumentNumber: String?,
    val fiscalSign: String?,
    val shiftNumber: String?,
    val ofdUrl: String?,
    val rawResponse: String? = null
)

/** Состояние смены на фискальном регистраторе. */
data class ShiftState(
    val isOpen: Boolean,
    val shiftNumber: String? = null,
    /** Смена длится больше 24 часов — ФР откажет в чеке, нужно закрыть. */
    val isExpired: Boolean = false
)

/** Ошибка фискализации с различением «можно повторить» и «нельзя». */
class FiscalException(
    message: String,
    val code: String? = null,
    val recoverable: Boolean = true,
    cause: Throwable? = null
) : Exception(message, cause)

/**
 * Драйвер фискального регистратора. Реализации:
 *  - [ru.foodflow.pos.fiscal.driver.IntentFiscalDriver] — через приложение кассы АТОЛ Sigma;
 *  - [ru.foodflow.pos.fiscal.driver.StubFiscalDriver] — заглушка для стенда без ФР.
 */
interface FiscalDriver {

    /** Человекочитаемое имя драйвера для экрана настроек. */
    val name: String

    /** Доступен ли драйвер на этом устройстве (установлено ли приложение кассы). */
    suspend fun isAvailable(): Boolean

    suspend fun shiftState(): ShiftState

    suspend fun openShift(): ShiftState

    suspend fun closeShift(): FiscalReceiptResult

    suspend fun printXReport(): FiscalReceiptResult

    /** Пробить чек. Бросает [FiscalException] — вызывающий решает, повторять ли. */
    suspend fun printReceipt(request: FiscalReceiptRequest): FiscalReceiptResult

    /** Внесение/изъятие наличных в денежный ящик ФР. */
    suspend fun cashIn(amountKopecks: Long): FiscalReceiptResult

    suspend fun cashOut(amountKopecks: Long): FiscalReceiptResult
}
