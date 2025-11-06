# 🚀 First Run Instructions

Welcome to Food Flow! This guide will walk you through your first successful launch.

## ⚠️ Before You Start

### System Requirements
- ✅ Docker Desktop installed and running
- ✅ At least 4GB RAM available for Docker
- ✅ At least 10GB free disk space
- ✅ Node.js 20+ installed (for Kong setup script)
- ✅ Git installed

### Verify Docker is Running
```bash
docker --version
# Should output: Docker version 20.x or higher

docker-compose --version
# Should output: Docker Compose version 2.x or higher

docker ps
# Should show running containers list (can be empty)
```

## 📋 Step-by-Step First Launch

### Step 1: Verify Project Files
```bash
cd food-flow
ls -la
```

You should see:
- ✅ docker-compose.yml
- ✅ .env file (if not, it will be created)
- ✅ services/ directory
- ✅ database/ directory
- ✅ scripts/ directory

### Step 2: Start Infrastructure Services First

Start PostgreSQL, Redis, and RabbitMQ first:
```bash
docker-compose up -d postgres redis rabbitmq
```

Wait 30 seconds for databases to initialize:
```bash
sleep 30
```

Check they're running:
```bash
docker-compose ps
```

Expected output:
```
NAME                  STATUS
food-flow-postgres    Up (healthy)
food-flow-redis       Up (healthy)
food-flow-rabbitmq    Up (healthy)
```

### Step 3: Start Kong Services

Start Kong database and run migrations:
```bash
docker-compose up -d kong-database kong-migration
```

Wait 20 seconds:
```bash
sleep 20
```

Start Kong Gateway:
```bash
docker-compose up -d kong
```

Wait for Kong to be ready (this is important!):
```bash
# Check Kong health (retry every 5 seconds until success)
until curl -f http://localhost:8001/status 2>/dev/null; do
  echo "Waiting for Kong..."
  sleep 5
done
echo "Kong is ready!"
```

### Step 4: Start Application Services

Now start the microservices:
```bash
docker-compose up -d user-service restaurant-service order-service delivery-service
```

### Step 5: Start Monitoring Stack
```bash
docker-compose up -d prometheus grafana elasticsearch kibana
```

### Step 6: Start Nginx
```bash
docker-compose up -d nginx
```

### Step 7: Configure Kong API Gateway

Run the Kong setup script:
```bash
node scripts/setup-kong.js
```

Expected output:
```
Kong Setup Script

Waiting for Kong to be ready...
✓ Kong is ready
Creating service: user-service...
✓ Service user-service created/exists
Creating route for user-service: /api/users...
✓ Route /api/users created/exists
...
✓ CORS enabled
✓ Rate limiting enabled

✓ Kong setup completed!

Kong Admin UI: http://localhost:8002
Konga UI: http://localhost:1337
API Gateway: http://localhost:8000
```

### Step 8: Verify All Services

Check all containers are running:
```bash
docker-compose ps
```

Expected output - ALL services should show "Up (healthy)":
```
NAME                     STATUS
kong-gateway            Up (healthy)
food-flow-postgres      Up (healthy)
food-flow-redis         Up (healthy)
food-flow-rabbitmq      Up (healthy)
user-service            Up (healthy)
restaurant-service      Up (healthy)
order-service           Up (healthy)
delivery-service        Up (healthy)
prometheus              Up
grafana                 Up
elasticsearch           Up
kibana                  Up
nginx-frontend          Up
```

### Step 9: Test the System

#### Test 1: Check Service Health
```bash
curl http://localhost:3001/health
# Should return: {"status":"healthy","service":"user-service",...}

curl http://localhost:3002/health
# Should return: {"status":"healthy","service":"restaurant-service",...}
```

#### Test 2: Test API Gateway
```bash
curl http://localhost:8000/api/users/profile
# Should return: 401 Unauthorized (expected - no auth token)
```

#### Test 3: Test Authentication
```bash
# Login with test user
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "password123"
  }'

# Should return: {"token":"...", "user":{...}}
```

### Step 10: Access Web Interfaces

Open these URLs in your browser:

1. **Kong Manager**: http://localhost:8002
   - View Kong configuration

2. **API Documentation**: http://localhost:3001/api-docs
   - Interactive API testing

3. **Grafana**: http://localhost:3000
   - Username: `admin`
   - Password: `admin`
   - View metrics and dashboards

4. **RabbitMQ**: http://localhost:15672
   - Username: `foodflow`
   - Password: `foodflow_secret`
   - View message queues

5. **Prometheus**: http://localhost:9090
   - View raw metrics

