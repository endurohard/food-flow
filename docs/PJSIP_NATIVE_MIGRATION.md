# Миграция на нативный PJSIP

## Текущее состояние

**Текущая реализация** использует библиотеку `sip.js`, которая предназначена для WebRTC/SIP в браузере и требует WebSocket транспорт.

**Ограничения**:
- ❌ Не поддерживает нативный UDP/TCP SIP
- ❌ Требует WebSocket прокси на SIP сервере
- ❌ Ограниченная функциональность

## Рекомендуемое решение: Native PJSIP

**PJSIP** (PJSUA2) - это полноценная C++ библиотека для SIP/VoIP с Node.js биндингами.

### Преимущества нативного PJSIP

✅ Поддержка всех SIP транспортов (UDP, TCP, TLS)
✅ Полная реализация SIP протокола
✅ Поддержка всех аудио кодеков
✅ STUN/TURN/ICE для NAT traversal
✅ Низкая задержка и высокое качество
✅ Используется в промышленных решениях (Asterisk, FreeSWITCH)

### Варианты реализации

#### 1. pjsua2 (Рекомендуется)

**Репозиторий**: https://github.com/pjsip/pjproject

**Установка**:
```bash
# Установить зависимости для компиляции
sudo apt-get install build-essential python3-dev swig

# Клонировать PJSIP
git clone https://github.com/pjsip/pjproject.git
cd pjproject

# Конфигурация и сборка
./configure --enable-shared
make dep && make
sudo make install

# Установить Python биндинги (для Node.js нужен дополнительный слой)
cd pjsip-apps/src/swig
make
```

**Использование через child_process**:
Можно создать Python скрипт, который использует PJSUA2 и взаимодействует с Node.js через IPC.

#### 2. node-pjsua2 (Community)

**Репозиторий**: https://www.npmjs.com/package/pjsua2

```bash
npm install pjsua2
```

⚠️ **Примечание**: Требует предварительной установки PJSIP библиотек в системе.

#### 3. Asterisk/FreeSWITCH + AMI/ESL (Альтернатива)

Вместо прямого PJSIP можно использовать готовый SIP сервер:

**Asterisk Manager Interface (AMI)**:
```bash
npm install asterisk-manager
```

**FreeSWITCH Event Socket Library (ESL)**:
```bash
npm install modesl
```

## План миграции

### Этап 1: Подготовка инфраструктуры

1. **Выбрать подход**:
   - Вариант A: Нативный PJSIP через Python wrapper
   - Вариант B: Asterisk AMI
   - Вариант C: FreeSWITCH ESL

2. **Установить зависимости**:
   ```bash
   # Для PJSIP
   docker-compose exec pjsip-service apk add --no-cache \
     build-base python3 python3-dev swig openssl-dev

   # Или создать новый Dockerfile с PJSIP
   ```

3. **Настроить SIP сервер** (если используется Asterisk/FreeSWITCH)

### Этап 2: Создание PJSIP Python wrapper

**Файл**: `services/pjsip-service/pjsip-wrapper.py`

```python
import pjsua2 as pj
import json
import sys

class Account(pj.Account):
    def __init__(self):
        pj.Account.__init__(self)

    def onIncomingCall(self, prm):
        call = MyCall(self, prm.callId)
        call_info = call.getInfo()

        # Отправить событие в Node.js
        event = {
            "type": "incoming_call",
            "from": call_info.remoteUri,
            "to": call_info.localUri
        }
        print(json.dumps(event))
        sys.stdout.flush()

class MyCall(pj.Call):
    def __init__(self, acc, call_id=pj.PJSUA_INVALID_ID):
        pj.Call.__init__(self, acc, call_id)

def main():
    # Инициализация PJSIP
    ep = pj.Endpoint()
    ep.libCreate()

    ep_cfg = pj.EpConfig()
    ep.libInit(ep_cfg)

    # Создать транспорт
    sipTpConfig = pj.TransportConfig()
    sipTpConfig.port = 5060
    ep.transportCreate(pj.PJSIP_TRANSPORT_UDP, sipTpConfig)

    # Запустить библиотеку
    ep.libStart()

    # Регистрация аккаунта
    acc = Account()
    acc_cfg = pj.AccountConfig()
    acc_cfg.idUri = "sip:7779@it005.ru"
    acc_cfg.regConfig.registrarUri = "sip:it005.ru"

    cred = pj.AuthCredInfo("digest", "*", "7779", 0, "90PQchO8DxW")
    acc_cfg.sipConfig.authCreds.append(cred)

    acc.create(acc_cfg)

    # Главный цикл
    while True:
        # Читать команды из stdin
        line = sys.stdin.readline().strip()
        if not line:
            continue

        cmd = json.loads(line)

        if cmd["action"] == "call":
            # Совершить звонок
            call = MyCall(acc)
            prm = pj.CallOpParam()
            call.makeCall(cmd["to"], prm)

        elif cmd["action"] == "hangup":
            # Завершить звонок
            pass

if __name__ == "__main__":
    main()
```

