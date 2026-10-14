# АТОЛ Sigma 7/8/10 — как стороннее Android-приложение печатает фискальный чек

Источники (основные):
- Документация ДККТ 10 (Native API + JSON-задания + Android Service): https://integration.atol.ru/api/ (версия драйвера 10.10.9.0, стр. создана 05.08.2026)
- Корень документации АТОЛ: https://integration.atol.ru/
- WebRequests (REST): https://integration.atol.ru/web_requests/
- Правила использования ДККТ 10 разработчиками: https://integration.atol.ru/rules/
- Центр загрузок АТОЛ: https://fs.atol.ru/ (раздел «Смарт-терминалы АТОЛ Sigma» → Sigma 10 / 7Ф / 8Ф)
- Руководство по эксплуатации Sigma 10 (Платформа 5.0), PDF 152 стр.: https://fs.atol.ru/_layouts/15/atol.templates/Handlers/FileHandler.ashx?guid=2c36606c-7237-4101-af14-3efcf1b7c2df&webUrl=
- Установка стороннего APK на Sigma 8/10 (инструкция Saby): https://saby.ru/help/equipment/auto_kkt/atol150f/saby_app
- SIGMA Касса в RuStore (package `ru.sigma.app`): https://www.rustore.ru/catalog/app/ru.sigma.app

---

## 1. Способы интеграции

Подтверждено документацией АТОЛ четыре варианта. **Все они идут через ДККТ 10 (libfptr10)** — никакого отдельного «Sigma SDK» в публичном доступе не найдено.

| # | Способ | Что нужно на устройстве | Подтверждено |
|---|--------|------------------------|--------------|
| A | **aar-библиотека `libfptr10.aar`** в своё приложение (Java/Kotlin) | ничего, драйвер внутри APK | да, integration.atol.ru/api/ раздел «Подключение к проекту» |
| B | **Android Intent API** к приложению «АТОЛ. Драйвер ККТ» (`ru.atol.drivers10.service`) | установленное приложение-драйвер | да, раздел «Android Service» |
| C | **AIDL-сервис** того же приложения (`IFptrService.processJson()`) | то же | да, там же |
| D | **WebRequests** — локальный HTTP/REST поверх драйвера | только Windows 10+/Linux glibc 2.35+ — **на Android НЕ поддерживается** | да, integration.atol.ru/web_requests/ («Поддерживаются ОС: Windows 10 (x86,x64) и выше; Linux glibc 2.35 и выше») |

**Вывод для FoodFlow:** на Sigma реально доступны A, B, C. Рекомендую **A (libfptr10.aar) как основной** — нет зависимости от внешнего APK и от его версии; B/C — как запасной путь, если на конкретной прошивке Sigma драйвер уже занят «Сигма Кассой».

