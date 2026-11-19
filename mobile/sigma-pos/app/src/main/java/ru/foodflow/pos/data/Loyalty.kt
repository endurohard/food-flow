package ru.foodflow.pos.data

/** Названия уровней карты лояльности для чека. */
object LoyaltyTier {
    private val names = mapOf(
        "bronze" to "Бронза",
        "silver" to "Серебро",
        "gold" to "Золото",
        "platinum" to "Платина"
    )

    /** Неизвестный уровень показываем как есть: лучше сырой код, чем пустота в чеке. */
    fun title(tier: String?): String? =
        tier?.takeIf { it.isNotBlank() }?.let { names[it.lowercase()] ?: it }
}

/**
 * Разбивка чека со скидкой по карте. Все суммы — копейки.
 * [lineDiscounts] — скидка на каждую строку в порядке строк корзины
 * (нужна для построчных сумм фискального чека).
 */
data class CheckTotals(
    val subtotalKopecks: Long,
    val eligibleKopecks: Long,
    val discountPercent: Int,
    val discountKopecks: Long,
    val lineDiscounts: List<Long>
) {
    val totalKopecks: Long get() = subtotalKopecks - discountKopecks
}

/**
 * Скидка по уровню карты. Формула повторяет order-service
 * (discount.service.ts → loyaltyDiscountAmount) ДО КОПЕЙКИ — касса считает её
 * оффлайн, и сумма платежа, которую мы отправим, обязана совпасть с итогом
 * заказа на сервере. Поэтому только целочисленная арифметика в копейках,
 * никаких Double.
 */
object LoyaltyDiscount {

    /** Процент вне 0..100 — мусор в данных; лучше не дать скидку, чем дать странную. */
    fun normalizePercent(percent: Int?): Int =
        if (percent == null || percent <= 0 || percent > 100) 0 else percent

    /** loyaltyKop = (eligibleKop * percent + 50) / 100 — округление половины вверх. */
    fun discountKopecks(eligibleKopecks: Long, percent: Int): Long {
        val p = normalizePercent(percent)
        if (p == 0 || eligibleKopecks <= 0) return 0L
        return (eligibleKopecks * p + 50) / 100
    }

    /**
     * Итог чека. Скидка действует, только если выбран клиент и у него
     * процент > 0; клиент без discountPercent (старый ответ сервера) даёт 0.
     */
    fun compute(lines: List<CartLine>, customer: CustomerChoice?): CheckTotals =
        compute(lines, if (customer == null) 0 else customer.discountPercent)

    fun compute(lines: List<CartLine>, percent: Int): CheckTotals {
        val subtotal = lines.sumOf { it.sumKopecks }
        // Доплаты модификаторов входят в базу скидки: sumKopecks уже с ними
        val eligible = lines.filter { !it.noDiscount }.sumOf { it.sumKopecks }
        val p = normalizePercent(percent)
        val discount = discountKopecks(eligible, p)
        return CheckTotals(
            subtotalKopecks = subtotal,
            eligibleKopecks = eligible,
            discountPercent = if (discount > 0) p else 0,
            discountKopecks = discount,
            lineDiscounts = allocate(lines, eligible, discount)
        )
    }

    /**
     * Распределение скидки по строкам пропорционально сумме строки (с
     * округлением вниз), остаток копеек — на последнюю строку со скидкой.
     * Позиции «без скидки» получают 0. Сумма долей всегда равна [discount],
     * поэтому сумма позиций фискального чека совпадает с суммой платежа.
     */
    fun allocate(lines: List<CartLine>, eligible: Long, discount: Long): List<Long> {
        val result = MutableList(lines.size) { 0L }
        if (discount <= 0 || eligible <= 0) return result
        val lastEligible = lines.indexOfLast { !it.noDiscount && it.sumKopecks > 0 }
        if (lastEligible < 0) return result
        var given = 0L
        lines.forEachIndexed { i, line ->
            if (line.noDiscount || i == lastEligible) return@forEachIndexed
            val share = line.sumKopecks * discount / eligible
            result[i] = share
            given += share
        }
        result[lastEligible] = discount - given
        return result
    }
}