### Этап 3: Node.js интеграция

**Файл**: `services/pjsip-service/src/services/pjsip-native.service.ts`

```typescript
import { spawn, ChildProcess } from 'child_process';

export class PJSIPNativeService {
  private process: ChildProcess | null = null;

  async start() {
    this.process = spawn('python3', ['pjsip-wrapper.py']);

    // Обработка событий от Python
    this.process.stdout?.on('data', (data) => {
      const event = JSON.parse(data.toString());
      this.handleEvent(event);
    });

    this.process.stderr?.on('data', (data) => {
      console.error('PJSIP Error:', data.toString());
    });
  }

  async makeCall(from: string, to: string) {
    const command = {
      action: 'call',
      from,
      to
    };

    this.process?.stdin?.write(JSON.stringify(command) + '\n');
  }

  private handleEvent(event: any) {
    switch (event.type) {
      case 'incoming_call':
        // Обработать входящий звонок
        console.log('Incoming call from:', event.from);
        break;
    }
  }
}
```

### Этап 4: Обновление Dockerfile

```dockerfile
FROM node:18-alpine

# Установить зависимости для PJSIP
RUN apk add --no-cache \
    build-base \
    python3 \
    python3-dev \
    py3-pip \
    swig \
    openssl-dev \
    alsa-lib-dev

# Скачать и собрать PJSIP
WORKDIR /tmp
RUN wget https://github.com/pjsip/pjproject/archive/refs/tags/2.14.tar.gz && \
    tar xzf 2.14.tar.gz && \
    cd pjproject-2.14 && \
    ./configure --enable-shared --disable-sound CFLAGS="-O2 -fPIC" && \
    make dep && make && make install && \
    cd pjsip-apps/src/swig && make

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

CMD ["npm", "start"]
```

### Этап 5: Тестирование

```bash
# Пересобрать образ
docker-compose build pjsip-service

# Запустить
docker-compose up -d pjsip-service

# Проверить логи
docker-compose logs -f pjsip-service
```

## Альтернативный подход: Asterisk AMI

Если настройка нативного PJSIP слишком сложна, можно использовать Asterisk:

```typescript
import AsteriskManager from 'asterisk-manager';

const ami = new AsteriskManager(
  5038,
  'it005.ru',
  'admin',
  'password',
  true
);

ami.on('managerevent', (event) => {
  if (event.event === 'Newchannel') {
    console.log('New call:', event);
  }
});

// Инициировать звонок
ami.action({
  action: 'Originate',
  channel: 'SIP/7779',
  exten: '1000',
  context: 'default',
  priority: 1
});
```

## Текущая конфигурация

### База данных

Настройки уже поддерживают оба типа подключения:

```sql
-- Нативный PJSIP (UDP/TCP/TLS)
pbx_server: it005.ru
pbx_port: 5060
pbx_transport: UDP
pbx_rtp_port_min: 10000
pbx_rtp_port_max: 12000
pbx_use_websocket: false

-- WebSocket (для текущей реализации sip.js)
pbx_websocket_url: wss://it005.ru:8089/ws
pbx_use_websocket: true
```

### Пользователи

```sql
pbx_extension: 7779
pbx_username: 7779
pbx_password: 90PQchO8DxW
pbx_display_name: Оператор call-центра
```

## Следующие шаги

1. ✅ База данных готова (поля для обоих типов подключения)
2. ✅ API endpoints готовы
3. ✅ Веб-интерфейс обновлен (выбор типа подключения)
4. 🔄 Выбрать метод реализации (PJSIP native / Asterisk AMI / FreeSWITCH ESL)
5. ⏳ Реализовать выбранный метод
6. ⏳ Тестирование с реальным SIP сервером it005.ru

## Рекомендация

Для production среды рекомендуется использовать **Asterisk AMI** или **FreeSWITCH ESL**, так как:
- Проще в настройке и поддержке
- Не требует компиляции C++ кода
- Надежнее в Docker окружении
- Много готовых примеров и документации
- Asterisk/FreeSWITCH можно запустить в отдельном контейнере

Для прямого PJSIP нужна значительная экспертиза в C++ и сложная сборка в Docker.
