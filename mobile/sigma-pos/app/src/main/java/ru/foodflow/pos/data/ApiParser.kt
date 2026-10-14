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
                vatRate = str(o, "vat_rate", "vatRate") ?: defaultVat
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
                groupName = str(o, "group_name", "groupName")
            )
        }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
    content.takeIf { it.isNotBlank() && it != "null" }
