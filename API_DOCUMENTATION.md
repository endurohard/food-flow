# Food Flow API Documentation

Complete API reference for the Food Flow platform.

## Base URLs

- **Development**: `http://localhost:8000/api`
- **Services Direct Access**:
  - User Service: `http://localhost:3001/api`
  - Restaurant Service: `http://localhost:3002/api`
  - Order Service: `http://localhost:3003/api`
  - Delivery Service: `http://localhost:3004/api`

## Authentication

Most endpoints require JWT authentication. Include the token in the Authorization header:

```
Authorization: Bearer <your_jwt_token>
```

## User Service API

### Authentication Endpoints

#### Register User

```http
POST /api/auth/register
```

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "firstName": "John",
  "lastName": "Doe",
  "phone": "+1234567890",
  "role": "customer"
}
```

**Response:** `201 Created`
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "role": "customer"
  }
}
```

#### Login

```http
POST /api/auth/login
```

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:** `200 OK`
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "role": "customer"
  }
}
```

#### Refresh Token

```http
POST /api/auth/refresh
Authorization: Bearer <token>
```

**Response:** `200 OK`
```json
{
  "token": "new_jwt_token"
}
```

#### Logout

```http
POST /api/auth/logout
Authorization: Bearer <token>
```

**Response:** `200 OK`

### User Profile Endpoints

#### Get Profile

```http
GET /api/users/profile
Authorization: Bearer <token>
```

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "firstName": "John",
  "lastName": "Doe",
  "phone": "+1234567890",
  "role": "customer",
  "isActive": true,
  "emailVerified": true,
  "createdAt": "2024-01-01T00:00:00Z"
}
```

#### Update Profile

```http
PUT /api/users/profile
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "phone": "+1987654321"
}
```

**Response:** `200 OK`

#### Get Addresses

```http
GET /api/users/addresses
Authorization: Bearer <token>
```

**Response:** `200 OK`
```json
[
  {
    "id": "uuid",
    "title": "Home",
    "streetAddress": "123 Main St",
    "city": "New York",
    "state": "NY",
    "postalCode": "10001",
    "country": "USA",
    "isDefault": true
  }
]
```

#### Add Address

```http
POST /api/users/addresses
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "title": "Work",
  "streetAddress": "456 Office Blvd",
  "city": "New York",
  "state": "NY",
  "postalCode": "10002",
  "country": "USA",
  "isDefault": false
}
```

**Response:** `201 Created`

## Restaurant Service API

### Restaurant Endpoints

#### List Restaurants

```http
GET /api/restaurants?city=New York&cuisine=Italian&page=1&limit=20
```

**Query Parameters:**
- `city` (optional): Filter by city
- `cuisine` (optional): Filter by cuisine type
- `rating` (optional): Minimum rating
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20)

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Pizza Paradise",
      "description": "Best pizza in town",
      "cuisineType": ["Italian", "Pizza"],
      "rating": 4.5,
      "totalReviews": 120,
      "deliveryFee": 3.99,
      "minimumOrder": 15.00,
      "estimatedDeliveryTime": 30,
      "address": {
        "streetAddress": "789 Pizza Ave",
        "city": "New York"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50
  }
}
```

#### Get Restaurant Details

```http
GET /api/restaurants/:id
```

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "name": "Pizza Paradise",
  "description": "Best pizza in town with fresh ingredients",
  "phone": "+1234567894",
  "email": "contact@pizzaparadise.com",
  "cuisineType": ["Italian", "Pizza"],
  "rating": 4.5,
  "totalReviews": 120,
  "deliveryFee": 3.99,
  "minimumOrder": 15.00,
  "estimatedDeliveryTime": 30,
  "opensAt": "10:00",
  "closesAt": "23:00",
  "isActive": true,
  "address": {
    "streetAddress": "789 Pizza Ave",
    "city": "New York",
    "state": "NY"
  }
}
```

#### Create Restaurant (Restaurant Owner)

```http
POST /api/restaurants
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "name": "New Restaurant",
  "description": "Description",
  "phone": "+1234567890",
  "email": "restaurant@example.com",
  "cuisineType": ["Italian"],
  "deliveryFee": 4.99,
  "minimumOrder": 20.00,
  "estimatedDeliveryTime": 35,
  "opensAt": "11:00",
  "closesAt": "22:00",
  "address": {
    "streetAddress": "123 Restaurant St",
    "city": "New York",
    "state": "NY",
    "postalCode": "10001",
    "country": "USA"
  }
}
```

**Response:** `201 Created`

### Menu Endpoints

#### Get Restaurant Menu

