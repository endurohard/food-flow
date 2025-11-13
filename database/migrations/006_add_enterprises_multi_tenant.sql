-- Migration: Add Multi-Tenant Support with Enterprises
-- Description: Adds enterprises table and enterprise_id to all relevant tables
-- Date: 2025-11-14

-- Create enterprises table
CREATE TABLE IF NOT EXISTS enterprises (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    legal_name VARCHAR(255),
    tax_id VARCHAR(50),
    phone VARCHAR(20),
    email VARCHAR(255),
    website VARCHAR(255),
    logo_url VARCHAR(500),

    -- Subscription and billing
    subscription_plan VARCHAR(50) DEFAULT 'basic', -- basic, pro, enterprise
    subscription_status VARCHAR(50) DEFAULT 'active', -- active, suspended, cancelled
    subscription_start_date TIMESTAMP WITH TIME ZONE,
    subscription_end_date TIMESTAMP WITH TIME ZONE,

    -- Settings
    currency VARCHAR(3) DEFAULT 'RUB',
    timezone VARCHAR(50) DEFAULT 'Europe/Moscow',
    language VARCHAR(10) DEFAULT 'ru',

    -- Features enabled
    features JSONB DEFAULT '{"pos": true, "delivery": true, "inventory": true, "analytics": true}'::jsonb,

    -- Status
    is_active BOOLEAN DEFAULT true,
    is_demo BOOLEAN DEFAULT false,

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create enterprise addresses
CREATE TABLE IF NOT EXISTS enterprise_addresses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID REFERENCES enterprises(id) ON DELETE CASCADE,
    address_type VARCHAR(50) DEFAULT 'main', -- main, billing, warehouse
    street_address VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100) NOT NULL DEFAULT 'Russia',
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add enterprise_id to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS enterprise_id UUID REFERENCES enterprises(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_enterprise_admin BOOLEAN DEFAULT false;

-- Add enterprise_id to restaurants table
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS enterprise_id UUID REFERENCES enterprises(id) ON DELETE CASCADE;

-- Add enterprise_id to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS enterprise_id UUID REFERENCES enterprises(id) ON DELETE CASCADE;

-- Create enterprise_users junction table for multi-enterprise access
CREATE TABLE IF NOT EXISTS enterprise_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID REFERENCES enterprises(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) DEFAULT 'employee', -- owner, admin, manager, employee, viewer
    permissions JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT true,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(enterprise_id, user_id)
);

-- Add enterprise_id to menu_categories
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS enterprise_id UUID REFERENCES enterprises(id) ON DELETE CASCADE;

-- Add enterprise_id to menu_items
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS enterprise_id UUID REFERENCES enterprises(id) ON DELETE CASCADE;

-- Create indexes for enterprise_id on all tables
CREATE INDEX IF NOT EXISTS idx_users_enterprise_id ON users(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_enterprise_id ON restaurants(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_orders_enterprise_id ON orders(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_menu_categories_enterprise_id ON menu_categories(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_enterprise_id ON menu_items(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_users_enterprise_id ON enterprise_users(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_users_user_id ON enterprise_users(user_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_addresses_enterprise_id ON enterprise_addresses(enterprise_id);

-- Create trigger for enterprises updated_at
CREATE TRIGGER update_enterprises_updated_at
    BEFORE UPDATE ON enterprises
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_enterprise_addresses_updated_at
    BEFORE UPDATE ON enterprise_addresses
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create function to get user enterprises
CREATE OR REPLACE FUNCTION get_user_enterprises(p_user_id UUID)
RETURNS TABLE (
    enterprise_id UUID,
    enterprise_name VARCHAR,
    user_role VARCHAR,
    is_active BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id,
        e.name,
        eu.role,
        eu.is_active
    FROM enterprises e
    INNER JOIN enterprise_users eu ON e.id = eu.enterprise_id
    WHERE eu.user_id = p_user_id
    AND e.is_active = true
    AND eu.is_active = true
    ORDER BY eu.joined_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Create function to check enterprise access
CREATE OR REPLACE FUNCTION check_enterprise_access(p_user_id UUID, p_enterprise_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    has_access BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM enterprise_users eu
        WHERE eu.user_id = p_user_id
        AND eu.enterprise_id = p_enterprise_id
        AND eu.is_active = true
    ) INTO has_access;

    RETURN has_access;
END;
$$ LANGUAGE plpgsql;

-- Add Row Level Security (RLS) policies
ALTER TABLE enterprises ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see enterprises they belong to
CREATE POLICY enterprise_isolation_policy ON enterprises
    FOR ALL
    USING (
        id IN (
            SELECT enterprise_id
            FROM enterprise_users
            WHERE user_id = current_setting('app.current_user_id')::UUID
            AND is_active = true
        )
    );

-- RLS Policy: Restaurants isolation by enterprise
CREATE POLICY restaurant_enterprise_isolation ON restaurants
    FOR ALL
    USING (
        enterprise_id IN (
            SELECT enterprise_id
            FROM enterprise_users
            WHERE user_id = current_setting('app.current_user_id')::UUID
            AND is_active = true
        )
    );

-- RLS Policy: Menu categories isolation
CREATE POLICY menu_categories_enterprise_isolation ON menu_categories
    FOR ALL
    USING (
        enterprise_id IN (
            SELECT enterprise_id
            FROM enterprise_users
            WHERE user_id = current_setting('app.current_user_id')::UUID
            AND is_active = true
        )
    );

-- RLS Policy: Menu items isolation
CREATE POLICY menu_items_enterprise_isolation ON menu_items
    FOR ALL
    USING (
        enterprise_id IN (
            SELECT enterprise_id
            FROM enterprise_users
            WHERE user_id = current_setting('app.current_user_id')::UUID
            AND is_active = true
        )
    );

-- RLS Policy: Orders isolation
CREATE POLICY orders_enterprise_isolation ON orders
    FOR ALL
    USING (
        enterprise_id IN (
            SELECT enterprise_id
            FROM enterprise_users
            WHERE user_id = current_setting('app.current_user_id')::UUID
            AND is_active = true
        )
    );

-- Insert demo enterprises for testing
INSERT INTO enterprises (name, legal_name, email, subscription_plan, is_demo)
VALUES
    ('Demo Restaurant Group', 'ООО "Демо Ресторан"', 'demo@foodflow.ru', 'pro', true),
    ('Test Cafe Chain', 'ООО "Тест Кафе"', 'test@foodflow.ru', 'basic', true)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE enterprises IS 'Multi-tenant enterprises/companies table';
COMMENT ON TABLE enterprise_users IS 'Junction table for user-enterprise relationships with roles';
COMMENT ON COLUMN users.enterprise_id IS 'Primary enterprise for the user (legacy compatibility)';
COMMENT ON COLUMN users.is_enterprise_admin IS 'Whether user is admin of their primary enterprise';
