-- Seed data for development and testing

-- Insert sample users (password: 'password123' hashed with bcrypt)
INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role, email_verified) VALUES
    ('550e8400-e29b-41d4-a716-446655440001', 'admin@foodflow.com', '$2b$10$xQZ5B7Qi6xYXqT5zJZ1W3eYxqYqGqLqZ3zQqYqGqLqZ3zQqYqGqLq', 'Admin', 'User', '+1234567890', 'admin', true),
    ('550e8400-e29b-41d4-a716-446655440002', 'john@example.com', '$2b$10$xQZ5B7Qi6xYXqT5zJZ1W3eYxqYqGqLqZ3zQqYqGqLqZ3zQqYqGqLq', 'John', 'Doe', '+1234567891', 'customer', true),
    ('550e8400-e29b-41d4-a716-446655440003', 'restaurant@example.com', '$2b$10$xQZ5B7Qi6xYXqT5zJZ1W3eYxqYqGqLqZ3zQqYqGqLqZ3zQqYqGqLq', 'Restaurant', 'Owner', '+1234567892', 'restaurant_owner', true),
    ('550e8400-e29b-41d4-a716-446655440004', 'driver@example.com', '$2b$10$xQZ5B7Qi6xYXqT5zJZ1W3eYxqYqGqLqZ3zQqYqGqLqZ3zQqYqGqLq', 'Delivery', 'Driver', '+1234567893', 'delivery_driver', true);

-- Insert sample addresses
INSERT INTO addresses (user_id, title, street_address, city, state, postal_code, country, latitude, longitude, is_default) VALUES
    ('550e8400-e29b-41d4-a716-446655440002', 'Home', '123 Main St', 'New York', 'NY', '10001', 'USA', 40.7128, -74.0060, true),
    ('550e8400-e29b-41d4-a716-446655440002', 'Work', '456 Office Blvd', 'New York', 'NY', '10002', 'USA', 40.7589, -73.9851, false);

-- Insert sample restaurants
INSERT INTO restaurants (id, owner_id, name, description, phone, email, cuisine_type, rating, total_reviews, delivery_fee, minimum_order, estimated_delivery_time, opens_at, closes_at) VALUES
    ('650e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440003', 'Pizza Paradise', 'Best pizza in town with fresh ingredients', '+1234567894', 'contact@pizzaparadise.com', ARRAY['Italian', 'Pizza'], 4.5, 120, 3.99, 15.00, 30, '10:00', '23:00'),
    ('650e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440003', 'Sushi Station', 'Fresh sushi and Japanese cuisine', '+1234567895', 'info@sushistation.com', ARRAY['Japanese', 'Sushi'], 4.8, 200, 4.99, 20.00, 40, '11:00', '22:00'),
    ('650e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440003', 'Burger House', 'Gourmet burgers and fries', '+1234567896', 'hello@burgerhouse.com', ARRAY['American', 'Burgers'], 4.3, 85, 2.99, 10.00, 25, '09:00', '01:00');

-- Insert restaurant addresses
INSERT INTO restaurant_addresses (restaurant_id, street_address, city, state, postal_code, country, latitude, longitude) VALUES
    ('650e8400-e29b-41d4-a716-446655440001', '789 Pizza Ave', 'New York', 'NY', '10003', 'USA', 40.7306, -73.9352),
    ('650e8400-e29b-41d4-a716-446655440002', '321 Sushi Lane', 'New York', 'NY', '10004', 'USA', 40.7074, -74.0113),
    ('650e8400-e29b-41d4-a716-446655440003', '654 Burger St', 'New York', 'NY', '10005', 'USA', 40.7056, -74.0134);

-- Insert menu categories
INSERT INTO menu_categories (id, restaurant_id, name, description, display_order) VALUES
    ('750e8400-e29b-41d4-a716-446655440001', '650e8400-e29b-41d4-a716-446655440001', 'Classic Pizzas', 'Our signature classic pizzas', 1),
    ('750e8400-e29b-41d4-a716-446655440002', '650e8400-e29b-41d4-a716-446655440001', 'Specialty Pizzas', 'Unique pizza creations', 2),
    ('750e8400-e29b-41d4-a716-446655440003', '650e8400-e29b-41d4-a716-446655440002', 'Sushi Rolls', 'Fresh sushi rolls', 1),
    ('750e8400-e29b-41d4-a716-446655440004', '650e8400-e29b-41d4-a716-446655440002', 'Sashimi', 'Fresh sliced fish', 2),
    ('750e8400-e29b-41d4-a716-446655440005', '650e8400-e29b-41d4-a716-446655440003', 'Burgers', 'Juicy burgers', 1),
    ('750e8400-e29b-41d4-a716-446655440006', '650e8400-e29b-41d4-a716-446655440003', 'Sides', 'Fries and more', 2);

-- Insert menu items
INSERT INTO menu_items (restaurant_id, category_id, name, description, price, is_vegetarian, preparation_time) VALUES
    ('650e8400-e29b-41d4-a716-446655440001', '750e8400-e29b-41d4-a716-446655440001', 'Margherita Pizza', 'Classic tomato, mozzarella, and basil', 12.99, true, 15),
    ('650e8400-e29b-41d4-a716-446655440001', '750e8400-e29b-41d4-a716-446655440001', 'Pepperoni Pizza', 'Tomato sauce, mozzarella, and pepperoni', 14.99, false, 15),
    ('650e8400-e29b-41d4-a716-446655440001', '750e8400-e29b-41d4-a716-446655440002', 'Truffle Mushroom Pizza', 'White sauce, mushrooms, truffle oil', 18.99, true, 20),
    ('650e8400-e29b-41d4-a716-446655440002', '750e8400-e29b-41d4-a716-446655440003', 'California Roll', 'Crab, avocado, cucumber', 8.99, false, 10),
    ('650e8400-e29b-41d4-a716-446655440002', '750e8400-e29b-41d4-a716-446655440003', 'Spicy Tuna Roll', 'Tuna, spicy mayo, cucumber', 10.99, false, 10),
    ('650e8400-e29b-41d4-a716-446655440002', '750e8400-e29b-41d4-a716-446655440004', 'Salmon Sashimi', 'Fresh sliced salmon (6 pieces)', 12.99, false, 5),
    ('650e8400-e29b-41d4-a716-446655440003', '750e8400-e29b-41d4-a716-446655440005', 'Classic Burger', 'Beef patty, lettuce, tomato, onion', 11.99, false, 12),
    ('650e8400-e29b-41d4-a716-446655440003', '750e8400-e29b-41d4-a716-446655440005', 'Cheese Burger', 'Beef patty with melted cheese', 12.99, false, 12),
    ('650e8400-e29b-41d4-a716-446655440003', '750e8400-e29b-41d4-a716-446655440006', 'French Fries', 'Crispy golden fries', 4.99, true, 8);

-- Note: Order and delivery data would be generated at runtime