6. **Kibana**: http://localhost:5601
   - View logs

## ✅ Success Checklist

Mark each as complete:
- [ ] All Docker containers are running
- [ ] Kong setup completed successfully
- [ ] Can access Kong Manager (http://localhost:8002)
- [ ] Can access API docs (http://localhost:3001/api-docs)
- [ ] Login test returns a JWT token
- [ ] Grafana loads successfully
- [ ] No errors in logs: `docker-compose logs --tail=50`

## 🎉 What's Next?

### Explore the System

1. **Test User Accounts** (password: `password123`):
   - `john@example.com` - Customer
   - `restaurant@example.com` - Restaurant Owner
   - `driver@example.com` - Delivery Driver
   - `admin@foodflow.com` - Admin

2. **Try API Endpoints** via Swagger:
   - Go to http://localhost:3001/api-docs
   - Click "Authorize" and paste your JWT token
   - Try any endpoint

3. **Create Your First Order**:
   ```bash
   # 1. Login to get token
   TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"john@example.com","password":"password123"}' \
     | jq -r '.token')

   # 2. Get restaurants
   curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:8000/api/restaurants | jq

   # 3. Get menu for a restaurant
   # Use restaurant ID from previous response
   curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:8000/api/restaurants/{restaurant_id}/menu" | jq
   ```

4. **Monitor System**:
   - Watch real-time metrics in Grafana
   - Check service logs: `docker-compose logs -f user-service`
   - View message queues in RabbitMQ

### Read Documentation

- 📖 [README.md](./README.md) - Complete documentation
- 🏗️ [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- 📚 [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) - API reference
- 📋 [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) - Project summary

## 🐛 Troubleshooting

### Issue: Containers Won't Start

```bash
# Check Docker is running
docker info

# Check available resources
docker system df

# Clean up if needed
docker system prune -f
```

### Issue: Kong Setup Fails

```bash
# Make sure Kong is fully ready
curl http://localhost:8001/status

# If not ready, wait longer
sleep 30

# Try setup again
node scripts/setup-kong.js
```

### Issue: Port Already in Use

```bash
# Find what's using port 8000 (example)
lsof -i :8000

# Kill the process
kill -9 <PID>

# Or change port in docker-compose.yml
```

### Issue: Database Initialization Failed

```bash
# Restart PostgreSQL
docker-compose restart postgres

# Check logs
docker-compose logs postgres

# If needed, recreate with fresh database
docker-compose down -v postgres
docker-compose up -d postgres
```

### Issue: Services Show "Unhealthy"

```bash
# Check logs for the service
docker-compose logs <service-name>

# Common fix: restart the service
docker-compose restart <service-name>

# If persists, rebuild
docker-compose up -d --build <service-name>
```

## 🆘 Need Help?

### Check Logs
```bash
# All services
docker-compose logs --tail=100

# Specific service
docker-compose logs -f user-service

# Last errors only
docker-compose logs --tail=50 | grep -i error
```

### Health Checks
```bash
# Check all services
make health

# Or manually
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
curl http://localhost:3004/health
```

### Complete Reset
If all else fails, start fresh:
```bash
# WARNING: This deletes all data!
docker-compose down -v
docker system prune -af --volumes

# Start from Step 1
docker-compose up -d postgres redis rabbitmq
# ... follow steps again
```

## 📊 Expected Resource Usage

After successful startup, you should see approximately:

```bash
docker stats --no-stream
```

Expected ranges:
- **Total Memory**: 2-3 GB
- **CPU**: 5-15% idle, 30-50% under load
- **Disk**: ~2 GB for images, ~500 MB for data

## ✨ Tips for Development

### Use Make Commands
```bash
make up          # Start everything
make logs        # View logs
make health      # Check health
make kong-setup  # Setup Kong
```

### Hot Reload for Development
```bash
# Run service locally with auto-reload
cd services/user-service
npm install
npm run dev
```

### View Logs in Real-time
```bash
# Split terminal and watch different services
docker-compose logs -f user-service
docker-compose logs -f order-service
```

## 🎊 Congratulations!

You've successfully set up Food Flow! The system is now running with:
- ✅ 4 microservices
- ✅ API Gateway (Kong)
- ✅ Database (PostgreSQL)
- ✅ Cache (Redis)
- ✅ Message Queue (RabbitMQ)
- ✅ Monitoring (Prometheus + Grafana)
- ✅ Logging (ELK Stack)

Start building amazing features! 🚀

---

**Last Updated**: 2024
**Need More Help?**: Check [README.md](./README.md) or [QUICK_START.md](./QUICK_START.md)
