# Карта гостя в Apple Wallet — подключение сертификата

Код готов и выкачен: без сертификата функция выключена, кнопки «Добавить в
Apple Wallet» на странице карты нет. Ниже — что сделать один раз.

## 1. Apple Developer

1. Аккаунт Apple Developer Program (организация или ИП, 99 $ в год).
2. Certificates, Identifiers & Profiles → Identifiers → «+» → **Pass Type IDs**.
   Описание: «FoodFlow карта гостя», идентификатор: `pass.ru.foodflow.card`
   (можно свой, но он же потом пойдёт в `.env`).
3. Team ID — в правом верхнем углу кабинета (10 символов).

## 2. Сертификат Pass Type ID

На Mac:

1. «Связка ключей» → меню «Ассистент сертификации» → «Запросить сертификат у
   бюро сертификации». Почта своя, «Сохранить на диске» → `pass.certSigningRequest`.
2. В кабинете: Identifiers → ваш Pass Type ID → **Create Certificate** →
   загрузить `.certSigningRequest` → скачать `pass.cer`.
3. Открыть `pass.cer` двойным щелчком — встанет в «Связку ключей» вместе с
   закрытым ключом. Экспортировать пару (сертификат + ключ) в `pass.p12`
   с паролем.
4. Промежуточный сертификат Apple **WWDR G4**:
   https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer

Перевести в PEM (пароль от `.p12` вводится в терминале, в переписку его не
присылать):

```bash
openssl pkcs12 -in pass.p12 -clcerts -nokeys -out signerCert.pem -legacy
openssl pkcs12 -in pass.p12 -nocerts -out signerKey.pem -legacy   # спросит пароль p12 и новый пароль ключа
openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
```

Если `-legacy` не поддерживается вашей версией openssl — уберите его.

## 3. На сервер (iTTEST)

```bash
ssh iTTEST 'mkdir -p ~/food-flow/secrets/wallet && chmod 700 ~/food-flow/secrets/wallet'
scp signerCert.pem signerKey.pem wwdr.pem iTTEST:~/food-flow/secrets/wallet/
ssh iTTEST 'chmod 600 ~/food-flow/secrets/wallet/*'
```

В `~/food-flow/.env` на сервере (пароль ключа вписать самому):

```
WALLET_PASS_TYPE_ID=pass.ru.foodflow.card
WALLET_TEAM_ID=XXXXXXXXXX
WALLET_KEY_PASSPHRASE=пароль-ключа-из-шага-2
```

Пересоздать контейнер (перезапуска мало — окружение читается при создании):

```bash
ssh iTTEST 'cd ~/food-flow && docker compose up -d --no-build crm-service && docker logs crm-service --since 1m | grep "Apple Wallet"'
```

В логе должно быть `Apple Wallet включён (pass.ru.foodflow.card)`. После этого
на странице карты появится кнопка «Добавить в Apple Wallet».

## Как устроено

- Карта: `GET /api/crm/card/<секрет ссылки>/wallet.pkpass` — баллы, уровень
  и скидка, имя, путь до следующего уровня, номер, штрихкод Code128 (запасной —
  QR); цвет карты зависит от уровня; на обороте — ссылка на карту и последние
  операции.
- Обновления: телефон регистрируется в `/api/wallet/v1/…` (протокол Apple).
  Любое изменение баллов, уровня или ссылки ставит в БД `wallet_updated_at`
  (триггер), сервис раз в 30 секунд будит телефоны push через APNs, и они
  сами забирают новую версию карты.
- Сертификат действует год: за месяц до окончания выпустить новый тем же
  путём и заменить файлы. Просроченный сертификат = карты перестают
  обновляться и не добавляются новые.
