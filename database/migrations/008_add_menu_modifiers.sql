-- Migration: Add menu item modifiers and extend menu_items
-- Phase 2: Restaurants and Menu

-- Menu item modifiers (sizes, toppings, extras)
CREATE TABLE IF NOT EXISTS menu_item_modifiers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    menu_item_id UUID REFERENCES menu_items(id) ON DELETE CASCADE,
    enterprise_id UUID REFERENCES enterprises(id),
    name VARCHAR(100) NOT NULL,
    modifier_group VARCHAR(100),
    price_adjustment DECIMAL(10, 2) DEFAULT 0,
    is_default BOOLEAN DEFAULT false,
    is_available BOOLEAN DEFAULT true,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_menu_item_modifiers_item ON menu_item_modifiers(menu_item_id);
CREATE INDEX idx_menu_item_modifiers_enterprise ON menu_item_modifiers(enterprise_id);

-- Extend menu_items with POS-relevant columns
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sku VARCHAR(50);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10, 2);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5, 2) DEFAULT 0;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS unit VARCHAR(20) DEFAULT 'piece';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS weight_grams INTEGER;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS enterprise_id UUID REFERENCES enterprises(id);

-- Add enterprise_id to menu_categories if not present
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS enterprise_id UUID REFERENCES enterprises(id);

-- Add updated_at trigger for modifiers
CREATE TRIGGER update_menu_item_modifiers_updated_at
    BEFORE UPDATE ON menu_item_modifiers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
