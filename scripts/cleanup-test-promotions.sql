-- Уборка тестовых акций, созданных живой проверкой на проде.
-- Отдельным файлом: $$ внутри ssh-строки раскрывается шеллом в PID
-- ($$ → 3213573), и запрос падает с «trailing junk after numeric literal».
DELETE FROM promotions WHERE name LIKE 'ПРОВЕРКА%';
SELECT count(*) AS осталось_тестовых FROM promotions WHERE name LIKE 'ПРОВЕРКА%';
SELECT count(*) AS всего_акций FROM promotions;
