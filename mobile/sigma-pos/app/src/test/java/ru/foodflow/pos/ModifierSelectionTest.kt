package ru.foodflow.pos

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.foodflow.pos.data.ApiParser
import ru.foodflow.pos.data.ModifierSelection
import ru.foodflow.pos.data.db.ModifierEntity

/** Группа сортов — «ровно один вариант», прочие группы — мультивыбор. */
class ModifierSelectionTest {

    private fun variety(id: String, default: Boolean = false, itemId: String = "beans-$id") =
        ModifierEntity(id, "latte", "Сорт $id", 0, "Зерно", default, "Сорт $id", itemId)

    private fun extra(id: String, default: Boolean = false) =
        ModifierEntity(id, "latte", "Добавка $id", 5000, "Добавки", default)

    private val mods = listOf(
        variety("brazil"), variety("ethiopia", default = true), variety("kenya"),
        extra("syrup"), extra("milk", default = true)
    )

    @Test
    fun `группа из одних сортов — радио, обычная — галочки`() {
        val g = ModifierSelection.groups(mods)
        assertEquals(2, g.size)
        assertTrue(g.first { it.name == "Зерно" }.singleChoice)
        assertFalse(g.first { it.name == "Добавки" }.singleChoice)
        // Смешанная группа — не радио
        val mixed = ModifierSelection.groups(listOf(variety("a"), extra("b").copy(groupName = "Зерно")))
        assertFalse(mixed.single().singleChoice)
    }

    @Test
    fun `при открытии предвыбраны варианты по умолчанию`() {
        assertEquals(setOf("ethiopia", "milk"), ModifierSelection.initial(mods))
    }

    @Test
    fun `два умолчания в группе сортов — предвыбран только первый`() {
        val two = listOf(variety("a", default = true), variety("b", default = true))
        assertEquals(setOf("a"), ModifierSelection.initial(two))
    }

    @Test
    fun `без умолчания ничего не выбрано, но выбрать можно только один`() {
        val noDefault = listOf(variety("a"), variety("b"))
        assertTrue(ModifierSelection.initial(noDefault).isEmpty())
        var sel = ModifierSelection.toggle(noDefault, emptySet(), "a")
        sel = ModifierSelection.toggle(noDefault, sel, "b")
        assertEquals(setOf("b"), sel)
    }

    @Test
    fun `выбор второго сорта снимает первый, добавки не трогает`() {
        val sel = ModifierSelection.toggle(mods, setOf("ethiopia", "milk"), "kenya")
        assertEquals(setOf("kenya", "milk"), sel)
        // Повторное нажатие на выбранный сорт оставляет его выбранным
        assertEquals(setOf("kenya", "milk"), ModifierSelection.toggle(mods, sel, "kenya"))
    }

    @Test
    fun `обычная группа остаётся мультивыбором`() {
        var sel = ModifierSelection.toggle(mods, setOf("milk"), "syrup")
        assertEquals(setOf("milk", "syrup"), sel)
        sel = ModifierSelection.toggle(mods, sel, "milk")
        assertEquals(setOf("syrup"), sel)
    }

    @Test
    fun `два сорта на один variety_item_id отсекаются до сервера`() {
        val same = listOf(variety("a", itemId = "X"), variety("b", itemId = "X").copy(groupName = "Другая"))
        assertEquals("Выберите один сорт", ModifierSelection.validate(same, setOf("a", "b")))
        assertNull(ModifierSelection.validate(same, setOf("a")))
    }

    @Test
    fun `новые поля модификатора разбираются`() {
        val list = ApiParser.modifiers(Json { ignoreUnknownKeys = true }, """{"modifiers":[
            {"id":"m1","name":"Эфиопия","price_adjustment":"0.00","is_default":true,
             "variety":"Эфиопия Иргачефф","variety_item_id":"11111111-1111-1111-1111-111111111111",
             "modifier_group":"Зерно"},
            {"id":"m2","name":"Сироп","price_adjustment":"50.00","is_default":false,
             "variety":null,"variety_item_id":null,"modifier_group":null}]}""", "latte")
        assertTrue(list[0].isDefault)
        assertEquals("Эфиопия Иргачефф", list[0].variety)
        assertEquals("11111111-1111-1111-1111-111111111111", list[0].varietyItemId)
        assertEquals("Зерно", list[0].groupName)
        assertTrue(list[0].isVariety)
        assertFalse(list[1].isDefault)
        assertNull(list[1].variety)
        assertFalse(list[1].isVariety)
        assertNull(list[1].groupName)
        assertEquals(5000L, list[1].priceAdjustmentKopecks)
    }
}
