package ru.foodflow.pos.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.foodflow.pos.data.db.CategoryEntity
import ru.foodflow.pos.data.db.MenuItemEntity
import ru.foodflow.pos.data.db.ModifierEntity
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Разбор ответов FoodFlow. Бэкенд отдаёт данные неконсистентно
 * (`{restaurants}`, `{items}`, `{data}`, `{success,data}`), поэтому вся
 * терпимость к форме ответа собрана здесь, а не размазана по коду.
 */
object ApiParser {

    private val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    /** Достаёт массив из ответа по списку возможных ключей. */
    fun array(json: Json, text: String, vararg keys: String): JsonArray {
        val root = runCatching { json.parseToJsonElement(text) }.getOrNull() ?: return JsonArray(emptyList())
        if (root is JsonArray) return root
        val obj = root as? JsonObject ?: return JsonArray(emptyList())
        for (k in keys) {
            (obj[k] as? JsonArray)?.let { return it }
        }
        // Вложенный data: {success:true, data:{items:[...]}} или {data:[...]}
        val data = obj["data"]
        if (data is JsonArray) return data
        val dataObj = data as? JsonObject
        if (dataObj != null) {
            for (k in keys) {
                (dataObj[k] as? JsonArray)?.let { return it }
            }
        }
        return JsonArray(emptyList())
    }

    /** Достаёт объект из ответа: сам объект, `data`, либо один из ключей. */
    fun obj(json: Json, text: String, vararg keys: String): JsonObject? {
        val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
        for (k in keys) {
            (root[k] as? JsonObject)?.let { return it }
        }
        (root["data"] as? JsonObject)?.let { return it }
        return root
    }

    fun str(obj: JsonObject, vararg keys: String): String? {
        for (k in keys) {
            val v = obj[k]?.jsonPrimitive?.contentOrNull() ?: continue
            return v
        }
        return null
    }

    fun bool(obj: JsonObject, vararg keys: String): Boolean? {
        for (k in keys) {
            obj[k]?.jsonPrimitive?.booleanOrNull?.let { return it }
        }
        return null
    }

    /** Цена приходит строкой («450.00») или числом — DECIMAL из Postgres. */
    fun kopecks(obj: JsonObject, vararg keys: String): Long {
        for (k in keys) {
            val p = obj[k]?.jsonPrimitive ?: continue
            p.doubleOrNull?.let { return Math.round(it * 100) }
            p.contentOrNull()?.toDoubleOrNull()?.let { return Math.round(it * 100) }
        }
        return 0L
    }

    fun millis(obj: JsonObject, vararg keys: String): Long? {
        val raw = str(obj, *keys) ?: return null
        // Формат «2026-09-02T12:34:56.789Z» — отрезаем дробную часть и зону
        val trimmed = raw.substringBefore('.').substringBefore('Z').take(19)
        return runCatching { iso.parse(trimmed)?.time }.getOrNull()
    }

    fun categories(json: Json, text: String): List<CategoryEntity> =
        array(json, text, "categories").mapIndexedNotNull { i, el ->
            val o = el as? JsonObject ?: return@mapIndexedNotNull null
            val id = str(o, "id") ?: return@mapIndexedNotNull null
            CategoryEntity(
                id = id,
                name = str(o, "name") ?: "Без названия",
                sortOrder = (str(o, "sort_order", "sortOrder")?.toIntOrNull()) ?: i
            )
        }

