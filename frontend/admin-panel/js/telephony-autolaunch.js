/**
 * Telephony Auto-Launch Script
 * Автоматический запуск и настройка телефонного клиента при входе оператора
 */

class TelephonyAutoLauncher {
    constructor() {
        this.API_BASE = window.location.origin;
        this.currentUser = null;
        this.sipClient = null;
        this.isRegistered = false;
        this.autoLaunchEnabled = localStorage.getItem('telephony_autolaunch') !== 'false';
    }

    /**
     * Инициализация при загрузке страницы
     */
    async init() {
        console.log('🚀 Telephony Auto-Launcher: Initializing...');

        // Загружаем данные текущего пользователя
        await this.loadCurrentUser();

        // Проверяем наличие SIP учетных данных
        if (this.hasUserSIPCredentials()) {
            console.log('✅ SIP credentials found for user:', this.currentUser.username);

            if (this.autoLaunchEnabled) {
                console.log('🎯 Auto-launch is enabled, starting telephony...');
                await this.launchTelephony();
            } else {
                console.log('⏸️ Auto-launch is disabled, showing notification...');
                this.showLaunchNotification();
            }
        } else {
            console.log('⚠️ No SIP credentials found for current user');
            this.showSetupNotification();
        }
    }

    /**
     * Загрузка данных текущего пользователя
     */
    async loadCurrentUser() {
        try {
            // Пытаемся загрузить из localStorage (для демо)
            const savedUser = localStorage.getItem('currentUser');
            if (savedUser) {
                this.currentUser = JSON.parse(savedUser);
                return;
            }

            // Загрузка с сервера
            const response = await fetch(`${this.API_BASE}/api/auth/me`);
            if (response.ok) {
                this.currentUser = await response.json();
                localStorage.setItem('currentUser', JSON.stringify(this.currentUser));
            } else {
                // Создаем демо пользователя для тестирования
                this.currentUser = this.createDemoUser();
            }
        } catch (error) {
            console.error('Error loading current user:', error);
            // Используем демо данные
            this.currentUser = this.createDemoUser();
        }
    }

    /**
     * Создание демо пользователя
     */
    createDemoUser() {
        return {
            id: 1,
            username: 'operator1',
            displayName: 'Оператор 1',
            role: 'operator',
            sip: {
                enabled: true,
                extension: '7779',
                password: '5TQNF_Srld',
                server: 'www.it005.ru',
                port: 5060,
                transport: 'UDP',
                displayName: 'Оператор 1',
                wsPassword: '5TQNF_Srld' // для WebSocket
            }
        };
    }

    /**
     * Проверка наличия SIP учетных данных
     */
    hasUserSIPCredentials() {
        return this.currentUser
            && this.currentUser.sip
            && this.currentUser.sip.enabled
            && this.currentUser.sip.extension
            && this.currentUser.sip.password;
    }

    /**
     * Получение SIP конфигурации пользователя
     */
    getUserSIPConfig() {
        if (!this.hasUserSIPCredentials()) {
            return null;
        }

        const sip = this.currentUser.sip;
        return {
            extension: sip.extension,
            password: sip.password,
            server: sip.server || 'www.it005.ru',
            port: sip.port || 5060,
            transport: sip.transport || 'UDP',
            displayName: sip.displayName || this.currentUser.displayName,
            wsPassword: sip.wsPassword || sip.password,
            wsUrl: sip.wsUrl || `wss://${sip.server}:8089/ws`
        };
    }

    /**
     * Запуск телефонии с автоматической настройкой
     */
    async launchTelephony() {
        const config = this.getUserSIPConfig();
        if (!config) {
            console.error('Cannot launch telephony: No SIP config');
            return;
        }

        console.log('📞 Launching telephony with config:', {
            extension: config.extension,
            server: config.server,
            transport: config.transport
        });

        try {
            // Отправляем конфигурацию на сервер
            await this.configurePBXService(config);

            // Показываем статус
            this.showTelephonyStatus('connecting', 'Подключение к PBX...');

            // Ждем подключения
            setTimeout(() => {
                this.checkConnectionStatus();
            }, 3000);

            // Открываем панель звонков (опционально)
            if (localStorage.getItem('telephony_show_panel') === 'true') {
                this.showTelephonyPanel();
            }

        } catch (error) {
            console.error('Error launching telephony:', error);
            this.showTelephonyStatus('error', 'Ошибка подключения');
        }
    }

