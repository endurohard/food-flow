package ru.foodflow.pos.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import ru.foodflow.pos.data.db.SaleEntity
import ru.foodflow.pos.data.net.ApiClient
import ru.foodflow.pos.data.net.ApiResult

/**
 * Один шаг синхронизации продажи с бэкендом. Разбит на три независимые
 * части (заказ → платёж → касса → фискальный чек), каждая со своим флагом:
 * если сеть упала посередине, повтор не создаст дубль.
 */
class SaleSyncer(
    private val api: ApiClient,
    private val repo: PosRepository
) {

    sealed class Outcome {
        object Synced : Outcome()
        /** Нет сети — надо повторить позже, ошибку не показываем кассиру. */
        data class Retry(val reason: String) : Outcome()
        /** Сервер отверг запрос — требуется вмешательство. */
        data class Failed(val reason: String) : Outcome()
    }

    suspend fun sync(sale: SaleEntity): Outcome {
        var orderId = sale.serverOrderId
        var orderNumber = sale.serverOrderNumber
        var paymentSynced = sale.paymentSynced
        var cashSynced = sale.cashOperationSynced
        var fiscalSynced = sale.fiscalSynced

        // ── 1. Заказ ───────────────────────────────────────────────────────
        if (orderId == null) {
            when (val res = api.post("/api/orders", orderBody(sale), idempotencyKey = sale.id)) {
                is ApiResult.Ok -> {
                    val obj = ApiParser.obj(api.json, res.value, "order")
                        ?: return finish(sale, Outcome.Failed("Пустой ответ сервера на заказ"),
                            orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                    orderId = ApiParser.str(obj, "id")
                        ?: return finish(sale, Outcome.Failed("В ответе нет id заказа"),
                            orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                    orderNumber = ApiParser.str(obj, "order_number", "orderNumber")
                }
                is ApiResult.Offline -> return finish(sale, Outcome.Retry(res.cause),
                    orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                is ApiResult.HttpError -> return finish(sale, Outcome.Failed(res.message),
                    orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
            }

            // Заказ в работу (KDS). Не критично — ошибку игнорируем.
            api.put("/api/orders/$orderId/status", """{"status":"confirmed"}""")
        }

        // ── 2. Платёж ──────────────────────────────────────────────────────
        if (!paymentSynced) {
            val body = buildJsonObject {
                put("orderId", orderId)
                put("amount", sale.totalKopecks / 100.0)
                put("paymentMethod", sale.paymentMethod)
                put("status", "completed")
                put("paymentGateway", if (sale.paymentMethod == "cash") "cash" else "terminal")
            }.toString()
            when (val res = api.post("/api/finance/payments", body, sale.paymentIdempotencyKey)) {
                is ApiResult.Ok -> paymentSynced = true
                is ApiResult.Offline -> return finish(sale, Outcome.Retry(res.cause),
                    orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                is ApiResult.HttpError -> {
                    // Бэкенд старой версии не принимает status при создании —
                    // создаём без него и доводим статус отдельным запросом.
                    if (res.code == 400) {
                        val fallback = buildJsonObject {
                            put("orderId", orderId)
                            put("amount", sale.totalKopecks / 100.0)
                            put("paymentMethod", sale.paymentMethod)
                        }.toString()
                        val retryKey = sale.paymentIdempotencyKey + "-r"
                        when (val r2 = api.post("/api/finance/payments", fallback, retryKey)) {
                            is ApiResult.Ok -> {
                                paymentSynced = true
                                ApiParser.obj(api.json, r2.value, "payment")
                                    ?.let { ApiParser.str(it, "id") }
                                    ?.let { pid ->
                                        api.put("/api/finance/payments/$pid/status",
                                            """{"status":"completed"}""")
                                    }
                            }
                            is ApiResult.Offline -> return finish(sale, Outcome.Retry(r2.cause),
                                orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                            is ApiResult.HttpError -> return finish(sale,
                                Outcome.Failed("Платёж: " + r2.message),
                                orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                        }
                    } else {
                        return finish(sale, Outcome.Failed("Платёж: " + res.message),
                            orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                    }
                }
            }
        }

        // ── 3. Кассовая операция по наличным ───────────────────────────────
        if (!cashSynced) {
            if (sale.paymentMethod == "cash" && sale.registerId != null) {
                val body = buildJsonObject {
                    put("operationType", "sale")
                    put("amount", sale.totalKopecks / 100.0)
                    put("paymentMethod", "cash")
                    put("orderId", orderId)
                }.toString()
                when (val res = api.post(
                    "/api/finance/registers/${sale.registerId}/operations", body
                )) {
                    is ApiResult.Ok -> cashSynced = true
                    is ApiResult.Offline -> return finish(sale, Outcome.Retry(res.cause),
                        orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                    // Смена закрыта / нет прав — продажа всё равно учтена,
                    // блокировать очередь из-за кассовой операции нельзя.
                    is ApiResult.HttpError -> cashSynced = true
                }
            } else {
                cashSynced = true
            }
        }

        // ── 4. Фискальный чек ──────────────────────────────────────────────
        if (!fiscalSynced) {
            if (sale.fiscalStatus == "printed") {
                val body = buildJsonObject {
                    put("orderId", orderId)
                    put("registerId", sale.registerId)
                    put("receiptNumber", sale.fiscalReceiptNumber ?: sale.id.take(8))
                    put("fiscalSign", sale.fiscalSign)
                    put("fiscalDocumentNumber", sale.fiscalDocumentNumber)
                    put("ofdUrl", sale.ofdUrl)
                    put("receiptType", "sale")
                    put("totalAmount", sale.totalKopecks / 100.0)
                    put("vatAmount", 0.0)
                }.toString()
                when (val res = api.post("/api/finance/fiscal-receipts", body, sale.id + "-fiscal")) {
                    is ApiResult.Ok -> fiscalSynced = true
                    is ApiResult.Offline -> return finish(sale, Outcome.Retry(res.cause),
                        orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
                    // Роут может отсутствовать на старом бэкенде (404) —
                    // чек напечатан, терять продажу из-за этого нельзя.
                    is ApiResult.HttpError -> fiscalSynced = true
                }
            } else {
                fiscalSynced = true
            }
        }

        return finish(sale, Outcome.Synced, orderId, orderNumber, paymentSynced, cashSynced, fiscalSynced)
    }

    private fun orderBody(sale: SaleEntity): String {
        val lines = repo.decodeLines(sale.linesJson)
        return buildJsonObject {
            put("restaurantId", sale.restaurantId)
            put("orderType", sale.orderType)
            put("paymentMethod", sale.paymentMethod)
            put("items", buildJsonArray {
                lines.forEach { line ->
                    add(buildJsonObject {
                        put("menuItemId", line.menuItemId)
                        put("quantity", line.quantity)
                        if (line.modifiers.isNotEmpty()) {
                            put("modifiers", buildJsonArray {
                                line.modifiers.forEach { m ->
                                    add(buildJsonObject {
                                        put("modifierId", m.modifierId)
                                        put("name", m.name)
                                        put("priceAdjustment", m.priceAdjustmentKopecks / 100.0)
                                    })
                                }
                            })
                        }
                    })
                }
            })
        }.toString()
    }

    private suspend fun finish(
        sale: SaleEntity,
        outcome: Outcome,
        orderId: String?,
        orderNumber: String?,
        paymentSynced: Boolean,
        cashSynced: Boolean,
        fiscalSynced: Boolean
    ): Outcome {
        val status = when (outcome) {
            is Outcome.Synced -> "synced"
            is Outcome.Retry -> "pending"
            is Outcome.Failed -> "failed"
        }
        val error = when (outcome) {
            is Outcome.Synced -> null
            is Outcome.Retry -> outcome.reason
            is Outcome.Failed -> outcome.reason
        }
        repo.markSync(
            id = sale.id,
            status = status,
            orderId = orderId,
            orderNumber = orderNumber,
            paymentSynced = paymentSynced,
            cashSynced = cashSynced,
            fiscalSynced = fiscalSynced,
            error = error,
            syncedAt = if (outcome is Outcome.Synced) System.currentTimeMillis() else null
        )
        return outcome
    }
}