    fun menuItems(json: Json, text: String, defaultVat: String): List<MenuItemEntity> =
        array(json, text, "items", "menuItems").mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val id = str(o, "id") ?: return@mapNotNull null
            MenuItemEntity(
                id = id,
                name = str(o, "name") ?: "Без названия",
                categoryId = str(o, "category_id", "categoryId"),
                priceKopecks = kopecks(o, "price", "base_price", "basePrice"),
                isAvailable = bool(o, "is_available", "isAvailable") ?: true,
                stoppedAt = millis(o, "stopped_at", "stoppedAt"),
                stopUntil = millis(o, "stop_until", "stopUntil"),
                vatRate = str(o, "vat_rate", "vatRate") ?: defaultVat,
                noDiscount = loyaltyDiscountBlocked(o)
            )
        }

    /**
     * Запрещена ли скидка по карте на позицию. Источник истины —
     * loyalty_discount_allowed (по умолчанию на сервере true); no_discount новый
     * сервер отдаёт всегда false, поэтому он учитывается только когда нового
     * поля нет вовсе (старый сервер). promo_discount_allowed касса не читает:
     * акции она не считает.
     */
    fun loyaltyDiscountBlocked(o: JsonObject): Boolean {
        bool(o, "loyalty_discount_allowed", "loyaltyDiscountAllowed")?.let { return !it }
        return bool(o, "no_discount", "noDiscount") ?: false
    }

    /** Ответ GET /api/crm/customers/lookup: {customers:[{id,name,phoneTail,points,tier,discountPercent}]} */
    fun customers(json: Json, text: String): List<CustomerChoice> =
        array(json, text, "customers").mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val id = str(o, "id") ?: return@mapNotNull null
            CustomerChoice(
                id = id,
                name = str(o, "name") ?: "Без имени",
                phoneTail = str(o, "phoneTail"),
                points = str(o, "points")?.toDoubleOrNull()?.toLong() ?: 0L,
                tier = str(o, "tier"),
                cardNumber = str(o, "cardNumber", "card_number")?.trim()?.takeIf { it.isNotEmpty() },
                // Нет поля (старый сервер) или мусор — скидки нет
                discountPercent = LoyaltyDiscount.normalizePercent(
                    str(o, "discountPercent", "discount_percent")?.toDoubleOrNull()
                        ?.takeIf { it == Math.floor(it) }?.toInt()
                )
            )
        }

    /**
     * Ответ POST /api/crm/customers/{id}/card-link. Без url или message
     * отправлять нечего — тогда null, и экран скажет, что ответ непонятный.
     * Полный телефон (`phone`) намеренно не разбирается: касса его не
     * показывает, а sms-ссылку и так несёт smsUri.
     */
    fun cardLink(json: Json, text: String): CardLink? {
        val o = obj(json, text, "cardLink") ?: return null
        val url = str(o, "url") ?: return null
        val message = str(o, "message") ?: return null
        return CardLink(
            url = url,
            cardNumber = str(o, "cardNumber", "card_number"),
            customerName = str(o, "customerName", "customer_name"),
            message = message,
            smsUri = str(o, "smsUri", "sms_uri"),
            telegramUrl = str(o, "telegramUrl", "telegram_url")
        )
    }

    fun modifiers(json: Json, text: String, menuItemId: String): List<ModifierEntity> =
        array(json, text, "modifiers").mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val id = str(o, "id") ?: return@mapNotNull null
            ModifierEntity(
                id = id,
                menuItemId = menuItemId,
                name = str(o, "name") ?: "Добавка",
                priceAdjustmentKopecks = kopecks(o, "price_adjustment", "priceAdjustment", "price"),
                groupName = str(o, "modifier_group", "modifierGroup", "group_name", "groupName"),
                isDefault = bool(o, "is_default", "isDefault") ?: false,
                variety = str(o, "variety"),
                varietyItemId = str(o, "variety_item_id", "varietyItemId")
            )
        }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
    content.takeIf { it.isNotBlank() && it != "null" }

/** Клиент лояльности в списке кассы: только то, что нужно для выбора. */
data class CustomerChoice(
    val id: String,
    val name: String,
    val phoneTail: String?,
    val points: Long,
    /** Уровень карты: bronze | silver | gold | platinum. */
    val tier: String? = null,
    /** Скидка уровня, целое 0..100; 0 — программы/скидки нет. */
    val discountPercent: Int = 0,
    /** Номер карты гостя (8 цифр); null — старый сервер или карты нет. */
    val cardNumber: String? = null
) {
    val label: String
        get() = name + (phoneTail?.let { " · …$it" } ?: "")

    /** «Золото 10%» для строки скидки в чеке. */
    val discountLabel: String
        get() = listOfNotNull(LoyaltyTier.title(tier), "$discountPercent%").joinToString(" ")
}

/** Ссылка на веб-карту гостя для отправки клиенту (живёт только в памяти). */
data class CardLink(
    val url: String,
    val cardNumber: String?,
    val customerName: String?,
    /** Готовый текст сообщения со ссылкой. */
    val message: String,
    /** sms:+7…?&body=… ; null — у клиента нет телефона. */
    val smsUri: String?,
    val telegramUrl: String?
)

/**
 * Автовыбор клиента по номеру карты: сканер-клавиатура вбивает 8 цифр в поле
 * поиска, и кассиру незачем ещё раз тыкать в единственную строку. Только при
 * однозначном совпадении: ровно один результат и его номер карты равен
 * введённому — иначе (поиск по цифрам телефона дал кого-то ещё) выбирает человек.
 */
object CustomerAutoPick {
    private val cardRe = Regex("^\\d{8}$")

    fun isCardNumber(query: String): Boolean = cardRe.matches(query.trim())

    fun pick(query: String, results: List<CustomerChoice>): CustomerChoice? {
        val q = query.trim()
        if (!isCardNumber(q)) return null
        val only = results.singleOrNull() ?: return null
        return if (only.cardNumber == q) only else null
    }
}
