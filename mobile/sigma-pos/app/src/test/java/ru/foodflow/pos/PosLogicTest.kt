package ru.foodflow.pos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.foodflow.pos.data.Cart
import ru.foodflow.pos.data.CartLine
import ru.foodflow.pos.data.CartModifier
import ru.foodflow.pos.data.Money
import ru.foodflow.pos.data.db.MenuItemEntity

class MoneyTest {

    @Test
    fun `формат целых рублей без копеек`() {
        assertEquals("450 ₽", Money.format(45000))
    }

    @Test
    fun `формат с копейками`() {
        assertEquals("450,50 ₽", Money.format(45050))
        assertEquals("0,05 ₽", Money.format(5))
    }

    @Test
    fun `разряды разделяются`() {
        // Неразрывный пробел между разрядами
        assertEquals("1\u00A0234 ₽", Money.format(123400))
        assertEquals("1\u00A0234\u00A0567,89 ₽", Money.format(123456789))
    }

    @Test
    fun `отрицательная сумма — сдача не может потеряться в знаке`() {
        assertEquals("-50 ₽", Money.format(-5000))
    }

    @Test
    fun `парсинг точки и запятой`() {
        assertEquals(45050L, Money.parse("450.50"))
        assertEquals(45050L, Money.parse("450,50"))
        assertEquals(50000L, Money.parse(" 500 "))
    }

    @Test
    fun `парсинг мусора возвращает null`() {
        assertNull(Money.parse("abc"))
        assertNull(Money.parse(""))
    }

    @Test
    fun `округление копеек не теряет рубль`() {
        // 0.1 + 0.2 в double = 0.30000000000000004; округление должно дать 30 копеек
        assertEquals(30L, Money.parse("0.3"))
        assertEquals(10L, Money.parse("0.1"))
    }
}

class CartTest {

    private fun line(
        id: String = "item-1",
        price: Long = 45000,
        qty: Int = 1,
        mods: List<CartModifier> = emptyList()
    ) = CartLine(
        menuItemId = id,
        name = "Позиция $id",
        unitPriceKopecks = price,
        quantity = qty,
        vatRate = "none",
        modifiers = mods
    )

    @Test
    fun `одинаковые позиции склеиваются`() {
        val cart = Cart().add(line()).add(line())
        assertEquals(1, cart.lines.size)
        assertEquals(2, cart.lines.first().quantity)
        assertEquals(90000, cart.totalKopecks)
    }

    @Test
    fun `позиции с разными добавками не склеиваются`() {
        val withCheese = line(mods = listOf(CartModifier("m1", "Сыр", 5000)))
        val cart = Cart().add(line()).add(withCheese)
        assertEquals(2, cart.lines.size)
        assertEquals(45000 + 50000, cart.totalKopecks)
    }

    @Test
    fun `порядок добавок не влияет на склейку`() {
        val a = line(mods = listOf(CartModifier("m1", "Сыр", 5000), CartModifier("m2", "Соус", 2000)))
        val b = line(mods = listOf(CartModifier("m2", "Соус", 2000), CartModifier("m1", "Сыр", 5000)))
        val cart = Cart().add(a).add(b)
        assertEquals("разный порядок добавок — одна позиция", 1, cart.lines.size)
        assertEquals(2, cart.lines.first().quantity)
    }

    @Test
    fun `добавка входит в сумму позиции`() {
        val cart = Cart().add(line(mods = listOf(CartModifier("m1", "Сыр", 5000)), qty = 3))
        assertEquals((45000L + 5000L) * 3, cart.totalKopecks)
    }

    @Test
    fun `уменьшение до нуля удаляет позицию`() {
        var cart = Cart().add(line())
        val key = cart.lines.first().mergeKey
        cart = cart.changeQuantity(key, -1)
        assertTrue(cart.isEmpty)
        assertEquals(0, cart.totalKopecks)
    }

    @Test
    fun `изменение количества несуществующей позиции безопасно`() {
        val cart = Cart().add(line())
        val same = cart.changeQuantity("нет-такого-ключа", 5)
        assertEquals(1, same.lines.first().quantity)
    }

    @Test
    fun `подсчёт количества штук`() {
        val cart = Cart().add(line(qty = 2)).add(line(id = "item-2", qty = 3))
        assertEquals(5, cart.itemCount)
    }
}

class StopListTest {

    private fun item(
        available: Boolean = true,
        stoppedAt: Long? = null,
        stopUntil: Long? = null
    ) = MenuItemEntity(
        id = "i1",
        name = "Блюдо",
        categoryId = null,
        priceKopecks = 10000,
        isAvailable = available,
        stoppedAt = stoppedAt,
        stopUntil = stopUntil
    )

    private val now = 1_000_000_000L

    @Test
    fun `доступная позиция не в стопе`() {
        assertFalse(item().isStopped(now))
    }

    @Test
    fun `is_available false — всегда стоп`() {
        assertTrue(item(available = false).isStopped(now))
    }

    @Test
    fun `стоп без срока действует бессрочно`() {
        assertTrue(item(stoppedAt = now - 1000).isStopped(now))
    }

    @Test
    fun `истёкший стоп снимается автоматически`() {
        assertFalse(item(stoppedAt = now - 5000, stopUntil = now - 1000).isStopped(now))
    }

    @Test
    fun `действующий стоп с будущим сроком`() {
        assertTrue(item(stoppedAt = now - 5000, stopUntil = now + 1000).isStopped(now))
    }
}
