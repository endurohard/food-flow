# FoodFlow Касса — APK для АТОЛ Sigma

Нативный Android-клиент (Kotlin + Jetpack Compose) для смарт-терминалов
**АТОЛ Sigma 7/8/10** со встроенным фискальным регистратором.
Повторяет сценарий веб-кассы `frontend/admin-panel/pos.html`, но работает
**offline-first**: чек пробивается на ФР сразу, а заказ и платёж доезжают
на сервер отдельной очередью.

## Что умеет

- Меню с категориями, поиском, модификаторами и стоп-листом (кэш в Room).
- Корзина, оплата наличными (с расчётом сдачи) и картой.
- Фискальный чек через **Драйвер ККТ 10** (`libfptr10`): приход, возврат,
  открытие/закрытие смены, X-отчёт, внесение/изъятие наличных.
- Полная работа без сети: продажа пишется локально, синхронизация через
  WorkManager (по сети, периодически, после перезагрузки терминала).
- Журнал продаж: видно, что не пробито на ФР и что не отправлено на сервер,
  с кнопкой повторной печати.

## Архитектура

```
ui/            Compose-экраны + PosViewModel (единый StateFlow-стейт)
data/
  Settings     EncryptedSharedPreferences: токены, адрес сервера, СНО, НДС
  Cart         корзина, склейка позиций по набору добавок, деньги в копейках
  ApiParser    терпимый разбор ответов FoodFlow ({items}/{data}/{success,data})
  PosRepository  БД + API + сессия
  SaleSyncer   пошаговая синхронизация одной продажи
  net/ApiClient  OkHttp, Bearer, авто-refresh при 401, idempotency-key
  db/          Room: меню, модификаторы, продажи (sales — источник истины)
fiscal/
  FiscalDriver           абстракция ФР (чек, смена, отчёты, ДЯ)
  driver/AtolDriverFiscalDriver  Драйвер ККТ 10 через JSON-задания + рефлексия
  driver/StubFiscalDriver        заглушка для отладки без ФР
sync/SyncWorker  очередь отправки продаж
```

### Порядок операций при оплате

Выбран так, чтобы **ни одна продажа не потерялась и ни один чек не продублировался**:

1. Продажа пишется в локальную БД (`sales`) — источник истины.
2. Печатается фискальный чек на ФР; результат (ФД, ФПД, номер смены)
   сохраняется в той же записи.
3. Делается попытка отправки на сервер. Неудача → запись остаётся
   в очереди, WorkManager добивает её позже.

Синхронизация одной продажи разбита на 4 независимых шага со своими флагами
(`server_order_id`, `payment_synced`, `cash_operation_synced`, `fiscal_synced`),
поэтому повтор после обрыва сети не создаёт дублей. Ключи идемпотентности:
`sales.id` для заказа, `payment_idempotency_key` для платежа.

### Используемые эндпоинты FoodFlow

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/auth/login` | вход кассира |
| POST | `/api/auth/refresh` | обновление токена |
| GET | `/api/restaurants` | заведение (берётся первое) |
| GET | `/api/restaurants/:id/menu-categories` | категории |
| GET | `/api/restaurants/:id/menu-items` | позиции меню |
| GET | `/api/restaurants/menu-items/:id/modifiers` | модификаторы |
| GET | `/api/finance/registers?status=open` | открытая касса |
| POST | `/api/orders` | заказ (idempotency-key) |
| PUT | `/api/orders/:id/status` | перевод в `confirmed` (KDS) |
| POST | `/api/finance/payments` | платёж (idempotency-key) |
| POST | `/api/finance/registers/:id/operations` | наличные в кассу |
| POST | `/api/finance/fiscal-receipts` | реквизиты фискального чека |

Роль `cashier` имеет доступ ко всем этим эндпоинтам (миграция 027).

> `POST /api/finance/fiscal-receipts` добавлен этой задачей в
> `services/finance-service/src/routes/finance.routes.ts`.
> На старом бэкенде вернёт 404 — касса это терпит, продажа не теряется.

## Сборка

Требуется JDK 17 и Android SDK 34.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export PATH=$JAVA_HOME/bin:$PATH
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools

cd mobile/sigma-pos
./gradlew :app:testDebugUnitTest    # unit-тесты (деньги, корзина, стоп-лист)
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease      # релиз (подпись — см. ниже)
```

