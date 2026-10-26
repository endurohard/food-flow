-- 043: количество в возврате строго положительное.
--
-- Joi в роуте уже требует positive(), но это единственный слой: любой
-- скрипт, импорт или новый эндпоинт мимо схемы запишет что угодно.
-- Отрицательное количество опасно вдвойне:
--   1) контроль лимита в confirm() проверяет ТОЛЬКО верхнюю границу
--      (returned_quantity + qty <= отгружено), и минус его проходит,
--      уменьшая счётчик возвращённого — открывая возврат сверх отгрузки;
--   2) при disposition='restock' минус спишет товар со склада вместо
--      прихода.
ALTER TABLE wholesale_return_items
  DROP CONSTRAINT IF EXISTS wholesale_return_items_quantity_positive;
ALTER TABLE wholesale_return_items
  ADD CONSTRAINT wholesale_return_items_quantity_positive
  CHECK (quantity IS NOT NULL AND quantity > 0);

-- Та же дыра в отгрузке: количество позиции заказа тоже обязано быть > 0.
ALTER TABLE wholesale_order_items
  DROP CONSTRAINT IF EXISTS wholesale_order_items_quantity_positive;
ALTER TABLE wholesale_order_items
  ADD CONSTRAINT wholesale_order_items_quantity_positive
  CHECK (quantity IS NOT NULL AND quantity > 0);

-- Возвращённое не может превышать отгруженное и не может быть отрицательным.
-- Это страховка на случай, если условие в коде изменят или обойдут.
ALTER TABLE wholesale_order_items
  DROP CONSTRAINT IF EXISTS wholesale_order_items_returned_sane;
ALTER TABLE wholesale_order_items
  ADD CONSTRAINT wholesale_order_items_returned_sane
  CHECK (
    returned_quantity >= 0
    AND returned_quantity <= COALESCE(shipped_quantity, quantity) + 0.0005
  );
