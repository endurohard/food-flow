package ru.foodflow.pos.data

import ru.foodflow.pos.data.db.ModifierEntity

/**
 * Логика выбора модификаторов в диалоге позиции. Вынесена из Compose, чтобы
 * правило «ровно один сорт» проверялось юнит-тестом, а не глазами.
 *
 * Группа — модификаторы с одинаковым modifier_group. Если ВСЕ модификаторы
 * группы сортовые (variety != null) — это группа «один вариант» (радио):
 * больше одного выбрать нельзя, иначе сервер вернёт 400 «Выберите один сорт».
 * Остальные группы — обычные галочки.
 */
object ModifierSelection {

    data class Group(val name: String?, val modifiers: List<ModifierEntity>, val singleChoice: Boolean)

    /** Группы в порядке первого появления — как пришли с сервера. */
    fun groups(mods: List<ModifierEntity>): List<Group> =
        mods.groupBy { it.groupName?.trim()?.takeIf { g -> g.isNotEmpty() } }
            .map { (name, list) ->
                Group(name, list, singleChoice = list.isNotEmpty() && list.all { it.isVariety })
            }

    /**
     * Предвыбор при открытии: модификаторы с is_default. В радио-группе — только
     * первый такой (если сервер ошибочно пометил два, второй не пройдёт на сервере).
     */
    fun initial(mods: List<ModifierEntity>): Set<String> {
        val out = LinkedHashSet<String>()
        groups(mods).forEach { g ->
            if (g.singleChoice) {
                g.modifiers.firstOrNull { it.isDefault }?.let { out += it.id }
            } else {
                g.modifiers.filter { it.isDefault }.forEach { out += it.id }
            }
        }
        return out
    }

    /**
     * Нажатие на модификатор. В радио-группе выбор другого снимает прежний,
     * повторное нажатие на выбранный оставляет его (это радио, а не галочка).
     * В обычной группе — переключение.
     */
    fun toggle(mods: List<ModifierEntity>, selected: Set<String>, id: String): Set<String> {
        val group = groups(mods).firstOrNull { g -> g.modifiers.any { it.id == id } } ?: return selected
        if (!group.singleChoice) {
            return if (id in selected) selected - id else selected + id
        }
        val siblings = group.modifiers.map { it.id }.toSet()
        return (selected - siblings) + id
    }

    /**
     * Проверка перед добавлением в чек: два сортовых модификатора на один
     * variety_item_id сервер отвергнет — ловим заранее, пока кассир у экрана.
     */
    fun validate(mods: List<ModifierEntity>, selected: Set<String>): String? {
        // Правило сервера — по variety_item_id; без него сервер не проверяет, и мы тоже
        val chosen = mods.filter { it.id in selected && it.isVariety && it.varietyItemId != null }
        val dup = chosen.groupBy { it.varietyItemId }.values.any { it.size > 1 }
        return if (dup) "Выберите один сорт" else null
    }
}