```http
GET /api/restaurants/:restaurantId/menu
```

**Response:** `200 OK`
```json
{
  "categories": [
    {
      "id": "uuid",
      "name": "Classic Pizzas",
      "description": "Our signature pizzas",
      "items": [
        {
          "id": "uuid",
          "name": "Margherita Pizza",
          "description": "Classic tomato, mozzarella, and basil",
          "price": 12.99,
          "imageUrl": "https://...",
          "isAvailable": true,
          "isVegetarian": true,
          "preparationTime": 15
        }
      ]
    }
  ]
}
```

#### Create Menu Category (Restaurant Owner)

```http
POST /api/menus/categories
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "restaurantId": "uuid",
  "name": "Appetizers",
  "description": "Start your meal",
  "displayOrder": 1
}
```

**Response:** `201 Created`

#### Create Menu Item (Restaurant Owner)

```http
POST /api/menus/items
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "restaurantId": "uuid",
  "categoryId": "uuid",
  "name": "Garlic Bread",
  "description": "Fresh baked with garlic butter",
  "price": 5.99,
  "isVegetarian": true,
  "preparationTime": 10
}
```

**Response:** `201 Created`

## Order Service API

### Cart Endpoints

#### Get Cart

```http
GET /api/cart
Authorization: Bearer <token>
```

**Response:** `200 OK`
```json
{
  "items": [
    {
      "id": "uuid",
      "menuItem": {
        "id": "uuid",
        "name": "Margherita Pizza",
        "price": 12.99
      },
      "quantity": 2,
      "subtotal": 25.98
    }
  ],
  "subtotal": 25.98,
  "deliveryFee": 3.99,
  "tax": 2.40,
  "total": 32.37
}
```

#### Add to Cart

```http
POST /api/cart/items
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "menuItemId": "uuid",
  "quantity": 2,
  "specialInstructions": "Extra cheese"
}
```

**Response:** `201 Created`

#### Remove from Cart

```http
DELETE /api/cart/items/:itemId
Authorization: Bearer <token>
```

**Response:** `204 No Content`

### Order Endpoints

#### Create Order

```http
POST /api/orders
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "restaurantId": "uuid",
  "deliveryAddressId": "uuid",
  "items": [
    {
      "menuItemId": "uuid",
      "quantity": 2,
      "specialInstructions": "Extra cheese"
    }
  ],
  "paymentMethod": "credit_card",
  "specialInstructions": "Ring doorbell"
}
```

**Response:** `201 Created`
```json
{
  "id": "uuid",
  "orderNumber": "ORD-12345",
  "status": "pending",
  "subtotal": 25.98,
  "deliveryFee": 3.99,
  "tax": 2.40,
  "total": 32.37,
  "estimatedDeliveryTime": "2024-01-01T13:30:00Z"
}
```

#### Get Order History

```http
GET /api/orders?status=delivered&page=1&limit=10
Authorization: Bearer <token>
```

**Query Parameters:**
- `status` (optional): Filter by status
- `page` (optional): Page number
- `limit` (optional): Items per page

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "uuid",
      "orderNumber": "ORD-12345",
      "restaurant": {
        "id": "uuid",
        "name": "Pizza Paradise"
      },
      "status": "delivered",
      "total": 32.37,
      "createdAt": "2024-01-01T12:00:00Z",
      "deliveredAt": "2024-01-01T12:45:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25
  }
}
```

#### Get Order Details

```http
GET /api/orders/:id
Authorization: Bearer <token>
```

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "orderNumber": "ORD-12345",
  "status": "delivered",
  "restaurant": {
    "id": "uuid",
    "name": "Pizza Paradise",
    "phone": "+1234567894"
  },
  "items": [
    {
      "name": "Margherita Pizza",
      "quantity": 2,
      "unitPrice": 12.99,
      "subtotal": 25.98
    }
  ],
  "subtotal": 25.98,
  "deliveryFee": 3.99,
  "tax": 2.40,
  "total": 32.37,
  "deliveryAddress": {
    "streetAddress": "123 Main St",
    "city": "New York"
  },
  "paymentMethod": "credit_card",
  "paymentStatus": "completed",
  "createdAt": "2024-01-01T12:00:00Z",
  "confirmedAt": "2024-01-01T12:05:00Z",
  "deliveredAt": "2024-01-01T12:45:00Z"
}
```

#### Update Order Status (Restaurant/Admin)

```http
PUT /api/orders/:id/status
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "status": "confirmed"
}
```

