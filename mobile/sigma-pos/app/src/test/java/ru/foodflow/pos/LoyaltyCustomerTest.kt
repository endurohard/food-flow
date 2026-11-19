package ru.foodflow.pos

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.foodflow.pos.data.ApiParser
import ru.foodflow.pos.data.CartLine
import ru.foodflow.pos.data.SaleSyncer
import ru.foodflow.pos.data.db.SaleEntity

/** Клиент лояльности в чеке Sigma: разбор списка и тело заказа. */
class LoyaltyCustomerTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun sale(customer: String?) = SaleEntity(
        id = "s1", restaurantId = "r1", registerId = null, orderType = "pickup",
        paymentMethod = "card", totalKopecks = 30000, linesJson = "[]", createdAt = 0,
        paymentIdempotencyKey = "k1", customerProfileId = customer, customerName = customer?.let { "Анна" }
    )

    @Test
    fun `список клиентов разбирается из ответа lookup`() {
        val list = ApiParser.customers(json,
            """{"customers":[{"id":"p1","name":"Анна ТЕСТ","phoneTail":"4567","points":120},{"id":"p2","name":"Борис","phoneTail":null,"points":0}]}""")
        assertEquals(2, list.size)
        assertEquals("Анна ТЕСТ · …4567", list[0].label)
        assertEquals(120L, list[0].points)
        assertEquals("Борис", list[1].label)
    }

    @Test
    fun `клиент уходит в заказ как customerProfileId`() {
        val body = json.parseToJsonElement(SaleSyncer.orderJson(sale("p1"), emptyList<CartLine>())).jsonObject
        assertEquals("p1", body["customerProfileId"]?.jsonPrimitive?.content)
    }

    @Test
    fun `без клиента поля нет — сервер оставит прежнее поведение`() {
        val body = json.parseToJsonElement(SaleSyncer.orderJson(sale(null), emptyList<CartLine>())).jsonObject
        assertFalse(body.containsKey("customerProfileId"))
        assertTrue(body.containsKey("items"))
    }
}
