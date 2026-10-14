package ru.foodflow.pos.fiscal.driver

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import ru.foodflow.pos.fiscal.FiscalDriver
import ru.foodflow.pos.fiscal.FiscalException
import ru.foodflow.pos.fiscal.FiscalReceiptRequest
import ru.foodflow.pos.fiscal.FiscalReceiptResult
import ru.foodflow.pos.fiscal.PaymentType
import ru.foodflow.pos.fiscal.ShiftState

/**
 * Драйвер ККТ АТОЛ 10 (libfptr10), встроенный в смарт-терминалы Sigma.
 *
 * Транспорт — JSON-задания: setParam(LIBFPTR_PARAM_JSON_DATA, task) →
 * processJson() → getParamString(LIBFPTR_PARAM_JSON_DATA).
 * Признак ошибки у драйвера — отрицательный код возврата (не `!= 0`).
 *
 * Класс драйвера подключается РЕФЛЕКСИЕЙ, чтобы:
 *  - проект собирался без aar вендора в app/libs (CI, отладка на планшете);
 *  - на устройстве без драйвера касса не падала, а честно сообщала
 *    «ФР недоступен» и работала в нефискальном режиме.
 *
 * Положи libfptr10.aar (личный кабинет АТОЛ / integration.atol.ru)
 * в app/libs — драйвер подхватится автоматически.
 */
class AtolDriverFiscalDriver(private val context: Context) : FiscalDriver {

    override val name: String = "АТОЛ Драйвер ККТ 10 (Sigma)"

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private var fptr: Any? = null
    private var fptrClass: Class<*>? = null

    /** LIBFPTR_PARAM_JSON_DATA читаем из самого SDK, а не хардкодим. */
    private var paramJsonData: Int? = null

    private fun resolveClass(): Class<*>? {
        fptrClass?.let { return it }
        for (fqn in CANDIDATE_CLASSES) {
            runCatching { Class.forName(fqn) }.getOrNull()?.let {
                fptrClass = it
                return it
            }
        }
        return null
    }

    /**
     * Константа LIBFPTR_PARAM_JSON_DATA объявлена в интерфейсе IFptr.
     * Берём её значение из SDK: хардкод сломается при смене версии драйвера.
     */
    private fun paramJsonDataConst(cls: Class<*>): Int {
        paramJsonData?.let { return it }
        val candidates = buildList {
            add(cls)
            addAll(cls.interfaces)
            runCatching { Class.forName("ru.atol.drivers10.fptr.IFptr") }.getOrNull()?.let { add(it) }
            runCatching { Class.forName("com.atol.drivers10.fptr.IFptr") }.getOrNull()?.let { add(it) }
        }
        for (c in candidates) {
            val field = runCatching { c.getField("LIBFPTR_PARAM_JSON_DATA") }.getOrNull() ?: continue
            val value = runCatching { field.getInt(null) }.getOrNull() ?: continue
            paramJsonData = value
            return value
        }
        // Значение в текущих сборках Драйвера ККТ 10 — на случай, если
        // поле недоступно через рефлексию (обфускация).
        return FALLBACK_PARAM_JSON_DATA.also { paramJsonData = it }
    }

    private fun driver(): Any {
        fptr?.let { return it }
        val cls = resolveClass()
            ?: throw FiscalException(
                "Драйвер ККТ не найден. Положите libfptr10.aar в app/libs " +
                    "или установите «Драйвер ККТ» от АТОЛ на терминал.",
                code = "no_driver",
                recoverable = false
            )
        val instance = runCatching {
            // На Android конструктору нужен Context; у части сборок он пустой
            runCatching { cls.getConstructor(Context::class.java).newInstance(context) }
                .getOrElse { cls.getDeclaredConstructor().newInstance() }
        }.getOrElse {
            throw FiscalException(
                "Не удалось инициализировать драйвер ККТ: ${it.message}",
                code = "driver_init",
                cause = it
            )
        }
        // Соединение с ККТ: без open() задания вернут «нет связи с устройством»
        runCatching { cls.getMethod("open").invoke(instance) }
        fptr = instance
        return instance
    }

