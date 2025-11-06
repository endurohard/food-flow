# Food Flow - Quick Start Guide

Get up and running with Food Flow in 5 minutes!

## Prerequisites

Make sure you have installed:
- ✅ Docker (version 20.10+)
- ✅ Docker Compose (version 2.0+)
- ✅ Node.js (version 20+) - for running Kong setup script

## Step-by-Step Setup

### 1. Clone and Setup

```bash
# Clone repository
git clone <repository-url>
cd food-flow

# Copy environment file
cp .env.example .env
```

### 2. Start All Services

```bash
# Using Docker Compose
docker-compose up -d

# OR using Make (if you have make installed)
make up
```

This will start:
- PostgreSQL database with sample data
- Redis cache
- RabbitMQ message broker
- Kong API Gateway
- All 4 microservices (User, Restaurant, Order, Delivery)
- Monitoring stack (Prometheus, Grafana, Elasticsearch, Kibana)
- Nginx reverse proxy

**Note**: First startup takes 2-3 minutes to download images and initialize services.

### 3. Wait for Services to Be Ready

```bash
# Watch logs to see when services are ready
docker-compose logs -f

# Or check service health
make health
```

Wait until you see:
- ✅ "User service listening on port 3001"
- ✅ "Restaurant service listening on port 3002"
- ✅ "Order service listening on port 3003"
- ✅ "Delivery service listening on port 3004"

### 4. Configure Kong API Gateway

```bash
# Run Kong setup script
node scripts/setup-kong.js

# OR using Make
make kong-setup
```

Expected output:
```
✓ Kong is ready
✓ Service user-service created
✓ Route /api/users created
...
✓ Kong setup completed!
```

### 5. Verify Installation

Open your browser and visit:

1. **Kong Admin UI**: http://localhost:8002
2. **API Documentation**: http://localhost:3001/api-docs
3. **Grafana Dashboard**: http://localhost:3000 (admin/admin)
4. **RabbitMQ Management**: http://localhost:15672 (foodflow/foodflow_secret)

### 6. Test the API

#### Option A: Using cURL

```bash
# Test registration
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123",
    "firstName": "Test",
    "lastName": "User",
    "role": "customer"
  }'

# Test login with existing user
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "password123"
  }'
```

#### Option B: Using Swagger UI

1. Open http://localhost:3001/api-docs
2. Click "Try it out" on any endpoint
3. Fill in the parameters
4. Click "Execute"

## Default Test Credentials

The database is pre-populated with test users:

| Email | Password | Role |
|-------|----------|------|
| admin@foodflow.com | password123 | admin |
| john@example.com | password123 | customer |
| restaurant@example.com | password123 | restaurant_owner |
| driver@example.com | password123 | delivery_driver |

## Sample Test Flow

### 1. Login as Customer

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@example.com","password":"password123"}' \
  | jq -r '.token')

echo "Token: $TOKEN"
```

### 2. Get List of Restaurants

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/restaurants | jq
```

### 3. Get Restaurant Menu

```bash
# Use a restaurant ID from previous response
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/restaurants/{restaurant_id}/menu | jq
```

### 4. Add Items to Cart

```bash
curl -X POST http://localhost:8000/api/cart/items \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "menuItemId": "{menu_item_id}",
    "quantity": 2
  }'
```

### 5. Create Order

```bash
curl -X POST http://localhost:8000/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "restaurantId": "{restaurant_id}",
    "deliveryAddressId": "{address_id}",
    "items": [
      {
        "menuItemId": "{menu_item_id}",
        "quantity": 2
      }
    ],
    "paymentMethod": "credit_card"
  }'
```

## Common Commands

### Docker Compose Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f

# View logs for specific service
docker-compose logs -f user-service

# Restart service
docker-compose restart user-service

# Check status
docker-compose ps

# Clean everything (including volumes)
docker-compose down -v
```

### Make Commands (Alternative)

```bash
make up          # Start all services
make down        # Stop all services
make logs        # View logs
make restart     # Restart services
make clean       # Remove everything
make health      # Check service health
make setup       # Full setup with Kong
```

## Accessing Services

| Service | URL | Credentials |
|---------|-----|-------------|
| Frontend | http://localhost | - |
| API Gateway | http://localhost:8000 | - |
| Kong Admin | http://localhost:8001 | - |
| Kong Manager | http://localhost:8002 | - |
| Konga | http://localhost:1337 | admin/adminadminadmin |
| User Service Docs | http://localhost:3001/api-docs | - |
| Restaurant Service Docs | http://localhost:3002/api-docs | - |
| Order Service Docs | http://localhost:3003/api-docs | - |
| Delivery Service Docs | http://localhost:3004/api-docs | - |
| Prometheus | http://localhost:9090 | - |
| Grafana | http://localhost:3000 | admin/admin |
| Kibana | http://localhost:5601 | - |
| RabbitMQ | http://localhost:15672 | foodflow/foodflow_secret |
| PostgreSQL | localhost:5432 | foodflow/foodflow_secret |
| Redis | localhost:6379 | - |

## Monitoring Your System

### View Metrics in Prometheus

1. Open http://localhost:9090
2. Go to Graph tab
3. Try these queries:
   ```
   rate(http_requests_total[5m])
   http_request_duration_seconds_bucket
   ```

### Create Dashboards in Grafana

1. Open http://localhost:3000 (admin/admin)
2. Add Data Source → Prometheus (http://prometheus:9090)
3. Create New Dashboard
4. Add Panel with queries:
   - `rate(http_requests_total{service="user-service"}[5m])`
   - `http_request_duration_seconds{quantile="0.95"}`

### View Logs in Kibana

1. Open http://localhost:5601
2. Create index pattern: `logstash-*`
3. Go to Discover tab
4. Filter and search logs

## Troubleshooting

### Services Not Starting

```bash
# Check Docker
docker --version
docker-compose --version

# Check logs for errors
docker-compose logs

# Try rebuilding
docker-compose down -v
docker-compose up --build -d
```

### Kong Setup Fails

```bash
# Wait longer (Kong needs 30-60 seconds to be ready)
sleep 30
node scripts/setup-kong.js

# Check Kong status
curl http://localhost:8001/status
```

### Port Already in Use

```bash
# Find process using port (e.g., 8000)
lsof -i :8000

# Kill process
kill -9 <PID>

# Or change port in .env file
```

### Database Connection Issues

```bash
# Check PostgreSQL is running
docker-compose ps postgres

# Check logs
docker-compose logs postgres

# Restart PostgreSQL
docker-compose restart postgres
```

### Reset Everything

```bash
# Nuclear option: remove everything and start fresh
docker-compose down -v
docker system prune -af --volumes
docker-compose up --build -d
```

## Next Steps

Now that you have Food Flow running:

1. 📚 Read [README.md](./README.md) for complete documentation
2. 🏗️ Review [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the system design
3. 📖 Check [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) for API reference
4. 🚀 Start building features or integrate with your frontend
5. 🔍 Explore the Swagger docs at http://localhost:3001/api-docs

## Getting Help

- Check logs: `docker-compose logs -f`
- Review documentation in the project
- Open an issue on GitHub
- Check Docker and service health: `make health`

## Development Mode

For active development with hot reload:

```bash
# Start infrastructure only
docker-compose up postgres redis rabbitmq kong -d

# Run service locally
cd services/user-service
npm install
npm run dev
```

## Production Deployment

For production deployment, see:
- [README.md](./README.md) - Deployment section
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Production considerations

---

**Congratulations!** 🎉 You now have a fully functional food delivery platform running locally.
