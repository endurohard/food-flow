# Интеграция телефонии с Yeastar PBX

## Доступные режимы подключения

FoodFlow поддерживает три режима интеграции с Yeastar PBX:

### 1. AMI (Asterisk Manager Interface) ✅ Рекомендуется

**Описание:** Управление звонками через AMI протокол Asterisk.

**Когда использовать:**
- Только мониторинг и управление звонками
- Не нужна обработка аудио на стороне сервера
- Легкая интеграция

**Требования:**
- Порт: 5038 (TCP)
- RTP порты: ❌ Не нужны
- Учетные данные AMI

**Конфигурация Docker:**
```yaml
yeastar-service:
  environment:
    YEASTAR_HOST: www.it005.ru
    YEASTAR_PORT: 5038
    YEASTAR_USERNAME: ami_user
    YEASTAR_PASSWORD: ami_password
```

**Возможности:**
- ✅ Мониторинг активных звонков
- ✅ История звонков
- ✅ Click-to-call (инициация звонков)
- ✅ Завершение звонков
- ✅ Статус добавочных
- ❌ Обработка аудио (делает PBX)

---

### 2. Native PJSIP (UDP/TCP/TLS)

**Описание:** Прямое подключение к SIP серверу через нативный протокол.

**Когда использовать:**
- Нужна обработка аудио на стороне сервера
- SIP trunk интеграция
- Максимальная совместимость

**Требования:**
- Порт: 5060 (UDP/TCP) или 5061 (TLS)
- RTP порты: ✅ Нужны (например, 5700-5750 UDP)
- SIP учетные данные

**Конфигурация Docker:**
```yaml
pjsip-service:
  environment:
    SIP_SERVER: 192.168.5.150
    SIP_PORT: 5060
    SIP_TRANSPORT: UDP
    SIP_USE_WEBSOCKET: "false"
    SIP_USERS: extension:password:extension:Display Name
    RTP_PORT_MIN: 5700
    RTP_PORT_MAX: 5750
  ports:
    - "5060:5060/udp"
    - "5700-5750:5700-5750/udp"
```

**Возможности:**
- ✅ Мониторинг звонков
- ✅ Click-to-call
- ✅ Обработка аудио сервисом
- ✅ Запись разговоров
- ✅ IVR и автоответчики

---

### 3. WebSocket (SIP over WebSocket + WebRTC)

**Описание:** Подключение через WebSocket для браузерных клиентов.

**Когда использовать:**
- Web-клиенты в браузере
- Softphone в админ-панели
- Мобильные Progressive Web Apps

**Требования:**
- Порт: 8088 (WS) или 8089 (WSS)
- RTP порты: ❌ Не нужны (WebRTC в браузере)
- SIP учетные данные + WebSocket пароль

**Конфигурация Docker:**
```yaml
pjsip-service:
  environment:
    SIP_SERVER: www.it005.ru
    SIP_PORT: 8088
    SIP_TRANSPORT: WS
    SIP_USE_WEBSOCKET: "true"
    SIP_WEBSOCKET_URL: wss://www.it005.ru:8089/ws
    SIP_USERS: extension:password:extension:Display Name:ws_password
  # Порты RTP НЕ нужны!
```

**Конфигурация Yeastar:**
```ini
# /etc/asterisk/http.conf
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089

# /etc/asterisk/pjsip.conf
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089

[extension_template]
type=endpoint
webrtc=yes
```

**Возможности:**
- ✅ Мониторинг звонков
- ✅ Click-to-call из браузера
- ✅ Аудио/видео в браузере
- ✅ WebRTC шифрование
- ❌ Не нужен отдельный softphone

---

## Сравнение режимов

| Функция | AMI | Native PJSIP | WebSocket |
|---------|-----|--------------|-----------|
| Мониторинг звонков | ✅ | ✅ | ✅ |
| Click-to-call | ✅ | ✅ | ✅ |
| Управление звонками | ✅ | ✅ | ✅ |
| Обработка аудио | ❌ | ✅ | Browser ✅ |
| RTP порты нужны | ❌ | ✅ | ❌ |
| Простота настройки | ⭐⭐⭐ | ⭐⭐ | ⭐ |
| Производительность | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| Браузерный клиент | ❌ | ❌ | ✅ |
| Запись звонков | ❌ | ✅ | ❌ |