**Valid Status Transitions:**
- `pending` → `confirmed` (restaurant)
- `confirmed` → `preparing` (restaurant)
- `preparing` → `ready` (restaurant)
- `ready` → `picked_up` (driver)
- `picked_up` → `delivering` (driver)
- `delivering` → `delivered` (driver)
- Any → `cancelled` (customer/restaurant)

**Response:** `200 OK`

## Delivery Service API

### Delivery Endpoints

#### Get Deliveries (Driver)

```http
GET /api/deliveries?status=assigned
Authorization: Bearer <token>
```

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "uuid",
      "order": {
        "id": "uuid",
        "orderNumber": "ORD-12345"
      },
      "status": "assigned",
      "pickupAddress": "789 Pizza Ave",
      "deliveryAddress": "123 Main St",
      "distance": 3.5,
      "assignedAt": "2024-01-01T12:30:00Z"
    }
  ]
}
```

#### Get Delivery Details

```http
GET /api/deliveries/:id
Authorization: Bearer <token>
```

**Response:** `200 OK`

#### Update Delivery Status (Driver)

```http
PUT /api/deliveries/:id/status
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "status": "picked_up"
}
```

**Response:** `200 OK`

#### Update Location (Driver)

```http
PUT /api/deliveries/:id/location
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "latitude": 40.7128,
  "longitude": -74.0060
}
```

**Response:** `200 OK`

### Tracking Endpoints

#### Track Order (Customer)

```http
GET /api/tracking/:orderId
Authorization: Bearer <token>
```

**Response:** `200 OK`
```json
{
  "order": {
    "id": "uuid",
    "orderNumber": "ORD-12345",
    "status": "delivering"
  },
  "delivery": {
    "status": "in_transit",
    "driver": {
      "firstName": "John",
      "phone": "+1234567893"
    },
    "currentLocation": {
      "latitude": 40.7128,
      "longitude": -74.0060
    },
    "estimatedArrival": "2024-01-01T12:45:00Z"
  }
}
```

### WebSocket Events

Connect to delivery tracking:

```javascript
const socket = io('http://localhost:3004');

// Authenticate
socket.emit('authenticate', { token: 'jwt_token' });

// Subscribe to order tracking
socket.emit('subscribe_order', { orderId: 'order_uuid' });

// Listen for updates
socket.on('location_update', (data) => {
  console.log('New location:', data);
});

socket.on('status_change', (data) => {
  console.log('Status changed:', data);
});
```

## Error Responses

All endpoints may return these error responses:

### 400 Bad Request
```json
{
  "error": "Bad Request",
  "message": "Invalid input data",
  "details": {
    "email": "Invalid email format"
  }
}
```

### 401 Unauthorized
```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing authentication token"
}
```

### 403 Forbidden
```json
{
  "error": "Forbidden",
  "message": "You don't have permission to access this resource"
}
```

### 404 Not Found
```json
{
  "error": "Not Found",
  "message": "Resource not found"
}
```

### 429 Too Many Requests
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again later."
}
```

### 500 Internal Server Error
```json
{
  "error": "Internal Server Error",
  "message": "Something went wrong"
}
```

## Rate Limiting

API requests are rate limited:
- **Per User**: 100 requests per minute
- **Per IP**: 1000 requests per hour

Rate limit headers included in responses:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000
```

## Interactive API Documentation

Access Swagger UI for interactive API testing:

- User Service: http://localhost:3001/api-docs
- Restaurant Service: http://localhost:3002/api-docs
- Order Service: http://localhost:3003/api-docs
- Delivery Service: http://localhost:3004/api-docs

## Postman Collection

Import the API collection for easy testing:

```bash
# Coming soon
```

## SDK Examples

### JavaScript/Node.js

```javascript
const axios = require('axios');

const api = axios.create({
  baseURL: 'http://localhost:8000/api',
  headers: {
    'Content-Type': 'application/json'
  }
});

// Login
const { data } = await api.post('/auth/login', {
  email: 'user@example.com',
  password: 'password123'
});

// Set token for future requests
api.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;

// Get restaurants
const restaurants = await api.get('/restaurants');
```

### Python

```python
import requests

BASE_URL = 'http://localhost:8000/api'

# Login
response = requests.post(f'{BASE_URL}/auth/login', json={
    'email': 'user@example.com',
    'password': 'password123'
})

token = response.json()['token']
headers = {'Authorization': f'Bearer {token}'}

# Get restaurants
restaurants = requests.get(f'{BASE_URL}/restaurants', headers=headers)
```

### cURL

```bash
# Login
TOKEN=$(curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}' \
  | jq -r '.token')

# Get restaurants
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/restaurants
```