Подпись релиза — через `~/.gradle/gradle.properties`:

```properties
FF_KEYSTORE=/absolute/path/foodflow-pos.jks
FF_KEYSTORE_PASSWORD=...
FF_KEY_ALIAS=foodflow
FF_KEY_PASSWORD=...
```

Без этих свойств релиз подписывается debug-ключом (для теста на устройстве
годится, для раздачи — нет).

## Подключение SDK фискального регистратора

Проект **собирается без SDK** — драйвер подключается рефлексией, и приложение
честно сообщает «ФР недоступен», если библиотеки нет.

Чтобы включить реальную фискализацию:

1. Скачай `libfptr10.aar` (Драйвер ККТ 10) из личного кабинета АТОЛ /
   integration.atol.ru. Лицензия ДККТ 10 для разработчиков безвозмездная
   и регистрации не требует (integration.atol.ru/rules/).
2. Положи его в `mobile/sigma-pos/app/libs/`.
3. Пересобери APK. Драйвер ищется по классам
   `ru.atol.drivers10.fptr.Fptr` / `IFptr` (и `com.atol.*`).

Альтернативные транспорты к тому же драйверу (если aar по какой-то причине
не подойдёт) — Intent к `ru.atol.drivers10.service`
(action `ru.atol.drivers10.service.PROCESS_TASK`, extras `PARAM_REQUEST` →
`PARAM_RESULT`) и AIDL `IFptrService.processJson(json)`. JSON-задания у всех
трёх путей одинаковые, поэтому заменить нужно только `processJson()`
в `AtolDriverFiscalDriver`.

> **Проверь на живом устройстве:** параметр подключения к встроенному ФР
> (`LIBFPTR_SETTING_PORT`) в документации для Sigma не зафиксирован — сними
> фактическое значение через `getSettings()` на терминале. Если `open()`
> не поднимает связь, дело почти наверняка в нём.

Детали протокола (JSON-задания, теги ФФД, коды ошибок) —
в `docs/atol-sigma-integration.md`.

## Установка на терминал

**По USB-флешке (штатный путь, подпись АТОЛ не нужна):**

1. Скопируй APK на флешку, вставь в терминал (на Sigma 10 — 4 порта USB-A).
2. Настройки → Безопасность → включить «Неизвестные источники».
3. Диспетчер файлов → USB-накопитель → выбрать APK → Установить.

**По adb (для отладки):**

```bash
$ANDROID_HOME/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
$ANDROID_HOME/platform-tools/adb logcat | grep -i foodflow
```

## Первый запуск

1. Адрес сервера — тот же, по которому открывается админка
   (`https://…`, Kong отдаёт и фронт, и API).
2. Вход под пользователем с ролью `cashier` (или выше).
3. Настройки → проверить СНО и ставку НДС, убедиться, что драйвер ККТ доступен.
4. Смена → «Открыть смену».

`minSdk 25` (Android 7.1) — официально поддерживаемый АТОЛ диапазон для
драйвера; Sigma поставляется с Android 7+.

## Что ещё не сделано

- Чеки коррекции и возврат по чеку из журнала (API драйвера для этого есть:
  `sellReturn`, `sellCorrection`).
- Маркированная продукция (ФФД 1.2, `imcParams`) — для общепита обычно не нужна,
  но для продажи пива в таре понадобится.
- Эквайринг: оплата «Карта» фиксирует безналичный расчёт, но терминалом
  не управляет — сумму на пинпаде кассир подтверждает сам.
- Печать пречека (`nonFiscal`) и открытие денежного ящика из UI.
