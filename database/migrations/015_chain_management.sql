-- Migration: Chain management (multi-restaurant)
-- Phase 9: Enterprise/Chain Management

-- Enterprise-level menu templates
CREATE TABLE IF NOT EXISTS enterprise_menu_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    template_data JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_enterprise_menu_templates_enterprise ON enterprise_menu_templates(enterprise_id);

-- Restaurant performance benchmarks (daily snapshots)
CREATE TABLE IF NOT EXISTS restaurant_benchmarks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    enterprise_id UUID REFERENCES enterprises(id),
    period_date DATE NOT NULL,
    revenue DECIMAL(12, 2) DEFAULT 0,
    order_count INTEGER DEFAULT 0,
    average_check DECIMAL(10, 2) DEFAULT 0,
    food_cost_percent DECIMAL(5, 2) DEFAULT 0,
    labor_cost_percent DECIMAL(5, 2) DEFAULT 0,
    customer_satisfaction DECIMAL(3, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(restaurant_id, period_date)
);

CREATE INDEX idx_restaurant_benchmarks_enterprise ON restaurant_benchmarks(enterprise_id);
CREATE INDEX idx_restaurant_benchmarks_date ON restaurant_benchmarks(period_date);

CREATE TRIGGER update_enterprise_menu_templates_updated_at
    BEFORE UPDATE ON enterprise_menu_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
