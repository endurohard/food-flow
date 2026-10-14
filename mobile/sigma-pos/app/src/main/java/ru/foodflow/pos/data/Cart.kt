package ru.foodflow.pos.data

import kotlinx.serialization.Serializable

/** Строка чека в корзине. Все суммы — копейки. */
@Serializable
data class CartLine(
    val menuItemId: String,
    val name: String,
    val unitPriceKopecks: Long,
    val quantity: Int,
    val vatRate: String,
    val modifiers: List<CartModifier> = emptyList()
) {
    /** Цена с добавками за одну штуку. */
    val effectiveUnitPriceKopecks: Long
        get() = unitPriceKopecks + modifiers.sumOf { it.priceAdjustmentKopecks }

    val sumKopecks: Long get() = effectiveUnitPriceKopecks * quantity

    /** Ключ для склейки одинаковых позиций с одинаковым набором добавок. */
    val mergeKey: String
        get() = menuItemId + "|" + modifiers.map { it.modifierId }.sorted().joinToString(",")
}

@Serializable
data class CartModifier(
    val modifierId: String,
    val name: String,
    val priceAdjustmentKopecks: Long
)

/** Корзина — неизменяемая, операции возвращают новый экземпляр. */
data class Cart(val lines: List<CartLine> = emptyList()) {

    val totalKopecks: Long get() = lines.sumOf { it.sumKopecks }
    val isEmpty: Boolean get() = lines.isEmpty()
    val itemCount: Int get() = lines.sumOf { it.quantity }

    fun add(line: CartLine): Cart {
        val idx = lines.indexOfFirst { it.mergeKey == line.mergeKey }
        if (idx < 0) return Cart(lines + line)
        val existing = lines[idx]
        val merged = existing.copy(quantity = existing.quantity + line.quantity)
        return Cart(lines.toMutableList().also { it[idx] = merged })
    }

    fun changeQuantity(mergeKey: String, delta: Int): Cart {
        val idx = lines.indexOfFirst { it.mergeKey == mergeKey }
        if (idx < 0) return this
        val next = lines[idx].quantity + delta
        val list = lines.toMutableList()
        if (next <= 0) list.removeAt(idx) else list[idx] = lines[idx].copy(quantity = next)
        return Cart(list)
    }

    fun remove(mergeKey: String): Cart = Cart(lines.filterNot { it.mergeKey == mergeKey })

    fun clear(): Cart = Cart()
}

/** Форматирование денег: копейки → «1 234,50 ₽». */
object Money {
    fun format(kopecks: Long): String {
        val sign = if (kopecks < 0) "-" else ""
        val abs = kotlin.math.abs(kopecks)
        val rub = abs / 100
        val kop = abs % 100
        val grouped = rub.toString()
            .reversed()
            .chunked(3)
            .joinToString("\u00A0")
            .reversed()
        return if (kop == 0L) "$sign$grouped ₽" else "$sign$grouped,%02d ₽".format(kop)
    }

    /** «123.45» / «123,45» → 12345 копеек. */
    fun parse(text: String): Long? {
        val cleaned = text.trim().replace(',', '.').replace("\u00A0", "").replace(" ", "")
        if (cleaned.isEmpty()) return null
        val value = cleaned.toDoubleOrNull() ?: return null
        return Math.round(value * 100)
    }
}
