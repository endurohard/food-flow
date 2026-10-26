-- 037: единое дерево номенклатуры (этап A)
--
-- Зачем: блюда, товары и заготовки лежат в двух разных таблицах
-- (menu_items и inventory_items), общего справочника с группами нет.
-- Пользователь работает по образцу iiko: одно дерево с вкладками
-- БЛЮДА / ТОВАРЫ / МОДИФИКАТОРЫ / ЗАГОТОВКИ, колонки «Артикул», «Тип»,
-- «Единица измерения», «Категория», «Бухгалтерская категория»,
-- «Налоговая категория», «Место приготовления».
--
-- Подход: таблицы не сливаем (это сломало бы заказы, склад и техкарты),
-- а добавляем обеим общий набор полей и иерархию групп поверх них.
-- Дерево собирается представлением v_nomenclature.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Иерархия групп номенклатуры
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nomenclature_groups (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    parent_id     UUID REFERENCES nomenclature_groups(id) ON DELETE RESTRICT,
    name          VARCHAR(255) NOT NULL,
    sku           VARCHAR(50),
    display_order INTEGER NOT NULL DEFAULT 0,
    -- мягкое удаление: тумблер «Показать удалённые» в интерфейсе
    deleted_at    TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- группа не может быть сама себе родителем
    CONSTRAINT nomenclature_groups_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_nomenclature_groups_enterprise
    ON nomenclature_groups(enterprise_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nomenclature_groups_parent
    ON nomenclature_groups(parent_id);

-- Артикул уникален в пределах предприятия среди живых групп
CREATE UNIQUE INDEX IF NOT EXISTS uq_nomenclature_groups_sku
    ON nomenclature_groups(enterprise_id, sku)
 WHERE sku IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE nomenclature_groups IS
    'Иерархия групп номенклатуры (аналог папок в дереве iiko). Позиции ссылаются на группу из menu_items/inventory_items.';

-- ---------------------------------------------------------------------------
-- 2. Общие поля номенклатуры для блюд
-- ---------------------------------------------------------------------------
ALTER TABLE menu_items
    ADD COLUMN IF NOT EXISTS nomenclature_group_id UUID REFERENCES nomenclature_groups(id) ON DELETE SET NULL,
    -- 'dish' = Блюдо, 'good' = Товар (продаётся как есть, без техкарты)
    ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) NOT NULL DEFAULT 'dish',
    ADD COLUMN IF NOT EXISTS accounting_category VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tax_category VARCHAR(100),
    ADD COLUMN IF NOT EXISTS product_category VARCHAR(100),
    -- место приготовления: цех/станция кухни
    ADD COLUMN IF NOT EXISTS prep_station_id UUID REFERENCES kitchen_stations(id) ON DELETE SET NULL,
    -- порядок на кассе: отдельная сортировка, не совпадает с деревом
    ADD COLUMN IF NOT EXISTS cash_order INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_item_type_check;
ALTER TABLE menu_items
    ADD CONSTRAINT menu_items_item_type_check CHECK (item_type IN ('dish', 'good'));

CREATE INDEX IF NOT EXISTS idx_menu_items_nomenclature_group
    ON menu_items(nomenclature_group_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Общие поля номенклатуры для позиций склада
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_items
    ADD COLUMN IF NOT EXISTS nomenclature_group_id UUID REFERENCES nomenclature_groups(id) ON DELETE SET NULL,
    -- 'good' = Товар (покупается и хранится), 'prepared' = Заготовка (производится)
    ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) NOT NULL DEFAULT 'good',
    ADD COLUMN IF NOT EXISTS accounting_category VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tax_category VARCHAR(100),
    ADD COLUMN IF NOT EXISTS product_category VARCHAR(100),
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_item_type_check;
ALTER TABLE inventory_items
    ADD CONSTRAINT inventory_items_item_type_check CHECK (item_type IN ('good', 'prepared'));

CREATE INDEX IF NOT EXISTS idx_inventory_items_nomenclature_group
    ON inventory_items(nomenclature_group_id) WHERE deleted_at IS NULL;

-- Артикул позиции склада уникален в пределах предприятия среди живых позиций
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_items_sku
    ON inventory_items(enterprise_id, sku)
 WHERE sku IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Единое представление дерева
-- ---------------------------------------------------------------------------
-- Блюда и товары продаются (есть цена), заготовки и товары склада хранятся.
-- Представление даёт одну выборку для экрана номенклатуры; писать в него
-- нельзя, запись идёт в исходные таблицы через API.
DROP VIEW IF EXISTS v_nomenclature;
CREATE VIEW v_nomenclature AS
    SELECT
        mi.id,
        'menu'::text                AS source,
        mi.enterprise_id,
        mi.nomenclature_group_id,
        mi.name,
        mi.sku,
        mi.item_type,
        COALESCE(mi.unit, 'piece')  AS unit,
        mc.name                     AS category,
        mi.accounting_category,
        mi.tax_category,
        mi.product_category,
        ks.name                     AS prep_station,
        mi.cash_order,
        mi.price,
        mi.cost_price,
        mi.is_available,
        mi.deleted_at
      FROM menu_items mi
      LEFT JOIN menu_categories mc  ON mc.id = mi.category_id
      LEFT JOIN kitchen_stations ks ON ks.id = mi.prep_station_id
  UNION ALL
    SELECT
        ii.id,
        'inventory'::text           AS source,
        ii.enterprise_id,
        ii.nomenclature_group_id,
        ii.name,
        ii.sku,
        ii.item_type,
        ii.unit,
        ii.category,
        ii.accounting_category,
        ii.tax_category,
        ii.product_category,
        NULL::varchar               AS prep_station,
        0                           AS cash_order,
        NULL::numeric               AS price,
        ii.cost_price,
        ii.is_active                AS is_available,
        ii.deleted_at
      FROM inventory_items ii;

COMMENT ON VIEW v_nomenclature IS
    'Единое дерево номенклатуры: блюда и товары из menu_items, товары и заготовки из inventory_items. Только для чтения.';

COMMIT;
