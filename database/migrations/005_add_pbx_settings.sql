-- Add PBX settings to restaurant table
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pbx_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pbx_server VARCHAR(255);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pbx_port INTEGER DEFAULT 5060;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pbx_transport VARCHAR(10) DEFAULT 'UDP';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pbx_rtp_port_min INTEGER DEFAULT 5700;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pbx_rtp_port_max INTEGER DEFAULT 5750;

-- Add PBX credentials to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS pbx_extension VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pbx_username VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pbx_password VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pbx_display_name VARCHAR(100);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_pbx_extension ON users(pbx_extension) WHERE pbx_extension IS NOT NULL;

COMMENT ON COLUMN restaurants.pbx_enabled IS 'Включена ли телефония PJSIP для предприятия';
COMMENT ON COLUMN restaurants.pbx_server IS 'Адрес SIP сервера (например sip.example.com)';
COMMENT ON COLUMN restaurants.pbx_port IS 'Порт SIP сервера (по умолчанию 5060)';
COMMENT ON COLUMN restaurants.pbx_transport IS 'Протокол: UDP, TCP или TLS';
COMMENT ON COLUMN users.pbx_extension IS 'Внутренний номер оператора (например 1001)';
COMMENT ON COLUMN users.pbx_username IS 'Логин АТС для SIP подключения';
COMMENT ON COLUMN users.pbx_password IS 'Пароль АТС для SIP подключения';
COMMENT ON COLUMN users.pbx_display_name IS 'Отображаемое имя в телефонии';
