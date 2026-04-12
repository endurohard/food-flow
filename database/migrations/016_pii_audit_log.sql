-- Migration 016: PII Access Audit Log (ФЗ-152 compliance)
-- Tracks access to personal data fields (phone, email, etc.)

CREATE TABLE IF NOT EXISTS pii_access_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  enterprise_id   UUID,
  accessed_entity VARCHAR(50) NOT NULL,
  accessed_id     UUID,
  fields_accessed TEXT[] NOT NULL,
  action          VARCHAR(20) NOT NULL DEFAULT 'read',
  ip_address      VARCHAR(45),
  request_id      VARCHAR(255),
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pii_access_log_user
  ON pii_access_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pii_access_log_entity
  ON pii_access_log(accessed_entity, accessed_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pii_access_log_enterprise
  ON pii_access_log(enterprise_id, created_at DESC);

COMMENT ON TABLE pii_access_log IS 'ФЗ-152: журнал доступа к персональным данным';
