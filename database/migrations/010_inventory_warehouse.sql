-- Migration: Inventory and Warehouse management
-- Phase 4: Inventory and Procurement

-- Warehouses
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    enterprise_id UUID REFERENCES enterprises(id),
    name VARCHAR(100) NOT NULL,
    warehouse_type VARCHAR(50) DEFAULT 'main',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_warehouses_restaurant ON warehouses(restaurant_id);

-- Inventory items (ingredients, supplies)
CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID REFERENCES enterprises(id),
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(50),
    category VARCHAR(100),
    unit VARCHAR(20) NOT NULL,
    min_stock DECIMAL(10, 3) DEFAULT 0,
    max_stock DECIMAL(10, 3),
    cost_price DECIMAL(10, 2) DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_items_enterprise ON inventory_items(enterprise_id);
CREATE INDEX idx_inventory_items_category ON inventory_items(category);

-- Current stock levels per warehouse
CREATE TABLE IF NOT EXISTS inventory_stock (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity DECIMAL(10, 3) NOT NULL DEFAULT 0,
    last_counted_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, inventory_item_id)
);

CREATE INDEX idx_inventory_stock_warehouse ON inventory_stock(warehouse_id);
CREATE INDEX idx_inventory_stock_item ON inventory_stock(inventory_item_id);

-- Stock movements (receipts, write-offs, transfers, sales)
CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID REFERENCES enterprises(id),
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id),
    movement_type VARCHAR(30) NOT NULL,
    quantity DECIMAL(10, 3) NOT NULL,
    cost_price DECIMAL(10, 2),
    reference_type VARCHAR(30),
    reference_id UUID,
    performed_by UUID REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stock_movements_warehouse ON stock_movements(warehouse_id);
CREATE INDEX idx_stock_movements_item ON stock_movements(inventory_item_id);
CREATE INDEX idx_stock_movements_date ON stock_movements(created_at);
CREATE INDEX idx_stock_movements_type ON stock_movements(movement_type);

-- Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID REFERENCES enterprises(id),
    name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(100),
    phone VARCHAR(20),
    email VARCHAR(255),
    tax_id VARCHAR(50),
    address TEXT,
    payment_terms VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_suppliers_enterprise ON suppliers(enterprise_id);

-- Supply invoices
CREATE TABLE IF NOT EXISTS supply_invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID REFERENCES enterprises(id),
    warehouse_id UUID REFERENCES warehouses(id),
    supplier_id UUID REFERENCES suppliers(id),
    invoice_number VARCHAR(100),
    invoice_date DATE,
    total_amount DECIMAL(12, 2),
    currency VARCHAR(3) DEFAULT 'RUB',
    status VARCHAR(20) DEFAULT 'draft',
    photo_url VARCHAR(500),
    ocr_text TEXT,
    telegram_user_id BIGINT,
    notes TEXT,
    received_by UUID REFERENCES users(id),
    received_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_supply_invoices_enterprise ON supply_invoices(enterprise_id);
CREATE INDEX idx_supply_invoices_supplier ON supply_invoices(supplier_id);
CREATE INDEX idx_supply_invoices_status ON supply_invoices(status);

-- Supply invoice line items
CREATE TABLE IF NOT EXISTS supply_invoice_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES supply_invoices(id) ON DELETE CASCADE,
    inventory_item_id UUID REFERENCES inventory_items(id),
    name VARCHAR(255) NOT NULL,
    quantity DECIMAL(10, 3) NOT NULL,
    unit VARCHAR(20),
    price_per_unit DECIMAL(10, 2),
    total_price DECIMAL(10, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_supply_invoice_items_invoice ON supply_invoice_items(invoice_id);

-- Tech cards (recipes - maps menu items to inventory items)
CREATE TABLE IF NOT EXISTS tech_cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    enterprise_id UUID REFERENCES enterprises(id),
    yield_weight DECIMAL(10, 3),
    cooking_instructions TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tech_cards_menu_item ON tech_cards(menu_item_id);

-- Tech card ingredients
CREATE TABLE IF NOT EXISTS tech_card_ingredients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tech_card_id UUID NOT NULL REFERENCES tech_cards(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id),
    quantity DECIMAL(10, 3) NOT NULL,
    unit VARCHAR(20),
    waste_percent DECIMAL(5, 2) DEFAULT 0,
    is_optional BOOLEAN DEFAULT false
);

CREATE INDEX idx_tech_card_ingredients_card ON tech_card_ingredients(tech_card_id);

-- Triggers
CREATE TRIGGER update_warehouses_updated_at BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_inventory_items_updated_at BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_inventory_stock_updated_at BEFORE UPDATE ON inventory_stock FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_suppliers_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_supply_invoices_updated_at BEFORE UPDATE ON supply_invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tech_cards_updated_at BEFORE UPDATE ON tech_cards FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
