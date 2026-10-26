import pkg from 'pg';
const { Pool } = pkg;

export class TechCardService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async list(enterpriseId?: string): Promise<any[]> {
    const condition = enterpriseId ? 'WHERE tc.enterprise_id = $1' : '';
    const values = enterpriseId ? [enterpriseId] : [];

    const result = await this.pool.query(
      `SELECT tc.*, mi.name as menu_item_name, mi.price as menu_item_price,
        oi.name as output_item_name, oi.unit as output_item_unit,
        oi.wholesale_price as output_wholesale_price, oi.retail_price as output_retail_price,
        COALESCE(
          json_agg(
            json_build_object(
              'id', tci.id,
              'inventoryItemId', tci.inventory_item_id,
              'itemName', ii.name,
              'quantity', tci.quantity,
              'unit', tci.unit,
              'coldLossPercent', tci.cold_loss_percent,
              'hotLossPercent', tci.hot_loss_percent,
              'packageUnit', tci.package_unit,
              'packageSize', tci.package_size,
              -- Количество фасовок не хранится: это производная от брутто.
              -- Хранить её рядом — два источника истины для одной величины,
              -- и правка брутто мимо формы оставила бы экран с враньём.
              'packagesCount', CASE WHEN tci.package_size IS NOT NULL AND tci.package_size > 0
                                    THEN ROUND(tci.quantity / tci.package_size, 4) END,
              'costPrice', ii.cost_price,
              -- Та же средневзвешенная по остатку, что и в getById:
              -- список карточек не должен противоречить открытой карточке
              'avgCostPrice', (
                SELECT SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0)
                  FROM inventory_batches b
                 WHERE b.inventory_item_id = tci.inventory_item_id
                   AND b.is_depleted = false
                   AND b.quantity > 0
                   AND b.cost_price IS NOT NULL
              )
            )
          ) FILTER (WHERE tci.id IS NOT NULL), '[]'
        ) as ingredients
       FROM tech_cards tc
       LEFT JOIN menu_items mi ON tc.menu_item_id = mi.id
       LEFT JOIN inventory_items oi ON tc.output_item_id = oi.id
       LEFT JOIN tech_card_ingredients tci ON tci.tech_card_id = tc.id
       LEFT JOIN inventory_items ii ON tci.inventory_item_id = ii.id
       ${condition}
       GROUP BY tc.id, mi.name, mi.price, oi.name, oi.unit, oi.wholesale_price, oi.retail_price
       ORDER BY COALESCE(tc.name, mi.name, oi.name)`,
      values
    );
    return result.rows;
  }

  async getById(techCardId: string, enterpriseId?: string): Promise<any> {
    const conds = ['tc.id = $1'];
    const values: any[] = [techCardId];
    if (enterpriseId) { conds.push(`tc.enterprise_id = $${values.length + 1}`); values.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT tc.*, mi.name as menu_item_name, mi.price as menu_item_price,
        oi.name as output_item_name, oi.unit as output_item_unit,
        oi.wholesale_price as output_wholesale_price, oi.retail_price as output_retail_price
       FROM tech_cards tc
       LEFT JOIN menu_items mi ON tc.menu_item_id = mi.id
       LEFT JOIN inventory_items oi ON tc.output_item_id = oi.id
       WHERE ${conds.join(' AND ')}`,
      values
    );
    if (!result.rows[0]) return null;

    const ingredients = await this.pool.query(
      `SELECT tci.*, ii.name as item_name, ii.cost_price, ii.unit as item_unit,
        -- Количество фасовок — производная от брутто, не хранимое поле:
        -- иначе правка брутто мимо формы оставит на экране старые упаковки.
        CASE WHEN tci.package_size IS NOT NULL AND tci.package_size > 0
             THEN ROUND(tci.quantity / tci.package_size, 4) END AS packages_count,
        -- Средневзвешенная цена ОСТАТКА на складе.
        -- ii.cost_price — цена последнего прихода (или последнего выпуска
        -- для своих полуфабрикатов): она затирается каждой накладной, из-за
        -- чего карточка показывала цену новой дорогой партии, пока по FIFO
        -- списывалась старая дешёвая. Для витрины себестоимости берём
        -- средневзвешенную — так же, как это делает iiko.
        (SELECT SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0)
           FROM inventory_batches b
          WHERE b.inventory_item_id = tci.inventory_item_id
            AND b.is_depleted = false
            AND b.quantity > 0
            AND b.cost_price IS NOT NULL) AS avg_cost_price,
        -- Плановая себестоимость по собственной техкарте выпуска (миграция
        -- 042). Нужна для заготовки, которую ещё ни разу не производили: у
        -- неё нет ни партий, ни цены прихода — покупать её не у кого, — и
        -- без этого строка считалась по нулю, занижая себестоимость блюда.
        item_effective_cost(tci.inventory_item_id) AS effective_cost_price
       FROM tech_card_ingredients tci
       INNER JOIN inventory_items ii ON tci.inventory_item_id = ii.id
       WHERE tci.tech_card_id = $1`,
      [techCardId]
    );

    return { ...result.rows[0], ingredients: ingredients.rows };
  }

  /**
   * Проверка, что полуфабрикат не попадёт в состав сам себя
   * (прямо или через цепочку: соус → бургер → соус).
   * Без неё расчёт себестоимости и производство уходят в рекурсию.
   *
   * Обход вверх по графу: ищем, не производится ли какой-то из ингредиентов
   * из outputItemId по цепочке производственных техкарт.
   */
  private async assertNoCycle(
    client: any,
    outputItemId: string | null | undefined,
    ingredientItemIds: string[]
  ): Promise<void> {
    if (!outputItemId || ingredientItemIds.length === 0) return;

    // Прямой случай: товар сам у себя в составе
    if (ingredientItemIds.includes(outputItemId)) {
      throw new Error('Полуфабрикат не может входить в состав сам себя');
    }

    // Транзитивный случай: BFS по рёбрам «ингредиент ← выход техкарты»
    const visited = new Set<string>(ingredientItemIds);
    let frontier = [...ingredientItemIds];

    while (frontier.length > 0) {
      const parents = await client.query(
        `SELECT DISTINCT tci.inventory_item_id
         FROM tech_cards tc
         INNER JOIN tech_card_ingredients tci ON tci.tech_card_id = tc.id
         WHERE tc.output_item_id = ANY($1::uuid[]) AND tc.is_active = true`,
        [frontier]
      );

      const next: string[] = [];
      for (const row of parents.rows) {
        const id = row.inventory_item_id;
        if (id === outputItemId) {
          throw new Error(
            'Циклическая техкарта: этот полуфабрикат уже используется ' +
            'в производстве одного из своих ингредиентов'
          );
        }
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
      frontier = next;
    }
  }

  async create(data: any, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const ingredientIds: string[] = (data.ingredients || []).map((i: any) => i.inventoryItemId);
      await this.assertNoCycle(client, data.outputItemId, ingredientIds);

      const tcResult = await client.query(
        `INSERT INTO tech_cards (menu_item_id, enterprise_id, yield_weight, cooking_instructions, name, output_item_id, output_quantity,
           effective_from, effective_to, write_off_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9, $10) RETURNING *`,
        [data.menuItemId || null, enterpriseId || null, data.yieldWeight || null, data.cookingInstructions || null,
         data.name || null, data.outputItemId || null, data.outputQuantity ?? 1,
         data.effectiveFrom || null, data.effectiveTo || null, data.writeOffMethod || 'ingredients']
      );
      const techCard = tcResult.rows[0];

      if (data.ingredients && data.ingredients.length > 0) {
        for (const ing of data.ingredients) {
          await client.query(
            `INSERT INTO tech_card_ingredients (tech_card_id, inventory_item_id, quantity, unit,
               cold_loss_percent, hot_loss_percent, is_optional, package_unit, package_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [techCard.id, ing.inventoryItemId, ing.quantity, ing.unit || null,
             ing.coldLossPercent || 0, ing.hotLossPercent || 0, ing.isOptional || false,
             // Фасовка задаётся целиком или не задаётся: половина пары
             // упирается в CHECK, поэтому пустые значения приводим к NULL.
             ing.packageUnit || null, ing.packageSize ?? null]
          );
        }
      }

      await client.query('COMMIT');
      return this.getById(techCard.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(techCardId: string, data: any, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Ownership guard: refuse to touch a tech card from another enterprise
      const ownConds = ['id = $1'];
      const ownVals: any[] = [techCardId];
      if (enterpriseId) { ownConds.push('enterprise_id = $2'); ownVals.push(enterpriseId); }
      const owned = await client.query(`SELECT id, output_item_id FROM tech_cards WHERE ${ownConds.join(' AND ')} FOR UPDATE`, ownVals);
      if (!owned.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      const fields: string[] = [];
      const values: any[] = [];
      let p = 1;

      if (data.yieldWeight !== undefined) { fields.push(`yield_weight = $${p++}`); values.push(data.yieldWeight); }
      if (data.cookingInstructions !== undefined) { fields.push(`cooking_instructions = $${p++}`); values.push(data.cookingInstructions); }
      if (data.isActive !== undefined) { fields.push(`is_active = $${p++}`); values.push(data.isActive); }
      if (data.name !== undefined) { fields.push(`name = $${p++}`); values.push(data.name); }
      if (data.outputItemId !== undefined) { fields.push(`output_item_id = $${p++}`); values.push(data.outputItemId); }
      if (data.outputQuantity !== undefined) { fields.push(`output_quantity = $${p++}`); values.push(data.outputQuantity); }
      if (data.writeOffMethod !== undefined) { fields.push(`write_off_method = $${p++}`); values.push(data.writeOffMethod); }

      if (fields.length) {
        values.push(techCardId);
        await client.query(
          `UPDATE tech_cards SET ${fields.join(', ')} WHERE id = $${p}`, values
        );
      }

      // Replace ingredients if provided
      if (data.ingredients) {
        // Защита от цикла: берём итоговый outputItemId (новый или текущий)
        const effectiveOutput = data.outputItemId !== undefined
          ? data.outputItemId
          : owned.rows[0].output_item_id;
        const ingredientIds: string[] = data.ingredients.map((i: any) => i.inventoryItemId);
        await this.assertNoCycle(client, effectiveOutput, ingredientIds);

        await client.query('DELETE FROM tech_card_ingredients WHERE tech_card_id = $1', [techCardId]);
        for (const ing of data.ingredients) {
          await client.query(
            `INSERT INTO tech_card_ingredients (tech_card_id, inventory_item_id, quantity, unit,
               cold_loss_percent, hot_loss_percent, is_optional, package_unit, package_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [techCardId, ing.inventoryItemId, ing.quantity, ing.unit || null,
             ing.coldLossPercent || 0, ing.hotLossPercent || 0, ing.isOptional || false,
             ing.packageUnit || null, ing.packageSize ?? null]
          );
        }
      }

      await client.query('COMMIT');
      return this.getById(techCardId, enterpriseId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(techCardId: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const vals: any[] = [techCardId];
    if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
    const r = await this.pool.query(`UPDATE tech_cards SET is_active = false WHERE ${conds.join(' AND ')}`, vals);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Новая версия техкарты с указанной даты.
   *
   * Правка существующей карты затирает историю: прошлые заказы начинают
   * считаться по новой рецептуре. Поэтому смена состава — это не UPDATE,
   * а новая версия: прежняя закрывается днём раньше, новая открывается
   * с нужной даты. Обе операции в одной транзакции, иначе между ними
   * возникнет либо дыра без действующей карты, либо пересечение версий.
   */
  async createVersion(
    sourceCardId: string,
    data: { effectiveFrom: string; ingredients?: any[]; yieldWeight?: number; cookingInstructions?: string; name?: string; writeOffMethod?: string },
    enterpriseId?: string
  ): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const conds = ['id = $1'];
      const vals: any[] = [sourceCardId];
      if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
      // FOR UPDATE: параллельная попытка создать версию на ту же дату
      // должна дождаться, иначе обе пройдут проверку и упрутся в EXCLUDE
      const src = await client.query(
        `SELECT * FROM tech_cards WHERE ${conds.join(' AND ')} FOR UPDATE`, vals
      );
      const source = src.rows[0];
      if (!source) { await client.query('ROLLBACK'); return null; }

      if (source.effective_from >= data.effectiveFrom) {
        throw new Error('Дата новой версии должна быть позже начала текущей');
      }

      // Закрываем прежнюю версию днём раньше начала новой
      await client.query(
        `UPDATE tech_cards SET effective_to = ($1::date - INTERVAL '1 day')::date, updated_at = NOW()
         WHERE id = $2`,
        [data.effectiveFrom, sourceCardId]
      );

      const created = await client.query(
        `INSERT INTO tech_cards (menu_item_id, enterprise_id, yield_weight, cooking_instructions, name,
           output_item_id, output_quantity, effective_from, effective_to, write_off_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, NULL, $9) RETURNING *`,
        [source.menu_item_id, source.enterprise_id,
         data.yieldWeight ?? source.yield_weight,
         data.cookingInstructions ?? source.cooking_instructions,
         data.name ?? source.name,
         source.output_item_id, source.output_quantity, data.effectiveFrom,
         // Метод списания наследуется: новая версия той же карты не должна
         // молча переключиться на списание сырья и начать двойной учёт.
         data.writeOffMethod ?? source.write_off_method ?? 'ingredients']
      );
      const newCard = created.rows[0];

      // Состав: либо новый, либо копия прежнего — версия без ингредиентов
      // ничего не спишет и тихо обнулит учёт по этому блюду
      const ingredients = data.ingredients ?? (await client.query(
        `SELECT inventory_item_id, quantity, unit, cold_loss_percent, hot_loss_percent, is_optional,
                package_unit, package_size
         FROM tech_card_ingredients WHERE tech_card_id = $1`, [sourceCardId]
      )).rows.map((r: any) => ({
        inventoryItemId: r.inventory_item_id,
        quantity: r.quantity,
        unit: r.unit,
        coldLossPercent: r.cold_loss_percent,
        hotLossPercent: r.hot_loss_percent,
        isOptional: r.is_optional,
        // Фасовку тоже копируем: без неё новая версия показывала бы расход
        // в килограммах там, где прежняя вела учёт упаковками.
        packageUnit: r.package_unit,
        packageSize: r.package_size
      }));

      for (const ing of ingredients) {
        await client.query(
          `INSERT INTO tech_card_ingredients (tech_card_id, inventory_item_id, quantity, unit,
             cold_loss_percent, hot_loss_percent, is_optional, package_unit, package_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [newCard.id, ing.inventoryItemId, ing.quantity, ing.unit || null,
           ing.coldLossPercent || 0, ing.hotLossPercent || 0, ing.isOptional || false,
           ing.packageUnit || null, ing.packageSize ?? null]
        );
      }

      await client.query('COMMIT');
      return this.getById(newCard.id, enterpriseId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Все версии техкарты блюда, новые сверху. */
  async getVersions(menuItemId: string, enterpriseId?: string): Promise<any[]> {
    const conds = ['menu_item_id = $1', 'is_active = true'];
    const vals: any[] = [menuItemId];
    if (enterpriseId) { conds.push(`enterprise_id = $${vals.length + 1}`); vals.push(enterpriseId); }
    const r = await this.pool.query(
      `SELECT id, name, effective_from, effective_to,
              (effective_from <= CURRENT_DATE
               AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)) AS is_current
       FROM tech_cards
       WHERE ${conds.join(' AND ')}
       ORDER BY effective_from DESC`,
      vals
    );
    return r.rows;
  }

  async getCostCalculation(techCardId: string, enterpriseId?: string): Promise<any> {
    const card = await this.getById(techCardId, enterpriseId);
    if (!card) return null;

    let totalCost = 0;
    let totalNet = 0;
    let totalYield = 0;
    const ingredientCosts = card.ingredients.map((ing: any) => {
      // Цена берётся по остатку на складе, а не по последней накладной:
      // именно по этим партиям пойдёт списание. Если остатка нет (ещё не
      // закупали или всё израсходовано), откатываемся на справочную цену —
      // иначе карточка показала бы ноль и фуд-кост стал бы бессмысленным.
      const avg = ing.avg_cost_price !== null && ing.avg_cost_price !== undefined
        ? parseFloat(ing.avg_cost_price)
        : NaN;
      // Плановая цена по своей техкарте — для заготовки, которую ещё не
      // производили: партий нет, прихода нет, но стоимость известна из
      // состава. Без неё строка считалась по нулю.
      const planned = parseFloat(ing.effective_cost_price);
      const fallback = parseFloat(ing.cost_price) || 0;
      const unitPrice = Number.isFinite(avg) ? avg
        : (fallback > 0 ? fallback : (Number.isFinite(planned) ? planned : 0));
      const priceSource = Number.isFinite(avg) ? 'stock_avg'
        : (fallback > 0 ? 'last_purchase'
          : (Number.isFinite(planned) && planned > 0 ? 'planned' : 'none'));

      // Брутто → нетто → выход (миграция 032).
      // Деньги считаются от БРУТТО: платим за то, что взяли со склада,
      // включая очистки и ужарку.
      const gross = parseFloat(ing.quantity) || 0;
      const coldLoss = parseFloat(ing.cold_loss_percent) || 0;
      const hotLoss = parseFloat(ing.hot_loss_percent) || 0;
      const net = gross * (1 - coldLoss / 100);
      const yieldQty = net * (1 - hotLoss / 100);

      const cost = gross * unitPrice;
      totalCost += cost;
      totalNet += net;
      totalYield += yieldQty;

      return {
        ...ing,
        unitPrice,
        priceSource,
        grossQuantity: gross,
        netQuantity: Math.round(net * 1000) / 1000,
        yieldQuantity: Math.round(yieldQty * 1000) / 1000,
        calculatedCost: cost
      };
    });

    const menuPrice = parseFloat(card.menu_item_price) || 0;
    const margin = menuPrice > 0 ? ((menuPrice - totalCost) / menuPrice * 100) : 0;

    // Для производственной техкарты: себестоимость единицы выпуска и маржа по опту/рознице
    const outputQty = parseFloat(card.output_quantity) || 1;
    const unitCost = totalCost / outputQty;
    const wholesalePrice = card.output_wholesale_price !== null && card.output_wholesale_price !== undefined
      ? parseFloat(card.output_wholesale_price) : null;
    const retailPrice = card.output_retail_price !== null && card.output_retail_price !== undefined
      ? parseFloat(card.output_retail_price) : null;

    return {
      techCardId: card.id,
      name: card.name,
      menuItemName: card.menu_item_name,
      outputItemName: card.output_item_name,
      outputQuantity: outputQty,
      menuPrice,
      totalCost,
      // Итоги по массе: брутто взяли со склада, выход — вес готового блюда.
      // Именно выход сверяется с нормой в техкарте.
      totalGross: Math.round(ingredientCosts.reduce((s: number, i: any) => s + i.grossQuantity, 0) * 1000) / 1000,
      totalNet: Math.round(totalNet * 1000) / 1000,
      totalYield: Math.round(totalYield * 1000) / 1000,
      unitCost: Math.round(unitCost * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      wholesalePrice,
      retailPrice,
      wholesaleMargin: wholesalePrice && wholesalePrice > 0 ? Math.round((wholesalePrice - unitCost) / wholesalePrice * 10000) / 100 : null,
      retailMargin: retailPrice && retailPrice > 0 ? Math.round((retailPrice - unitCost) / retailPrice * 10000) / 100 : null,
      ingredients: ingredientCosts
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default TechCardService;
