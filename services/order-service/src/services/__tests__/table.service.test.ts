import { TableService, TableError } from '../table.service';

const ENT = '11111111-1111-4111-8111-111111111111';
const OTHER_ENT = '99999999-9999-4999-8999-999999999999';
const REST = '22222222-2222-4222-8222-222222222222';
const TABLE = '44444444-4444-4444-8444-444444444444';

/**
 * Мок по правилам «регулярка по SQL → строки». Правило дубля уважает
 * переданный номер и исключаемый id — иначе проверка дубля прошла бы
 * при любом запросе.
 */
function makeSvc(opts: { restEnt?: string | null; existing?: { id: string; number: string }[] } = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const existing = opts.existing || [];
  const svc = new TableService('postgres://unused');
  (svc as any).pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM restaurants WHERE id = \$1/.test(sql)) {
        return opts.restEnt === null ? { rows: [], rowCount: 0 } : { rows: [{ enterprise_id: opts.restEnt ?? ENT }], rowCount: 1 };
      }
      if (/SELECT 1 FROM restaurant_tables/.test(sql)) {
        const hits = existing.filter(
          (t) =>
            /restaurant_id = \$1/.test(sql) &&
            /table_number = \$2/.test(sql) &&
            /is_active = true/.test(sql) &&
            t.number === params[1] &&
            !(/id <> \$3/.test(sql) && t.id === params[2])
        );
        return { rows: hits, rowCount: hits.length };
      }
      if (/SELECT restaurant_id FROM restaurant_tables/.test(sql)) {
        return { rows: [{ restaurant_id: REST }], rowCount: 1 };
      }
      if (/INSERT INTO restaurant_tables/.test(sql)) return { rows: [{ id: TABLE }], rowCount: 1 };
      if (/UPDATE restaurant_tables/.test(sql)) return { rows: [{ id: TABLE }], rowCount: 1 };
      throw new Error('неожиданный SQL: ' + sql);
    },
  };
  return { svc, calls };
}

function insertValue(sql: string, params: any[], col: string) {
  const cols = /INSERT INTO restaurant_tables \(([^)]*)\)/.exec(sql)![1].split(',').map((c) => c.trim());
  const vals = /VALUES \(([^)]*)\)/.exec(sql)![1].split(',').map((v) => v.trim());
  expect(cols).toHaveLength(vals.length);
  return params[Number(vals[cols.indexOf(col)].slice(1)) - 1];
}

describe('создание стола', () => {
  it('создаёт стол в своей точке; enterprise_id берётся из точки', async () => {
    const { svc, calls } = makeSvc();
    await svc.create(REST, { tableNumber: '3', seats: 2, section: 'main' }, ENT);
    const ins = calls.find((c) => /INSERT/.test(c.sql))!;
    expect(insertValue(ins.sql, ins.params, 'restaurant_id')).toBe(REST);
    expect(insertValue(ins.sql, ins.params, 'table_number')).toBe('3');
    expect(insertValue(ins.sql, ins.params, 'seats')).toBe(2);
    expect(insertValue(ins.sql, ins.params, 'enterprise_id')).toBe(ENT);
  });

  it('супер-админ без предприятия в токене: стол получает предприятие точки, а не NULL', async () => {
    const { svc, calls } = makeSvc({ restEnt: OTHER_ENT });
    await svc.create(REST, { tableNumber: '1' }, undefined);
    const ins = calls.find((c) => /INSERT/.test(c.sql))!;
    expect(insertValue(ins.sql, ins.params, 'enterprise_id')).toBe(OTHER_ENT);
  });

  it('чужая точка — 404 и никакой вставки', async () => {
    const { svc, calls } = makeSvc({ restEnt: OTHER_ENT });
    await expect(svc.create(REST, { tableNumber: '1' }, ENT)).rejects.toMatchObject({ status: 404 });
    expect(calls.some((c) => /INSERT/.test(c.sql))).toBe(false);
  });

  it('несуществующая точка — 404', async () => {
    const { svc } = makeSvc({ restEnt: null });
    await expect(svc.create(REST, { tableNumber: '1' }, ENT)).rejects.toBeInstanceOf(TableError);
  });

  it('дубль номера в точке — 409 без вставки', async () => {
    const { svc, calls } = makeSvc({ existing: [{ id: 'x', number: '5' }] });
    await expect(svc.create(REST, { tableNumber: '5' }, ENT)).rejects.toMatchObject({ status: 409 });
    expect(calls.some((c) => /INSERT/.test(c.sql))).toBe(false);
  });

  it('другой номер в той же точке — создаётся', async () => {
    const { svc, calls } = makeSvc({ existing: [{ id: 'x', number: '5' }] });
    await svc.create(REST, { tableNumber: '6' }, ENT);
    expect(calls.some((c) => /INSERT/.test(c.sql))).toBe(true);
  });
});

describe('изменение стола', () => {
  it('смена номера на занятый — 409', async () => {
    const { svc } = makeSvc({ existing: [{ id: 'other', number: '7' }] });
    await expect(svc.update(TABLE, { tableNumber: '7' }, ENT)).rejects.toMatchObject({ status: 409 });
  });

  it('свой же номер при сохранении не считается дублем', async () => {
    const { svc } = makeSvc({ existing: [{ id: TABLE, number: '7' }] });
    await expect(svc.update(TABLE, { tableNumber: '7', seats: 6 }, ENT)).resolves.toEqual({ id: TABLE });
  });

  it('обновление ограничено предприятием', async () => {
    const { svc, calls } = makeSvc();
    await svc.update(TABLE, { seats: 6 }, ENT);
    const upd = calls.find((c) => /UPDATE/.test(c.sql))!;
    expect(upd.sql).toMatch(/WHERE id = \$2 AND enterprise_id = \$3/);
    expect(upd.params).toEqual([6, TABLE, ENT]);
  });

  it('удаление ограничено предприятием', async () => {
    const { svc, calls } = makeSvc();
    await svc.delete(TABLE, ENT);
    expect(calls[0].sql).toMatch(/WHERE id = \$1 AND enterprise_id = \$2/);
    expect(calls[0].params).toEqual([TABLE, ENT]);
  });
});