### Чего НЕ удалось подтвердить (не выдумываю)
- **Публичного Intent API к самому приложению «Сигма Касса» (`ru.sigma.app`)** — ни одного имени action/extra в открытых источниках не нашлось. Package подтверждён (RuStore: `ru.sigma.app`, разработчик «АТОЛ SIGMA», minSdk Android 7), но интеграционного контракта нет. → **не подтверждено, нужно смотреть в личном кабинете АТОЛ / запрашивать у АТОЛ Сигма (support@sigma.ru).**
- **Облачный API SIGMA (cloud.sigma.ru)** — существует, но это товароучёт/двусторонний обмен справочниками, а не пробитие чека. Подтверждена только интеграция «с 1С» через Ключ+Токен в ЛК (https://wiki.itida.ru/integrations/atolsigma: ЛК → Настройки → Интеграции → Интеграция с 1с → Двусторонний обмен, поля «Ключ» и «Токен»). Публичной спецификации эндпоинтов не найдено. Доступно только для «Sigma Торговля», для «Sigma Еда»/«Услуги» двустороннего обмена нет (там же). → **чек через облако пробить нельзя; детали — только в ЛК.**
- **Отдельного «Sigma SDK»/«Sigma Market» для публикации сторонних APK** (аналога Эвотор.Маркет с `dev.evotor.ru`) публично не существует. У Эвотора такой портал есть (https://developer.evotor.ru/docs/doc_java_app_development_prerequisites.html), у АТОЛ Sigma — публичного аналога не найдено. → **не подтверждено, нужно смотреть в личном кабинете АТОЛ (manage.sigma.ru — ЛК партнёра).**

---

## 2A. Вариант A — libfptr10.aar внутри своего приложения

### Подключение
> «Для подключения драйвера к Android-проекту необходимо импортировать в проект библиотеку **libfptr10.aar**. В данной библиотеке (Android Archive, AAR) содержатся нативные библиотеки под все аппаратные платформы Android, а также набор Activity для настройки драйвера. Минимальная поддерживаемая версия Android — 4.0 (API 14).»
> — integration.atol.ru/api/, «Начало работы с драйвером → Подключение к проекту → Java (JVM)»

Общие требования ОС драйвера (там же, «Общая информация»): **Android 7.0–15 (API 25–35)**. То есть `minSdk` библиотеки заявлен 14, но поддерживаемый АТОЛ диапазон — с 25. Для FoodFlow разумно `minSdk = 24..25`.

Классы: `ru.atol.drivers10.fptr.Fptr`, интерфейс `ru.atol.drivers10.fptr.IFptr`, Activity настроек `ru.atol.drivers10.fptr.settings.SettingsActivity` (все три — из официального примера в разделе «Пример использования», вкладка Android).

Где взять aar: Центр загрузок https://fs.atol.ru → «Программное обеспечение» → ДТО → 10.x (архив драйвера содержит каталоги `android` и `android-service`). Регистрация разработчика **не нужна** — по «Правилам использования ДККТ 10 разработчиками ПО» (https://integration.atol.ru/rules/): *«Разработчик вправе использовать Программу на условиях простой (неисключительной) лицензии безвозмездно»*, согласие даётся «с момента скачивания с сайта fs.atol.ru». Обязанность разработчика — дать конечным пользователям ссылку на http://integration.atol.ru/eula/.

### Kotlin: открытие смены
```kotlin
import ru.atol.drivers10.fptr.Fptr
import ru.atol.drivers10.fptr.IFptr

val fptr: IFptr = Fptr(application)

// Настройки связи сохраняются/восстанавливаются самим приложением:
// fptr.settings / fptr.setSettings(json) — драйвер НЕ хранит настройки сам.
fptr.setSingleSetting(IFptr.LIBFPTR_SETTING_PORT, IFptr.LIBFPTR_PORT_USB.toString())
fptr.applySingleSettings()

fptr.open()                       // соединение с ККТ

fptr.setParam(1021, "Иванов И.И.")       // ФИО кассира
fptr.setParam(1203, "500100732259")      // ИНН кассира
fptr.operatorLogin()

fptr.openShift()
// контроль закрытия документа — см. ниже
```
Открывать смену необязательно: *«Открывать смену необязательно, т.к. она будет открыта первой фискальной операцией автоматически»* (раздел «Операции со сменой → Открыть смену»).

### Kotlin: чек прихода «по шагам» (Native API)
Официальный пример (раздел «Пример использования», вкладка Android, переведён в Kotlin 1:1 по именам методов):
```kotlin
fptr.open()

fptr.setParam(1021, "Иванов И.И.")
fptr.setParam(1203, "500100732259")
fptr.operatorLogin()

// Открытие чека
fptr.setParam(IFptr.LIBFPTR_PARAM_RECEIPT_TYPE, IFptr.LIBFPTR_RT_SELL)
fptr.setParam(1008, "+79161234567")          // email или телефон покупателя
fptr.openReceipt()

// Позиция
fptr.setParam(IFptr.LIBFPTR_PARAM_COMMODITY_NAME, "Чипсы LAYS")
fptr.setParam(IFptr.LIBFPTR_PARAM_PRICE, 73.99)
fptr.setParam(IFptr.LIBFPTR_PARAM_QUANTITY, 5)
fptr.setParam(IFptr.LIBFPTR_PARAM_TAX_TYPE, IFptr.LIBFPTR_TAX_VAT10)
fptr.setParam(1212, 1)                        // признак предмета расчёта (товар)
fptr.setParam(1214, 7)                        // признак способа расчёта
fptr.registration()

// Итог (необязателен)
fptr.setParam(IFptr.LIBFPTR_PARAM_SUM, 369.0)
fptr.receiptTotal()

// Оплата
fptr.setParam(IFptr.LIBFPTR_PARAM_PAYMENT_TYPE, IFptr.LIBFPTR_PT_CASH)
fptr.setParam(IFptr.LIBFPTR_PARAM_PAYMENT_SUM, 1000)
fptr.payment()

fptr.closeReceipt()

while (fptr.checkDocumentClosed() < 0) {
    Log.d(TAG, fptr.errorDescription())       // показать ошибку, повторить
}
if (!fptr.getParamBool(IFptr.LIBFPTR_PARAM_DOCUMENT_CLOSED)) {
    fptr.cancelReceipt()                      // документ не закрылся — отменить и переформировать
    return
}
if (!fptr.getParamBool(IFptr.LIBFPTR_PARAM_DOCUMENT_PRINTED)) {
    while (fptr.continuePrint() < 0) { /* кончилась бумага и т.п. */ }
}
```

Обязательные параметры `registration()`: `LIBFPTR_PARAM_COMMODITY_NAME`, `LIBFPTR_PARAM_PRICE`, `LIBFPTR_PARAM_QUANTITY`. Дополнительные: `LIBFPTR_PARAM_TAX_TYPE`, `LIBFPTR_PARAM_POSITION_SUM`, `LIBFPTR_PARAM_DEPARTMENT`, `LIBFPTR_PARAM_TAX_SUM`, `LIBFPTR_PARAM_INFO_DISCOUNT_SUM`, `LIBFPTR_PARAM_USE_ONLY_TAX_TYPE`.

Константы (все из раздела «Операции с чеком»):
- Тип чека `LIBFPTR_PARAM_RECEIPT_TYPE`: `LIBFPTR_RT_SELL`, `LIBFPTR_RT_SELL_RETURN`, `LIBFPTR_RT_SELL_CORRECTION`, `LIBFPTR_RT_SELL_RETURN_CORRECTION`, `LIBFPTR_RT_BUY`, `LIBFPTR_RT_BUY_RETURN`, `LIBFPTR_RT_BUY_CORRECTION`, `LIBFPTR_RT_BUY_RETURN_CORRECTION`.
- НДС `LIBFPTR_PARAM_TAX_TYPE`: `LIBFPTR_TAX_NO`, `_VAT0`, `_VAT5`, `_VAT105`, `_VAT7`, `_VAT107`, `_VAT10`, `_VAT110`, `_VAT20`, `_VAT120`, `_VAT22`, `_VAT122`.
- Оплата `LIBFPTR_PARAM_PAYMENT_TYPE`: `LIBFPTR_PT_CASH` (наличные), `LIBFPTR_PT_ELECTRONICALLY` (безнал), `LIBFPTR_PT_PREPAID`, `LIBFPTR_PT_CREDIT`, `LIBFPTR_PT_OTHER`, `LIBFPTR_PT_6`…`LIBFPTR_PT_10`, плюс `LIBFPTR_PT_ADD_INFO` для тега 1235.
- СНО `1055`: `LIBFPTR_TT_OSN`, `_USN_INCOME`, `_USN_INCOME_OUTCOME`, `_ESN`, `_PATENT`.

Электронный чек: `LIBFPTR_PARAM_RECEIPT_ELECTRONICALLY = true` + обязательно тег `1008`.

> ⚠ Драйвер не потокобезопасен: *«рекомендуется работа с одним экземпляром драйвера строго в одном потоке»*, *«Работа с одним экземпляром драйвера из разных потоков должна контролироваться пользователем»*. Для Compose/offline-first — один выделенный single-thread dispatcher / Service под фискальные операции.

> ⚠ *«Драйвер не сохраняет ранее переданные настройки. При каждом создании экземпляра драйвера необходимо заново подавать настройки»*. Используйте `getSettings()`/`setSettings()` (JSON-строка) и храните её в DataStore.

### Kotlin: JSON-задание через тот же aar (рекомендуемый путь)
Вместо десятка `setParam` можно отправить одно JSON-задание — проще, атомарнее, сразу отдаёт фискальные реквизиты:
```kotlin
fptr.setParam(IFptr.LIBFPTR_PARAM_JSON_DATA, taskJson)
if (fptr.processJson() < 0) { /* fptr.errorCode(), fptr.errorDescription() */ }
val resultJson: String = fptr.getParamString(IFptr.LIBFPTR_PARAM_JSON_DATA)
```
Валидация без выполнения: `fptr.validateJson()` (ошибка `LIBFPTR_ERROR_VALIDATE_FUNC_NOT_FOUND`, если задание нельзя проверить текущим набором скриптов).

---

## 2B/2C. Вариант B/C — Intent / AIDL к `ru.atol.drivers10.service`

Раздел «Android Service» документации. Данные в обе стороны — одинаковые JSON-задания.

### Intent
AndroidManifest.xml (обязательно на Android 11+/API 30):
```xml
<queries>
    <intent>
        <action android:name="ru.atol.drivers10.service.PROCESS_TASK" />
    </intent>
</queries>
```
Вызов (Kotlin):
```kotlin
val intent = Intent().apply {
    action  = "ru.atol.drivers10.service.PROCESS_TASK"
    `package` = "ru.atol.drivers10.service"
    putExtra("PARAM_REQUEST", taskJson)
}
startActivityForResult(intent, 1)

// onActivityResult:
// resultCode == RESULT_OK -> data.getStringExtra("PARAM_RESULT")
```
Точные имена (цитата документации): action `ru.atol.drivers10.service.PROCESS_TASK`, package `ru.atol.drivers10.service`, extra запроса `PARAM_REQUEST`, extra ответа `PARAM_RESULT`.

### AIDL
```xml
<queries><package android:name="ru.atol.drivers10.service" /></queries>
```
```kotlin
val intent = Intent().apply {
    action = "ru.atol.drivers10.service.SERVICE"
    `package` = "ru.atol.drivers10.service"
}
bindService(intent, serviceConnection, BIND_AUTO_CREATE)
// onServiceConnected:
val binder = IFptrService.Stub.asInterface(service)
val result: String = binder.processJson(taskJson)
val svcVer = binder.getServiceVersion()   // версия приложения «АТОЛ. Драйвер ККТ»
val drvVer = binder.getDriverVersion()    // версия драйвера ККТ
```
Файл интерфейса кладётся в `src/main/aidl/ru/atol/drivers10/service/IFptrService.aidl`.

### Broadcast-события драйвера
`ru.atol.drivers10.service.EVENT_SHIFT_OPENED`, `ru.atol.drivers10.service.EVENT_SHIFT_CLOSED` — без доп. параметров. Полезно для offline-first: синхронизировать состояние смены, если её открыли из «Сигма Кассы».

Логи сервиса: `/storage/emulated/0/Android/data/ru.atol.drivers10.service/files`.

### Оболочка ответа Android Service
```json
{ "result": { "error": 0, "description": "Ошибок нет" },
  "data":   { "fiscalParams": { ... }, "warnings": {} } }
```
Ошибка: `{"result":{"error":73,"description":"Смена закрыта - операция невозможна"},"data":{}}`.
(При вызове `processJson()` из aar обёртки `result`/`data` нет — возвращается сразу тело `data`.)

---

## 3. JSON-схемы заданий (единые для aar/Intent/AIDL)

### Чек прихода (`sell`)
Полный пример из документации (ФФД 1.1), сокращён до того, что нужно FoodFlow:
```json
{
  "type": "sell",
  "taxationType": "osn",
  "electronically": false,
  "operator": { "name": "Иванов", "vatin": "123654789507" },
  "clientInfo": { "emailOrPhone": "+79161234567" },
  "items": [
    {
      "type": "position",
      "name": "Бургер классический",
      "price": 73.15,
      "quantity": 1.0,
      "amount": 73.15,
      "department": 1,
      "measurementUnit": "piece",
      "paymentMethod": "fullPayment",
      "paymentObject": "commodity",
      "tax": { "type": "vat20" }
    }
  ],
  "payments": [ { "type": "cash", "sum": 100.00 } ],
  "taxes":    [ { "type": "vat20", "sum": 12.19 } ],
  "total": 73.15
}
```

Поля задания (точно по таблице «Описание задания» раздела «Фискальные чеки»):

| Поле | Значения | Обяз. |
|---|---|---|
| `type` | `sell` / `buy` / `sellReturn` / `buyReturn` | + |
| `taxationType` | `osn`, `usnIncome`, `usnIncomeOutcome`, `esn`, `patent` | можно не передавать, если у ККТ одна СНО |
| `electronically` | bool, по умолчанию false | |
| `internet` | bool, тег 1125 | |
| `operator` | `{name (тег1021, обяз.), vatin (тег1203)}` | |
| `clientInfo` | см. ниже | |
| `companyInfo` | `{ "email": "..." }` — тег 1117 | |
| `items` | массив элементов (`position`, `text`, `barcode`, `pictureFromMemory`, `pixels`) | + |
| `payments` | массив оплат | + |
| `paymentsAddInfo` | тег 1235 | |
| `taxes` | налоги на чек | |
| `total` | итог; если не задан — считается автоматически | |
| `paymentsPlace` / `paymentsAddress` | теги 1187 / 1009 | |
| `machineNumber` | тег 1036 | |
| `preItems` / `postItems` | печать до/после документа | |
| `checkSize` | bool — только посчитать размер чека, чек НЕ пробивается (нужна лицензия №19) | |
| `ignoreNonFiscalPrintErrors` | bool | |
| `validateMarkingCodes` | bool, ФФД ≥1.2 | |
| `salesNotice` | данные уведомления (ФФД ≥1.2) | |

**Позиция (`items[].type = "position"`)**:

| Поле | Описание | Обяз. |
|---|---|---|
| `name` | тег 1030 | + |
| `price` | цена | + |
| `quantity` | тег 1023 | + |
| `amount` | сумма позиции | + |
| `tax` | `{ "type": "...", "sum": n }` — `sum` для позиции необязателен (считается сам) | |
| `department` | отдел, по умолчанию 1 | |
| `infoDiscountAmount` | информационная скидка, 0.0 | |
| `measurementUnit` | ФФД<1.2 — строка (тег 1197); ФФД 1.2 — число/псевдоним (тег 2108): `0 piece`, `10 gram`, `11 kilogram`, `41 liter`, `255 otherUnits` и т.д. Для ФФД 1.2 — **обязательно** | |
| `piece` | bool, не печатать нули в дробной части кол-ва | |
| `paymentMethod` | тег 1214: `fullPrepayment`, `prepayment`, `advance`, `fullPayment`, `partialPayment`, `credit`, `creditPayment`. По умолчанию `fullPrepayment` | |
| `paymentObject` | тег 1212: `commodity`/1, `excise`/2, `job`/3, `service`/4, …, `another`/13, `commodityWithMarking`/33 и т.д. ФФД ≥1.1 по умолчанию `commodity` | |
| `nomenclatureCode` / `markingCode` / `imcParams` | коды маркировки (взаимоисключающие) | |
| `additionalAttribute` | тег 1191 | |
| `exciseSum`, `countryCode`, `customsDeclaration` | теги 1229/1230/1231 | |
| `agentInfo`, `supplierInfo`, `industryInfo`, `productCodes` | | |

**Налог** (`tax` в позиции и элементы `taxes`): `type` ∈ `none, vat0, vat5, vat105, vat7, vat107, vat10, vat110, vat20, vat120, vat22, vat122` (тег 1199); `sum` обязателен для налогов на чек, необязателен для позиции.

**Оплата** (`payments[]`): `type` ∈ `cash`/0 (наличными), `electronically`/1 (безнал), `prepaid`/2, `credit`/3, `other`/4, 5–9 — пользовательские; `sum` — обязательно. Доп. `printItems` (только `text`).
> Правило: *«Оплатить чек свыше его неоплаченного остатка можно только наличным способом оплаты. Поэтому при смешанной оплате нужно сначала зарегистрировать все безналичные оплаты, и только потом наличную.»*

**Сведения о безналичной оплате** (`paymentsAddInfo[]`, тег 1235): `sum` (1082), `paymentMethod` (1236), `electronicallyId` (1237), `electronicallyAddInfo` (1238).

**Покупатель** (`clientInfo`):
```json
{ "emailOrPhone": "+79161234567",   // тег 1008 — email ИЛИ телефон
  "vatin": "112233445573",          // 1228
  "name": "Покупатель А",           // 1227
  "birthDate": "12.04.1989",        // 1243, ФФД≥1.2
  "citizenship": "024",             // 1244
  "identityDocumentCode": "21",     // 1245
  "identityDocumentData": "...",    // 1246
  "address": "..." }                // 1254
```
> При `electronically: true` **обязательно** передать `clientInfo.emailOrPhone`.

**Продавец** (`companyInfo`): `{ "email": "info@mail.ru" }` — тег 1117, по умолчанию берётся из регистрации ККТ.

### Смена
```json
{ "type": "openShift",
  "operator": { "name": "Иванов", "vatin": "123654789507" },
  "electronically": false,
  "additionalAttribute": { "name": "...", "value": "..." },
  "address": "Адрес расчетов",       // тег 1009
  "paymentAddress": "Место расчетов", // тег 1187
  "preItems": [], "postItems": [] }
```
```json
{ "type": "closeShift", "operator": { "name": "Иванов", "vatin": "123654789507" } }
```
Состояние смены:
```json
{ "type": "getShiftStatus" }
// ->
{ "shiftStatus": { "number": 152, "state": "closed",      // closed | opened | expired
                   "expiredTime": "2018-03-06T13:52:59+03:00",
                   "documentsCount": 2 } }
```

### X-отчёт
```json
{ "type": "reportX", "operator": { "name": "Иванов", "vatin": "123654789507" } }
```
Данных результата нет.

### Z-отчёт
Отдельного задания `reportZ` **нет**. Цитата (Native API, «Закрыть смену»): *«Для закрытия смены требуется вызвать метод report() с типом отчета LIBFPTR_PARAM_REPORT_TYPE равным LIBFPTR_RT_CLOSE_SHIFT. Автоматически может напечататься так же и Z-отчет.»* То есть **Z-отчёт = закрытие смены** (`closeShift`). Отдельно доступны: `reportOfdExchangeStatus` (отчёт о состоянии расчётов), `reportDepartments` (по секциям), `reportFnRegistrations`.

### Возврат прихода
То же задание, что и `sell`, только `"type": "sellReturn"`. Схема полей идентична.

### Чек коррекции
```json
{
  "type": "sellCorrection",            // + buyCorrection, sellReturnCorrection (ФФД≥1.1), buyReturnCorrection
  "taxationType": "osn",
  "correctionType": "self",            // тег 1173: self | instruction
  "correctionBaseDate": "2017.07.25",  // тег 1178, формат yyyy.mm.dd
  "correctionBaseNumber": "1175",      // тег 1179
  "operator": { "name": "Иванов", "vatin": "123654789507" },
  "items":    [ /* ФФД ≥1.1 — как в обычном чеке */ ],
  "payments": [ { "type": "cash", "sum": 2000.00 } ],
  "taxes":    [ { "type": "vat20", "sum": 10.0 } ]
}
```
Для ФФД 1.05 `items` не используются — только `payments` + `taxes` + `total`.

### Прочее, что пригодится кассовому клиенту
`cashIn` / `cashOut` (внесение/выплата, поле `cashSum`), `openCashDrawer`, `getCashDrawerStatus`, `nonFiscal` (нефискальная печать — пречек/бегунок кухни!), `printLastReceiptCopy`, `printFnDocument`, `getDeviceInfo`, `getDeviceStatus`, `getFnInfo`, `getFnStatus`, `getShiftTotals`, `getOverallTotals`, `getFnDocument`, `getLicenses`, `setDateTime`, `continuePrint`, `getDeviceParameters`/`setDeviceParameters`.

---

## 4. Что возвращается — фискальные реквизиты

Ответ на `sell` / `sellReturn` / `sellCorrection`:
```json
{
  "fiscalParams": {
    "fiscalDocumentDateTime": "2018-03-06T13:52:00+03:00",  // тег 1012
    "fiscalDocumentNumber": 71,                              // ФД, тег 1040
    "fiscalDocumentSign": "1494325660",                      // ФПД, тег 1077
    "fiscalReceiptNumber": 1,                                // номер чека в смене
    "fnNumber": "9999078900000961",                          // ФН, тег 1041
    "registrationNumber": "0000000001002292",                // РНМ, тег 1037
    "shiftNumber": 12,                                       // тег 1038
    "total": 390.75,
    "fnsUrl": "www.nalog.gov.ru"                             // тег 1060
  },
  "warnings": null
}
```
`warnings.notPrinted: true` — документ **закрыт в ФН, но не допечатан** (кончилась бумага). Обязательно обработать: показать кассиру и вызвать `continuePrint`.

Ответ на `openShift`: тот же набор минус `fiscalReceiptNumber`/`total`.
Ответ на `closeShift`: плюс `receiptsCount` (кол-во чеков за смену).

**Ссылка ОФД / QR чека.** В `fiscalParams` ссылки ОФД нет. QR-код чека (реквизит **1196**) отдаётся заданием `getFnDocument` по номеру ФД:
```json
{ "type": "getFnDocument", "documentNumber": 71 }
// -> documentTLV: { "fiscalDocumentType": "receipt",
//                   "qr": "t=20200206T1201&s=15.00&fn=9999078900011722&i=123&fp=2883326683&n=1",
//                   "1203": "...", ... , "short": false }
```
Из `qr` + `fnsUrl` собирается ссылка для проверки чека. Адрес конкретного ОФД берётся из `getRegistrationInfo` → `ofd: { name, vatin, host, port }`.

Native API аналоги: `fnQueryData()` с `LIBFPTR_FNDT_LAST_RECEIPT` → `LIBFPTR_PARAM_DOCUMENT_NUMBER`, `LIBFPTR_PARAM_RECEIPT_SUM`, `LIBFPTR_PARAM_FISCAL_SIGN`, `LIBFPTR_PARAM_DATE_TIME`, `LIBFPTR_PARAM_RECEIPT_TYPE`.

---

## 5. Сборка и установка APK на Sigma

**Подтверждено:**
- Устройство — Android-планшетный модуль + встроенная ККТ (АТОЛ 150Ф для Sigma 10). Обновление образа планшета — OTA через Настройки → Система → О планшете → Состояние планшетного модуля → Обновление системы (Руководство по эксплуатации Sigma 10, Приложение 5).
- **Установка стороннего APK штатно возможна** и не требует подписи АТОЛ. Процедура для Sigma 8/10 (инструкция Saby, собранная для реального стороннего приложения):
  1. положить APK на USB-флешку, вставить в терминал;
  2. Главное меню → **Настройки** → раздел **Безопасность** → включить **«Неизвестные источники»**;
  3. Главное меню → **Диспетчер файлов / USB-накопитель** → выбрать файл → **Установить**.
  (На сборках ККТ выше `1692625851` Saby ставится через «Обновление системы» — это их собственный канал доставки, не общий механизм.)
- Sigma имеет 4 разъёма USB-A (Руководство Sigma 10, «Правила подключения внешних USB-устройств»).
- `minSdk`: aar драйвера заявляет Android 4.0 (API 14); официально поддерживаемый АТОЛ диапазон — **Android 7.0–15 (API 25–35)**. Приложение «SIGMA Касса» в RuStore требует минимум Android 7. Безопасный выбор для FoodFlow: `minSdk 24–25`, `targetSdk` актуальный.
- Подпись: обычная подпись разработчика. Никаких требований к сертификату АТОЛ в документации нет; лицензия ДККТ 10 для разработчиков — безвозмездная, без регистрации (https://integration.atol.ru/rules/).

**НЕ подтверждено:**
- Включение **режима разработчика и установки по `adb`** на Sigma (ни точного пути в меню, ни политики АТОЛ на этот счёт) — в руководстве по эксплуатации Sigma 10 слов «ADB», «отладка по USB», «режим разработчика» нет. → **не подтверждено, нужно проверять на живом устройстве / в личном кабинете АТОЛ.** Практически: Android-настройки на устройстве доступны (раздел «Безопасность» точно есть), поэтому стандартный путь «Настройки → О планшете → 7 тапов по номеру сборки → Для разработчиков → Отладка по USB» с высокой вероятностью работает, но официального подтверждения нет.
- **Модерация в «Sigma Market»** — публичного магазина приложений для сторонних разработчиков у АТОЛ Sigma не найдено (в отличие от Эвотор.Маркета). → **не подтверждено, нужно смотреть в личном кабинете АТОЛ (manage.sigma.ru) или спрашивать АТОЛ Сигма.**
- Возможные ограничения на одновременную работу «Сигма Кассы» и стороннего приложения с одной ККТ (кто держит порт). Документация ДККТ прямо говорит: *«одна ККТ — один экземпляр драйвера»*. На практике это значит, что **стороннее приложение и «Сигма Касса» не должны держать соединение с ККТ одновременно**; как это разруливается на Sigma — **не подтверждено, проверять на устройстве.**
- Точное значение `LIBFPTR_SETTING_PORT` для встроенной ККТ Sigma. В Руководстве Sigma 10 сказано только, что приложение «Драйвер ККТ» *«активируется автоматически»* и в блоке «НАСТРОЙКИ СВЯЗИ С ККТ» показывает модель и ЗН. Для Android драйвер поддерживает `LIBFPTR_PORT_COM`, `LIBFPTR_PORT_USB`, `LIBFPTR_PORT_TCPIP`, `LIBFPTR_PORT_BLUETOOTH`. Для встроенного ФР ожидаемо `USB` или `COM` + `LIBFPTR_SETTING_COM_FILE`. → **точное значение не подтверждено; снять через `SettingsActivity` на реальном устройстве или через `getSettings()` у уже настроенного драйвера.**
- Модель ККТ есть в списке констант драйвера: `LIBFPTR_MODEL_ATOL_SIGMA_10`, `LIBFPTR_MODEL_ATOL_SIGMA_7F`, `LIBFPTR_MODEL_ATOL_SIGMA_8F` (раздел «Настройка драйвера → Список настроек»).

---

## 6. Где брать SDK и документацию

| Что | Где | Регистрация |
|---|---|---|
| Документация ДККТ 10 (API, JSON, Android Service) | https://integration.atol.ru/api/ | не нужна |
| WebRequests (REST, не для Android) | https://integration.atol.ru/web_requests/ | не нужна |
| JPOS / OPOS | https://integration.atol.ru/jpos/ , /opos/ | не нужна |
| Правила для разработчиков + EULA | https://integration.atol.ru/rules/ , https://integration.atol.ru/eula/ | не нужна |
| Дистрибутив драйвера (libfptr10.aar, AtolDriver.apk) | https://fs.atol.ru → Программное обеспечение → ДТО → 10.x (внутри архива каталоги `android` и `android-service`) | скачивание открытое; раздел «Вход для аккредитованных сервисных партнёров» нужен только для сервисных материалов |
| Документация и прошивки Sigma 7/8/10 | https://fs.atol.ru → Смарт-терминалы АТОЛ Sigma | открыто |
| Перечень поддерживаемых моделей ККТ | https://ac.atol.ru/#devices | открыто |
| ЛК клиента SIGMA (облако, товароучёт) | https://cloud.sigma.ru/login (вход через АТОЛ ID) | да |
| ЛК партнёра SIGMA | https://manage.sigma.ru/login | да |
| База знаний SIGMA | https://support.sigma.ru/ | частично |

**Лицензии ККТ, важно для бюджета/функций:** часть возможностей требует активных лицензий внутри ККТ (`getLicenses`): №17 — объединение позиций в ПФ и непечать меры количества; №19 — предварительный расчёт размера чека (`checkSize`), автосинхронизация времени, часовая зона устройства; №4 — ФФД 1.1; №8 — печать графики и ШК. Проверять заданием `{"type":"getLicenses"}`.

---

## 7. Рекомендация по архитектуре для FoodFlow

1. **Транспорт:** `libfptr10.aar` внутри приложения + `processJson()`. Одно JSON-задание = один фискальный документ = одна атомарная операция, которую удобно класть в offline-очередь.
2. **Поток:** выделенный single-thread executor/`Dispatchers` для одного экземпляра `Fptr` (драйвер не потокобезопасен). Экземпляр живёт в foreground Service, не пересоздавать (фоновая отправка в ОФД требует постоянного соединения).
3. **Настройки:** `getSettings()` → JSON → DataStore; при старте `setSettings()`.
4. **Идемпотентность:** после `processJson()`, если связь оборвалась, не повторять чек вслепую — сначала `getFnDocument`/`fnQueryData(LAST_RECEIPT)` и сверить сумму/время; при Native-пути — `checkDocumentClosed()` + `LIBFPTR_PARAM_DOCUMENT_CLOSED`/`DOCUMENT_PRINTED`.
5. **Смена:** подписаться на `EVENT_SHIFT_OPENED`/`EVENT_SHIFT_CLOSED` (если рядом стоит `ru.atol.drivers10.service`), иначе опрашивать `getShiftStatus` перед каждым чеком — смена может «истечь» (`expired`, 24 часа).
6. **Фискальные реквизиты** (`fnNumber`, `fiscalDocumentNumber`, `fiscalDocumentSign`, `shiftNumber`, `fiscalReceiptNumber`, `fnsUrl`) складывать в локальную БД вместе с заказом и синхронизировать на бэкенд — это и есть «доказательство» пробитого чека.
7. **Пречек/бегунок на кухню** — задание `nonFiscal` (text/barcode/pictureFromMemory), фискальный счётчик не трогает.
