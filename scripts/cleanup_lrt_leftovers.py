#!/usr/bin/env python3
"""Уборка хвоста LRT-* от моей проверки возвратов. Только свои данные.

Чужое (ТЕСТ зерно v033, ТЕСТ Капучино) не трогает: решение по ним за
пользователем. Перед удалением показывает, что именно удаляет, после —
что ничего не осталось.
"""
import subprocess

PG = "food-flow-postgres"


def psql(sql, tuples=False):
    args = ["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow"]
    if tuples:
        args += ["-t", "-A"]
    args += ["-c", sql]
    r = subprocess.run(args, capture_output=True, text=True)
    return ((r.stdout or "") + (r.stderr or "")).strip()


print("--- до уборки ---")
print(psql("""
select 'inventory_items' as t, count(*) from inventory_items where name like 'LRT-%'
union all select 'inventory_stock', count(*) from inventory_stock
  where inventory_item_id in (select id from inventory_items where name like 'LRT-%')
union all select 'inventory_batches', count(*) from inventory_batches
  where inventory_item_id in (select id from inventory_items where name like 'LRT-%')
union all select 'stock_movements', count(*) from stock_movements
  where inventory_item_id in (select id from inventory_items where name like 'LRT-%')
union all select 'wholesale_order_items', count(*) from wholesale_order_items
  where inventory_item_id in (select id from inventory_items where name like 'LRT-%')
union all select 'wholesale_orders', count(*) from wholesale_orders where notes like 'LRT-%'
union all select 'wholesale_returns', count(*) from wholesale_returns where reason like 'LRT-%'
union all select 'counterparties', count(*) from counterparties where name like 'LRT-%'
order by 1
"""))

# Одной транзакцией: порядок от зависимых к родительским.
print("\n--- удаление ---")
print(psql("""
BEGIN;
delete from stock_movements
 where inventory_item_id in (select id from inventory_items where name like 'LRT-%')
    or reference_id in (select id from wholesale_returns where reason like 'LRT-%');
delete from counterparty_payments
 where order_id in (select id from wholesale_orders where notes like 'LRT-%')
    or counterparty_id in (select id from counterparties where name like 'LRT-%');
delete from wholesale_return_items
 where return_id in (select id from wholesale_returns where reason like 'LRT-%'
                        or order_id in (select id from wholesale_orders where notes like 'LRT-%'));
delete from wholesale_returns
 where reason like 'LRT-%' or order_id in (select id from wholesale_orders where notes like 'LRT-%');
delete from wholesale_order_items
 where order_id in (select id from wholesale_orders where notes like 'LRT-%')
    or inventory_item_id in (select id from inventory_items where name like 'LRT-%');
delete from wholesale_orders where notes like 'LRT-%';
delete from inventory_batches
 where batch_number like 'LRT-%'
    or inventory_item_id in (select id from inventory_items where name like 'LRT-%');
delete from inventory_stock
 where inventory_item_id in (select id from inventory_items where name like 'LRT-%');
delete from inventory_items where name like 'LRT-%';
delete from counterparties where name like 'LRT-%';
COMMIT;
"""))

print("\n--- после уборки (всё должно быть 0) ---")
print(psql("""
select 'inventory_items' as t, count(*) from inventory_items where name like 'LRT-%'
union all select 'inventory_batches', count(*) from inventory_batches where batch_number like 'LRT-%'
union all select 'wholesale_orders', count(*) from wholesale_orders where notes like 'LRT-%'
union all select 'wholesale_returns', count(*) from wholesale_returns where reason like 'LRT-%'
union all select 'counterparties', count(*) from counterparties where name like 'LRT-%'
order by 1
"""))

print("\n--- чужое осталось нетронутым (контроль) ---")
print(psql("select name, count(*) from inventory_items where name ilike '%ТЕСТ%' group by 1"))