    private fun processJson(task: String): JsonObject {
        val d = driver()
        val cls = d.javaClass
        val param = paramJsonDataConst(cls)

        val setParam = cls.methods.firstOrNull {
            it.name == "setParam" && it.parameterCount == 2 &&
                it.parameterTypes[1] == String::class.java
        } ?: throw FiscalException("Драйвер ККТ не поддерживает setParam", code = "api_mismatch")

        val processJson = cls.methods.firstOrNull {
            it.name == "processJson" && it.parameterCount == 0
        } ?: throw FiscalException(
            "Нужен Драйвер ККТ 10 — текущая библиотека не умеет processJson",
            code = "api_mismatch",
            recoverable = false
        )

        val getParamString = cls.methods.firstOrNull {
            it.name == "getParamString" && it.parameterCount == 1
        } ?: throw FiscalException("Драйвер ККТ не поддерживает getParamString", code = "api_mismatch")

        setParam.invoke(d, param, task)
        val rc = (processJson.invoke(d) as? Int) ?: 0
        val answer = (getParamString.invoke(d, param) as? String).orEmpty()

        // Контракт драйвера: ошибка — ОТРИЦАТЕЛЬНЫЙ код возврата
        if (rc < 0) {
            val errorCode = runCatching {
                cls.getMethod("errorCode").invoke(d) as? Int
            }.getOrNull()
            val desc = runCatching {
                cls.getMethod("errorDescription").invoke(d) as? String
            }.getOrNull()
            val parsed = runCatching { json.parseToJsonElement(answer).jsonObject }.getOrNull()
            val msg = parsed?.resultDescription() ?: desc ?: "код $rc"
            throw FiscalException(
                "ККТ: $msg",
                code = errorCode?.toString() ?: rc.toString(),
                recoverable = errorCode !in NON_RECOVERABLE_ERRORS
            )
        }

        val root = runCatching { json.parseToJsonElement(answer).jsonObject }
            .getOrElse { JsonObject(emptyMap()) }

        // Ответ Android-сервиса завёрнут в {result:{error,description}, data:{...}};
        // при вызове из aar обёртки нет — приходит сразу тело.
        val resultError = (root["result"] as? JsonObject)
            ?.get("error")?.jsonPrimitive?.content?.toIntOrNull()
        if (resultError != null && resultError != 0) {
            throw FiscalException(
                "ККТ: " + (root.resultDescription() ?: "ошибка $resultError"),
                code = resultError.toString(),
                recoverable = resultError !in NON_RECOVERABLE_ERRORS
            )
        }
        return (root["data"] as? JsonObject) ?: root
    }

    private fun JsonObject.resultDescription(): String? =
        (this["result"] as? JsonObject)?.get("description")?.jsonPrimitive?.content
            ?: this["description"]?.jsonPrimitive?.content

    override suspend fun isAvailable(): Boolean = withContext(Dispatchers.IO) {
        resolveClass() != null && runCatching { shiftStateBlocking() }.isSuccess
    }

    override suspend fun shiftState(): ShiftState = withContext(Dispatchers.IO) {
        shiftStateBlocking()
    }

    private fun shiftStateBlocking(): ShiftState {
        val res = processJson(task("getShiftStatus"))
        val status = (res["shiftStatus"] as? JsonObject) ?: res
        // state: closed | opened | expired
        val state = status["state"]?.jsonPrimitive?.content
        val number = status["number"]?.jsonPrimitive?.content
        return ShiftState(
            isOpen = state == "opened" || state == "expired",
            shiftNumber = number,
            isExpired = state == "expired"
        )
    }

    override suspend fun openShift(): ShiftState = withContext(Dispatchers.IO) {
        processJson(task("openShift"))
        shiftStateBlocking()
    }

    /** Z-отчёт отдельным заданием не печатается: он есть closeShift. */
    override suspend fun closeShift(): FiscalReceiptResult = withContext(Dispatchers.IO) {
        toResult(processJson(task("closeShift")))
    }

    override suspend fun printXReport(): FiscalReceiptResult = withContext(Dispatchers.IO) {
        toResult(processJson(task("reportX")))
    }

    override suspend fun cashIn(amountKopecks: Long): FiscalReceiptResult =
        withContext(Dispatchers.IO) {
            toResult(processJson(buildJsonObject {
                put("type", "cashIn")
                put("cashSum", amountKopecks / 100.0)
            }.toString()))
        }

    override suspend fun cashOut(amountKopecks: Long): FiscalReceiptResult =
        withContext(Dispatchers.IO) {
            toResult(processJson(buildJsonObject {
                put("type", "cashOut")
                put("cashSum", amountKopecks / 100.0)
            }.toString()))
        }