---

## Рекомендации по выбору

### Выбирайте AMI если:
- ✅ Вам нужен только мониторинг и управление
- ✅ PBX сам обрабатывает все звонки
- ✅ Нужна простая и быстрая интеграция
- ✅ **Это самый популярный выбор!**

### Выбирайте Native PJSIP если:
- ✅ Нужна обработка аудио на сервере
- ✅ Запись разговоров
- ✅ IVR или автоответчик
- ✅ SIP trunk от провайдера

### Выбирайте WebSocket если:
- ✅ Нужен softphone в браузере
- ✅ Web-клиент для операторов
- ✅ PWA приложение
- ✅ Не хотите устанавливать softphone

---

## Комбинированное использование

Можно использовать **несколько режимов одновременно**:

```yaml
services:
  # AMI для мониторинга (легковесный)
  yeastar-service:
    ...

  # Native PJSIP для SIP trunk
  pjsip-service:
    ...
```

**Пример use case:**
- AMI - мониторинг всех звонков в ресторане
- Native PJSIP - SIP trunk для исходящих звонков
- WebSocket - веб-клиент для менеджера

---

## Настройка в веб-интерфейсе

1. Откройте **Настройки** → **Настройки АТС**
2. Выберите **Метод подключения**:
   - Native PJSIP (UDP/TCP/TLS)
   - WebSocket (WS/WSS)
3. Заполните параметры подключения
4. **RTP порты** автоматически используются только для Native режима
5. Сохраните и перезапустите сервис

---

## FAQ

### Q: Нужны ли RTP порты для WebSocket?
**A:** ❌ Нет! WebSocket использует WebRTC в браузере, который сам управляет медиа. RTP порты обрабатывает браузер, а не сервер.

### Q: Можно ли использовать AMI и PJSIP вместе?
**A:** ✅ Да! AMI для мониторинга, PJSIP для обработки звонков.

### Q: Какой режим самый быстрый?
**A:** AMI - только управление, минимальная нагрузка. WebSocket также легковесный, т.к. медиа в браузере.

### Q: Как включить WebSocket на Yeastar?
**A:** В веб-интерфейсе Yeastar: Settings → Advanced → HTTP/WebSocket → Enable WebSocket

### Q: Нужен ли отдельный пароль для WebSocket?
**A:** ✅ Да, в большинстве случаев WebSocket использует отдельный пароль, отличный от SIP пароля.

---

## Порты по умолчанию

| Протокол | Порт | Описание |
|----------|------|----------|
| SIP UDP | 5060 | Стандартный SIP |
| SIP TCP | 5060 | SIP через TCP |
| SIP TLS | 5061 | Зашифрованный SIP |
| AMI | 5038 | Asterisk Manager |
| WebSocket | 8088 | HTTP WebSocket |
| WebSocket TLS | 8089 | HTTPS WebSocket |
| RTP | 5700-5750 | Аудио (только Native) |

---

## Troubleshooting

### AMI не подключается
- Проверьте `/etc/asterisk/manager.conf`
- Убедитесь что AMI включен: `enabled = yes`
- Проверьте права пользователя: `read = all, write = all`
- Проверьте IP whitelist: `permit = 0.0.0.0/0.0.0.0`

### WebSocket не работает
- Проверьте `/etc/asterisk/http.conf`
- Включите WebSocket: `enabled = yes`
- Проверьте сертификаты для WSS
- Используйте правильный WebSocket пароль

### Нет аудио в Native режиме
- Проверьте что RTP порты открыты в firewall
- Убедитесь что Docker пробросил UDP порты
- Проверьте `RTP_PORT_MIN` и `RTP_PORT_MAX`

---

Создано: 2025-11-09
Версия: 1.0
