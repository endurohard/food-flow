package ru.foodflow.pos

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.foodflow.pos.data.ApiParser
import ru.foodflow.pos.data.CartLine
import ru.foodflow.pos.data.CustomerAutoPick
import ru.foodflow.pos.data.CustomerChoice
import ru.foodflow.pos.data.LoyaltyDiscount
import ru.foodflow.pos.data.QrCode

/** Разрешение скидки по карте у блюда, номер карты клиента и ссылка на карту гостя. */
class CardLinkAndLoyaltyFlagTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun items(body: String) = ApiParser.menuItems(json, """{"items":[$body]}""", "none")

    @Test
    fun `loyalty_discount_allowed главнее no_discount`() {
        val list = items("""
            {"id":"a","name":"Зерно","price":100,"loyalty_discount_allowed":false,"promo_discount_allowed":true,"no_discount":false},
            {"id":"b","name":"Латте","price":100,"loyalty_discount_allowed":true,"promo_discount_allowed":false,"no_discount":true}
        """)
        // Новый сервер: no_discount всегда false и не источник истины
        assertTrue("скидка по карте запрещена", list[0].noDiscount)
        assertFalse("скидка по карте разрешена", list[1].noDiscount)
    }

    @Test
    fun `без loyalty_discount_allowed — фолбэк на no_discount старого сервера`() {
        val list = items("""
            {"id":"a","name":"Зерно","price":100,"no_discount":true},
            {"id":"b","name":"Латте","price":100,"no_discount":false},
            {"id":"c","name":"Чай","price":100}
        """)
        assertTrue(list[0].noDiscount)
        assertFalse(list[1].noDiscount)
        assertFalse("нет ни одного поля — скидка разрешена", list[2].noDiscount)
    }

    @Test
    fun `скидка не берётся со строки с loyalty_discount_allowed=false`() {
        val menu = items("""
            {"id":"coffee","name":"Капучино","price":"200.00","loyalty_discount_allowed":true},
            {"id":"beans","name":"Зерно","price":"1000.00","loyalty_discount_allowed":false}
        """)
        val lines = menu.map { CartLine(it.id, it.name, it.priceKopecks, 1, "none", noDiscount = it.noDiscount) }
        val t = LoyaltyDiscount.compute(lines, 10)
        assertEquals(120000L, t.subtotalKopecks)
        assertEquals(20000L, t.eligibleKopecks)
        assertEquals(2000L, t.discountKopecks)
        assertEquals(listOf(2000L, 0L), t.lineDiscounts)
    }

    @Test
    fun `cardNumber разбирается из lookup`() {
        val list = ApiParser.customers(json, """{"customers":[
            {"id":"p1","name":"Анна","phoneTail":"4567","points":10,"cardNumber":"10000001"},
            {"id":"p2","name":"Борис","phoneTail":null,"points":0}]}""")
        assertEquals("10000001", list[0].cardNumber)
        assertNull("старый сервер без поля", list[1].cardNumber)
    }

    @Test
    fun `ответ card-link разбирается полностью`() {
        val link = ApiParser.cardLink(json, """{"url":"https://x.food-flow.ru/card/?t=abc","cardNumber":"10000001",
            "phone":"+79991234567","customerName":"Анна","message":"Анна, ваша карта: https://x.food-flow.ru/card/?t=abc",
            "smsUri":"sms:+79991234567?&body=hi","telegramUrl":"https://t.me/share/url?url=u&text=t"}""")
        assertNotNull(link)
        link!!
        assertEquals("https://x.food-flow.ru/card/?t=abc", link.url)
        assertEquals("10000001", link.cardNumber)
        assertEquals("Анна", link.customerName)
        assertEquals("Анна, ваша карта: https://x.food-flow.ru/card/?t=abc", link.message)
        assertEquals("sms:+79991234567?&body=hi", link.smsUri)
        assertEquals("https://t.me/share/url?url=u&text=t", link.telegramUrl)
    }

    @Test
    fun `card-link без телефона даёт smsUri null`() {
        val link = ApiParser.cardLink(json, """{"url":"https://x/card/?t=1","cardNumber":"10000002","phone":null,
            "customerName":"Борис","message":"Борис, карта: https://x/card/?t=1","smsUri":null,"telegramUrl":"https://t.me/share/url?url=x"}""")!!
        assertNull(link.smsUri)
        assertEquals("https://x/card/?t=1", link.url)
    }

    @Test
    fun `card-link без url или message — нечего отправлять`() {
        assertNull(ApiParser.cardLink(json, """{"message":"x"}"""))
        assertNull(ApiParser.cardLink(json, """{"url":"https://x"}"""))
        assertNull(ApiParser.cardLink(json, "не json"))
    }

    private fun c(id: String, card: String?) = CustomerChoice(id, "Клиент $id", null, 0, cardNumber = card)

    @Test
    fun `8 цифр и единственный клиент с этой картой — выбран сразу`() {
        val anna = c("p1", "10000001")
        assertSame(anna, CustomerAutoPick.pick("10000001", listOf(anna)))
        assertSame("пробелы от сканера не мешают", anna, CustomerAutoPick.pick(" 10000001\n", listOf(anna)))
    }

    @Test
    fun `два результата или чужой номер — автовыбора нет`() {
        val anna = c("p1", "10000001")
        assertNull(CustomerAutoPick.pick("10000001", listOf(anna, c("p2", "10000002"))))
        // Нашёлся по цифрам телефона, а не по карте
        assertNull(CustomerAutoPick.pick("10000001", listOf(c("p3", "10000003"))))
        assertNull(CustomerAutoPick.pick("10000001", listOf(c("p4", null))))
        assertNull(CustomerAutoPick.pick("10000001", emptyList()))
    }

    @Test
    fun `не 8 цифр — автовыбора нет даже при совпадении`() {
        assertNull(CustomerAutoPick.pick("1000000", listOf(c("p1", "1000000"))))
        assertNull(CustomerAutoPick.pick("100000011", listOf(c("p1", "100000011"))))
        assertNull(CustomerAutoPick.pick("1000000a", listOf(c("p1", "1000000a"))))
    }

    @Test
    fun `QR ссылки строится`() {
        val m = QrCode.matrix("https://x.food-flow.ru/card/?t=abc", 200)
        assertEquals(200, m.size)
        assertTrue(m.dark.any { it })
        assertTrue(m.dark.any { !it })
    }
}