    /**
     * Настройка PBX сервиса
     */
    async configurePBXService(config) {
        try {
            const response = await fetch(`${this.API_BASE}/api/pbx/switch-transport`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    server: config.server,
                    port: config.port,
                    transport: config.transport,
                    websocketUrl: config.wsUrl,
                    useWebSocket: config.transport === 'WS' || config.transport === 'WSS',
                    users: [{
                        username: config.extension,
                        password: config.password,
                        extension: config.extension,
                        displayName: config.displayName,
                        wsPassword: config.wsPassword
                    }]
                })
            });

            if (response.ok) {
                console.log('✅ PBX service configured successfully');
                return true;
            } else {
                console.error('❌ Failed to configure PBX service');
                return false;
            }
        } catch (error) {
            console.error('Error configuring PBX:', error);
            return false;
        }
    }

    /**
     * Проверка статуса подключения
     */
    async checkConnectionStatus() {
        try {
            const response = await fetch(`${this.API_BASE}/api/pbx/connection`);
            if (response.ok) {
                const data = await response.json();

                if (data.connected) {
                    this.showTelephonyStatus('connected', '✅ Подключено к PBX');
                    this.isRegistered = true;
                } else {
                    this.showTelephonyStatus('disconnected', '⚠️ Не подключено');
                }
            }
        } catch (error) {
            this.showTelephonyStatus('error', '❌ Ошибка соединения');
        }
    }

    /**
     * Показ статуса телефонии
     */
    showTelephonyStatus(status, message) {
        // Создаем или обновляем индикатор в navbar
        let indicator = document.getElementById('telephony-status');

        if (!indicator) {
            const navbar = document.querySelector('.navbar');
            if (!navbar) return;

            indicator = document.createElement('div');
            indicator.id = 'telephony-status';
            indicator.style.cssText = `
                position: fixed;
                top: 70px;
                right: 20px;
                padding: 12px 16px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                z-index: 999;
                cursor: pointer;
                transition: all 0.3s;
            `;

            indicator.addEventListener('click', () => {
                window.location.href = '/admin-panel/calls.html';
            });

            document.body.appendChild(indicator);
        }

        // Стили в зависимости от статуса
        const styles = {
            connecting: {
                background: '#fff3cd',
                color: '#856404',
                icon: '⏳'
            },
            connected: {
                background: '#d4edda',
                color: '#155724',
                icon: '📞'
            },
            disconnected: {
                background: '#f8d7da',
                color: '#721c24',
                icon: '📵'
            },
            error: {
                background: '#f8d7da',
                color: '#721c24',
                icon: '❌'
            }
        };

        const style = styles[status] || styles.disconnected;
        indicator.style.background = style.background;
        indicator.style.color = style.color;
        indicator.innerHTML = `${style.icon} ${message}`;

        // Автоскрытие для успешного подключения
        if (status === 'connected') {
            setTimeout(() => {
                indicator.style.opacity = '0';
                setTimeout(() => {
                    indicator.style.top = '-100px';
                }, 300);
            }, 5000);
        }
    }

    /**
     * Показ уведомления о возможности запуска
     */
    showLaunchNotification() {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 70px;
            right: 20px;
            padding: 16px 20px;
            background: #e3f2fd;
            color: #1976d2;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 999;
            max-width: 300px;
        `;

        notification.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 8px;">📞 Телефония доступна</div>
            <div style="font-size: 13px; margin-bottom: 12px;">
                Хотите запустить телефонный клиент?
            </div>
            <div style="display: flex; gap: 8px;">
                <button onclick="telephonyLauncher.launchTelephony()" style="
                    padding: 6px 12px;
                    background: #1976d2;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                ">Запустить</button>
                <button onclick="this.closest('div').remove()" style="
                    padding: 6px 12px;
                    background: #f5f5f5;
                    color: #333;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                ">Позже</button>
            </div>
        `;

        document.body.appendChild(notification);

        // Автоскрытие через 15 секунд
        setTimeout(() => {
            notification.remove();
        }, 15000);
    }

    /**
     * Показ уведомления о необходимости настройки
     */
    showSetupNotification() {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 70px;
            right: 20px;
            padding: 16px 20px;
            background: #fff3cd;
            color: #856404;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 999;
            max-width: 300px;
        `;

        notification.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 8px;">⚠️ Настройте телефонию</div>
            <div style="font-size: 13px; margin-bottom: 12px;">
                У вас нет SIP учетных данных. Обратитесь к администратору.
            </div>
            <button onclick="window.location.href='/admin-panel/settings.html'" style="
                padding: 6px 12px;
                background: #ffc107;
                color: #000;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
            ">Настройки</button>
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.remove();
        }, 10000);
    }

    /**
     * Показ панели звонков
     */
    showTelephonyPanel() {
        // Открываем в новом окне или встраиваем
        window.open('/admin-panel/calls.html', 'telephony', 'width=400,height=600');
    }

    /**
     * Включить автозапуск
     */
    enableAutoLaunch() {
        localStorage.setItem('telephony_autolaunch', 'true');
        this.autoLaunchEnabled = true;
        console.log('✅ Auto-launch enabled');
    }

    /**
     * Отключить автозапуск
     */
    disableAutoLaunch() {
        localStorage.setItem('telephony_autolaunch', 'false');
        this.autoLaunchEnabled = false;
        console.log('⏸️ Auto-launch disabled');
    }

    /**
     * Получить статус автозапуска
     */
    isAutoLaunchEnabled() {
        return this.autoLaunchEnabled;
    }
}

// Глобальная инициализация
const telephonyLauncher = new TelephonyAutoLauncher();

// Автозапуск при загрузке страницы
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        telephonyLauncher.init();
    });
} else {
    telephonyLauncher.init();
}

// Экспорт для глобального использования
window.telephonyLauncher = telephonyLauncher;