    override suspend fun printReceipt(request: FiscalReceiptRequest): FiscalReceiptResult =
        withContext(Dispatchers.IO) {
            val shift = shiftStateBlocking()
            if (shift.isExpired) {
                throw FiscalException(
                    "Смена на ККТ открыта больше 24 часов — закройте смену (Z-отчёт)",
                    code = "shift_expired",
                    recoverable = false
                )
            }
            if (!shift.isOpen) processJson(task("openShift"))

            val data = processJson(receiptTask(request))

            // Документ может быть закрыт в ФН, но не допечатан (кончилась бумага).
            // Продажа при этом состоялась — чек фискализирован, нужно лишь довести печать.
            val notPrinted = (data["warnings"] as? JsonObject)
                ?.get("notPrinted")?.jsonPrimitive?.booleanOrNull == true
            if (notPrinted) {
                runCatching { processJson(task("continuePrint")) }
            }
            toResult(data)
        }

    /** Задание «чек прихода»/«возврат прихода» по контракту Драйвера ККТ 10. */
    private fun receiptTask(r: FiscalReceiptRequest): String = buildJsonObject {
        put("type", if (r.isRefund) "sellReturn" else "sell")
        put("taxationType", r.taxation.code)
        val electronic = !r.customerContact.isNullOrBlank()
        put("electronically", electronic)
        r.cashierName?.let { putJsonObject("operator") { put("name", it) } }
        // При electronically = true контакт покупателя обязателен
        if (electronic) {
            putJsonObject("clientInfo") { put("emailOrPhone", r.customerContact) }
        }
        r.placeName?.let { put("paymentsPlace", it) }

        put("items", buildJsonArray {
            r.items.forEach { item ->
                add(buildJsonObject {
                    put("type", "position")
                    put("name", item.name)
                    put("price", item.priceKopecks / 100.0)
                    put("quantity", item.quantity)
                    put("amount", item.sumKopecks / 100.0)
                    put("department", 1)
                    // Для ФФД 1.2 единица измерения обязательна
                    put("measurementUnit", "piece")
                    put("paymentObject", item.paymentObject)
                    put("paymentMethod", item.paymentMethod)
                    putJsonObject("tax") { put("type", item.vat.code) }
                })
            }
        })

        put("payments", buildJsonArray {
            add(buildJsonObject {
                put("type", if (r.paymentType == PaymentType.CASH) "cash" else "electronically")
                // Передаём ровно сумму чека: сдачу считает касса, в ФД
                // переплаты быть не должно.
                put("sum", r.totalKopecks / 100.0)
            })
        })
        put("total", r.totalKopecks / 100.0)
    }.toString()

    private fun task(type: String): String = buildJsonObject { put("type", type) }.toString()

    private fun toResult(res: JsonObject): FiscalReceiptResult {
        val p = (res["fiscalParams"] as? JsonObject) ?: res
        fun s(vararg keys: String): String? {
            for (k in keys) p[k]?.jsonPrimitive?.content
                ?.takeIf { it.isNotBlank() && it != "null" }
                ?.let { return it }
            return null
        }
        val fnsUrl = s("fnsUrl")
        return FiscalReceiptResult(
            receiptNumber = s("fiscalReceiptNumber", "fiscalDocumentNumber"),
            fiscalDocumentNumber = s("fiscalDocumentNumber"),
            // ФПД — тег 1077
            fiscalSign = s("fiscalDocumentSign"),
            shiftNumber = s("shiftNumber"),
            // Ссылки ОФД в fiscalParams нет; адрес проверки чека — сайт ФНС
            ofdUrl = fnsUrl?.let { if (it.startsWith("http")) it else "https://$it" },
            rawResponse = res.toString()
        )
    }

    private companion object {
        /** Класс драйвера менялся между сборками SDK — пробуем известные имена. */
        val CANDIDATE_CLASSES = listOf(
            "ru.atol.drivers10.fptr.Fptr",
            "com.atol.drivers10.fptr.Fptr",
            "ru.atol.drivers10.fptr.IFptr",
            "com.atol.drivers10.fptr.IFptr"
        )

        /** Резерв, если константу не удалось прочитать из SDK. */
        const val FALLBACK_PARAM_JSON_DATA = 65651

        /**
         * Ошибки, при которых повтор бессмысленен без действий человека:
         * 73 — смена закрыта, 74 — смена открыта >24ч, 80 — ФН не найден.
         */
        val NON_RECOVERABLE_ERRORS = setOf(73, 74, 80)
    }
}
