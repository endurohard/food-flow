package ru.foodflow.pos.fiscal.driver

import ru.foodflow.pos.fiscal.FiscalDriver
import ru.foodflow.pos.fiscal.FiscalReceiptRequest
import ru.foodflow.pos.fiscal.FiscalReceiptResult
import ru.foodflow.pos.fiscal.ShiftState
import java.util.concurrent.atomic.AtomicInteger

/**
 * Заглушка ФР: ведёт себя как настоящий драйвер, но ничего не печатает.
 * Нужна, чтобы кассу можно было отлаживать на обычном планшете и чтобы
 * приложение не падало на устройстве без установленной «Сигма Кассы».
 *
 * Продажи, пробитые этим драйвером, помечаются fiscal_status = 'disabled' —
 * их нельзя считать фискализированными.
 */
class StubFiscalDriver : FiscalDriver {

    override val name: String = "Без фискализации (заглушка)"

    private var shiftOpen = false
    private val docCounter = AtomicInteger(0)
    private var shiftNo = 0

    override suspend fun isAvailable(): Boolean = true

    override suspend fun shiftState(): ShiftState =
        ShiftState(isOpen = shiftOpen, shiftNumber = shiftNo.takeIf { it > 0 }?.toString())

    override suspend fun openShift(): ShiftState {
        shiftOpen = true
        shiftNo += 1
        return shiftState()
    }

    override suspend fun closeShift(): FiscalReceiptResult {
        shiftOpen = false
        return stubResult()
    }

    override suspend fun printXReport(): FiscalReceiptResult = stubResult()

    override suspend fun printReceipt(request: FiscalReceiptRequest): FiscalReceiptResult =
        stubResult()

    override suspend fun cashIn(amountKopecks: Long): FiscalReceiptResult = stubResult()

    override suspend fun cashOut(amountKopecks: Long): FiscalReceiptResult = stubResult()

    private fun stubResult() = FiscalReceiptResult(
        receiptNumber = docCounter.incrementAndGet().toString(),
        fiscalDocumentNumber = null,
        fiscalSign = null,
        shiftNumber = shiftNo.takeIf { it > 0 }?.toString(),
        ofdUrl = null,
        rawResponse = "stub"
    )
}
