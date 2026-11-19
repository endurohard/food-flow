package ru.foodflow.pos

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.foodflow.pos.data.ApiParser
import ru.foodflow.pos.data.CartLine
import ru.foodflow.pos.data.CartModifier
import ru.foodflow.pos.data.CustomerChoice
import ru.foodflow.pos.data.LoyaltyDiscount
import ru.foodflow.pos.data.SaleSyncer
import ru.foodflow.pos.data.db.PosDatabase
import ru.foodflow.pos.data.db.SaleEntity
import ru.foodflow.pos.fiscal.FiscalItems

/** Скидка по карте: та же формула в копейках, что в order-service. */
class LoyaltyDiscountTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun line(id: String, price: Long, qty: Int = 1, noDiscount: Boolean = false,
                     mods: List<CartModifier> = emptyList()) =
        CartLine(id, "Позиция $id", price, qty, "none", mods, noDiscount)

    private fun customer(percent: Int, tier: String? = "gold") =
        CustomerChoice("p1", "Анна", "4567", 10, tier, percent)

    @Test
    fun `скидка 10 процентов от суммы в копейках`() {
        val t = LoyaltyDiscount.compute(listOf(line("a", 25000), line("b", 15000, 2)), customer(10))
        assertEquals(55000L, t.subtotalKopecks)
        assertEquals(5500L, t.discountKopecks)
        assertEquals(49500L, t.totalKopecks)
    }

    @Test
    fun `округление половины копейки вверх`() {
        // 105 коп × 10% = 10,5 коп → 11; 104 коп × 10% = 10,4 → 10
        assertEquals(11L, LoyaltyDiscount.discountKopecks(105, 10))
        assertEquals(10L, LoyaltyDiscount.discountKopecks(104, 10))
        // 12345 × 5% = 617,25 → 617; 12350 × 5% = 617,5 → 618
        assertEquals(617L, LoyaltyDiscount.discountKopecks(12345, 5))
        assertEquals(618L, LoyaltyDiscount.discountKopecks(12350, 5))
        // сверка формулы сервера (eligible*p+50)/100 на переборе
        for (kop in 0L..3000L) for (p in listOf(1, 3, 7, 10, 15, 33, 50, 99, 100)) {
            assertEquals((kop * p + 50) / 100, LoyaltyDiscount.discountKopecks(kop, p))
        }
    }

    @Test
    fun `позиция без скидки не входит в базу и не получает долю скидки`() {
        val lines = listOf(line("coffee", 20000), line("beans", 100000, noDiscount = true))
        val t = LoyaltyDiscount.compute(lines, customer(10))
        assertEquals(20000L, t.eligibleKopecks)
        assertEquals(2000L, t.discountKopecks)
        assertEquals(118000L, t.totalKopecks)
        assertEquals(listOf(2000L, 0L), t.lineDiscounts)
    }

    @Test
    fun `доплата модификатора входит в базу скидки`() {
        val milk = CartModifier("m1", "Овсяное молоко", 5050)
        val t = LoyaltyDiscount.compute(listOf(line("latte", 20000, qty = 1, mods = listOf(milk))), customer(10))
        // (25050 * 10 + 50) / 100 = 2505
        assertEquals(25050L, t.eligibleKopecks)
        assertEquals(2505L, t.discountKopecks)
    }

    @Test
    fun `без клиента или с нулём скидки нет`() {
        val lines = listOf(line("a", 30000))
        assertEquals(0L, LoyaltyDiscount.compute(lines, null).discountKopecks)
        assertEquals(0L, LoyaltyDiscount.compute(lines, customer(0)).discountKopecks)
        // Клиент из старого ответа/кеша без discountPercent — скидка 0
        val legacy = CustomerChoice("p", "Б", null, 0)
        assertEquals(30000L, LoyaltyDiscount.compute(lines, legacy).totalKopecks)
        // Мусорный процент не даёт странной суммы
        assertEquals(0L, LoyaltyDiscount.discountKopecks(30000, 150))
    }

    @Test
    fun `скидка раскладывается по строкам, остаток копеек на последнюю со скидкой`() {
        val lines = listOf(
            line("a", 333), line("b", 333), line("free", 1000, noDiscount = true), line("c", 334)
        )
        val t = LoyaltyDiscount.compute(lines, customer(10))
        // eligible 1000 → скидка 100; доли: 33, 33, 0, остаток 34
        assertEquals(100L, t.discountKopecks)
        assertEquals(listOf(33L, 33L, 0L, 34L), t.lineDiscounts)
        assertEquals(t.discountKopecks, t.lineDiscounts.sum())
    }

    @Test
    fun `сумма позиций фискального чека равна итогу со скидкой`() {
        val lines = listOf(line("a", 17990, qty = 3), line("b", 9950), line("beans", 89000, noDiscount = true))
        val t = LoyaltyDiscount.compute(lines, customer(7))
        val items = FiscalItems.build(lines, t.discountPercent)
        assertEquals(t.totalKopecks, items.sumOf { it.sumKopecks })
        // Позиция без скидки — сумма без изменений
        assertNull(items[2].amountKopecks)
        assertEquals(89000L, items[2].sumKopecks)
    }

    @Test
    fun `платёж и фискальный чек на сервер — с итогом со скидкой`() {
        val sale = SaleEntity(
            id = "s1", restaurantId = "r1", registerId = "reg", orderType = "pickup",
            paymentMethod = "card", totalKopecks = 49500, linesJson = "[]", createdAt = 0,
            paymentIdempotencyKey = "k", discountKopecks = 5500, discountPercent = 10
        )
        val pay = json.parseToJsonElement(SaleSyncer.paymentJson(sale, "o1")).jsonObject
        assertEquals(495.0, pay["amount"]!!.jsonPrimitive.double, 0.0)
        val fr = json.parseToJsonElement(SaleSyncer.fiscalReceiptJson(sale, "o1")).jsonObject
        assertEquals(495.0, fr["totalAmount"]!!.jsonPrimitive.double, 0.0)
    }

    @Test
    fun `уровень и процент клиента разбираются из lookup`() {
        val list = ApiParser.customers(json, """{"customers":[
            {"id":"p1","name":"Анна","phoneTail":"4567","points":120,"tier":"gold","discountPercent":10},
            {"id":"p2","name":"Борис","phoneTail":null,"points":0},
            {"id":"p3","name":"Вера","points":5,"tier":"platinum","discountPercent":"15"}]}""")
        assertEquals("gold", list[0].tier)
        assertEquals(10, list[0].discountPercent)
        assertEquals("Золото 10%", list[0].discountLabel)
        assertEquals(0, list[1].discountPercent)
        assertNull(list[1].tier)
        assertEquals(15, list[2].discountPercent)
        assertEquals("Платина 15%", list[2].discountLabel)
    }

    @Test
    fun `признак без скидки разбирается и переживает сериализацию строки`() {
        val items = ApiParser.menuItems(json, """{"items":[
            {"id":"i1","name":"Зерно 1 кг","price":"1500.00","no_discount":true},
            {"id":"i2","name":"Латте","price":250}]}""", "none")
        assertTrue(items[0].noDiscount)
        assertFalse(items[1].noDiscount)
        // Строка без поля (продажа, записанная до обновления) читается как «со скидкой»
        val old = Json { ignoreUnknownKeys = true }.decodeFromString(CartLine.serializer(),
            """{"menuItemId":"i2","name":"Латте","unitPriceKopecks":25000,"quantity":1,"vatRate":"none"}""")
        assertFalse(old.noDiscount)
        val back = json.decodeFromString(CartLine.serializer(),
            json.encodeToString(CartLine.serializer(), old.copy(noDiscount = true)))
        assertTrue(back.noDiscount)
    }

    @Test
    fun `миграция 2-3 добавляет колонки с теми же умолчаниями, что в сущностях`() {
        val sql = PosDatabase.MIGRATION_2_3_SQL.joinToString("\n")
        for (col in listOf("menu_items ADD COLUMN no_discount INTEGER NOT NULL DEFAULT 0",
                           "menu_modifiers ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
                           "menu_modifiers ADD COLUMN variety TEXT",
                           "menu_modifiers ADD COLUMN variety_item_id TEXT",
                           "sales ADD COLUMN discount_kopecks INTEGER NOT NULL DEFAULT 0",
                           "sales ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0",
                           "sales ADD COLUMN customer_tier TEXT")) {
            assertTrue("нет: $col", sql.contains(col))
        }
        // Только ADD COLUMN: очередь неотправленных продаж не должна теряться
        assertTrue(PosDatabase.MIGRATION_2_3_SQL.all { it.startsWith("ALTER TABLE") && "ADD COLUMN" in it })
        assertEquals(2, PosDatabase.MIGRATION_2_3.startVersion)
        assertEquals(3, PosDatabase.MIGRATION_2_3.endVersion)
    }
}
