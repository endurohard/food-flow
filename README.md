# Food Flow - Food Delivery Service

A modern, scalable food delivery platform built with microservices architecture, featuring Kong API Gateway, PostgreSQL, Redis, RabbitMQ, and comprehensive monitoring.

## Architecture Overview

```
┌─────────────┐
│   Nginx     │ ← Load Balancer & Frontend Server
└──────┬──────┘
       │
┌──────▼──────────┐
│  Kong Gateway   │ ← API Gateway (Rate Limiting, Auth, CORS)
└──────┬──────────┘
       │
       ├─────────────────┬─────────────────┬─────────────────┐
       │                 │                 │                 │
┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│   User      │  │ Restaurant  │  │   Order     │  │  Delivery   │
│  Service    │  │   Service   │  │  Service    │  │   Service   │
│  :3001      │  │    :3002    │  │   :3003     │  │    :3004    │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                 │                 │                 │
       └─────────────────┴─────────────────┴─────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
             ┌──────▼──────┐ ┌───▼────┐  ┌─────▼──────┐
             │  PostgreSQL │ │ Redis  │  │  RabbitMQ  │
             │   :5432     │ │ :6379  │  │   :5672    │
             └─────────────┘ └────────┘  └────────────┘

Monitoring Stack:
┌──────────────┐  ┌───────────┐  ┌─────────────────┐
│  Prometheus  │─▶│  Grafana  │  │ Elasticsearch + │
│    :9090     │  │   :3000   │  │   Kibana :5601  │
└──────────────┘  └───────────┘  └─────────────────┘
```

## Features

### Core Services

- **User Service** - Authentication, user management, and profiles
- **Restaurant Service** - Restaurant and menu management
- **Order Service** - Order processing and management
- **Delivery Service** - Real-time delivery tracking with WebSocket

### Infrastructure

- **Kong API Gateway** - Centralized API management with plugins
- **PostgreSQL** - Primary relational database
- **Redis** - Caching and session storage
- **RabbitMQ** - Message queue for async communication
- **Nginx** - Reverse proxy and load balancer

### Monitoring & Observability

- **Prometheus** - Metrics collection
- **Grafana** - Metrics visualization and dashboards
- **Elasticsearch + Kibana** - Log aggregation and analysis
- **Custom metrics** - Service-level metrics via prom-client

### API Documentation

- **Swagger/OpenAPI** - Interactive API documentation for all services
- Auto-generated from code annotations
- Available at `/api-docs` endpoint for each service

## Prerequisites

- Docker >= 20.10
- Docker Compose >= 2.0
- Node.js >= 20 (for local development)
- Git

## Quick Start

### 1. Clone the repository

```bash
git clone <repository-url>
cd food-flow
```

### 2. Copy environment configuration

```bash
cp .env.example .env
```

Edit `.env` file with your configuration (optional for development).

### 3. Start all services

```bash
# Start all services
docker-compose up -d

# Or build and start
docker-compose up --build -d

# Watch logs
docker-compose logs -f
```

### 4. Setup Kong API Gateway

Wait for Kong to be fully ready (about 30 seconds), then run:

```bash
node scripts/setup-kong.js
```

This script will:
- Configure services in Kong
- Setup routes for all microservices
- Enable CORS plugin
- Enable rate limiting

### 5. Access the services

| Service | URL | Description |
|---------|-----|-------------|
| Frontend | http://localhost | Main application |
| Kong Gateway | http://localhost:8000 | API Gateway |
| Kong Admin | http://localhost:8001 | Kong Admin API |
| Kong Manager | http://localhost:8002 | Kong Admin UI |
| Konga | http://localhost:1337 | Kong Admin Dashboard |
| User Service | http://localhost:3001 | Direct access (bypass Kong) |
| Restaurant Service | http://localhost:3002 | Direct access |
| Order Service | http://localhost:3003 | Direct access |
| Delivery Service | http://localhost:3004 | Direct access |
| Prometheus | http://localhost:9090 | Metrics database |
| Grafana | http://localhost:3000 | Dashboards (admin/admin) |
| Kibana | http://localhost:5601 | Log viewer |
| RabbitMQ Management | http://localhost:15672 | Queue management (foodflow/foodflow_secret) |

## API Documentation

Each service provides Swagger documentation:

- User Service: http://localhost:3001/api-docs
- Restaurant Service: http://localhost:3002/api-docs
- Order Service: http://localhost:3003/api-docs
- Delivery Service: http://localhost:3004/api-docs

Access via Kong Gateway:
- http://localhost:8000/api/users/... (User Service)
- http://localhost:8000/api/restaurants/... (Restaurant Service)
- http://localhost:8000/api/orders/... (Order Service)
- http://localhost:8000/api/deliveries/... (Delivery Service)

## Development

### Local Development Setup

1. Install dependencies for all services:

```bash
npm install
```

2. Start individual service in dev mode:

```bash
cd services/user-service
npm run dev
```

### Database Migrations

The database is automatically initialized with schema and seed data on first startup.

Manual migration:

```bash
# Access PostgreSQL
docker-compose exec postgres psql -U foodflow -d foodflow

# Run custom migrations
docker-compose exec postgres psql -U foodflow -d foodflow -f /docker-entrypoint-initdb.d/custom-migration.sql
```

### Testing

Run tests for all services:

```bash
npm test
```

Run tests for specific service:

```bash
cd services/user-service
npm test
```

## Configuration

### Environment Variables

See `.env.example` for all available configuration options.

Key configurations:
- Database credentials
- Redis connection
- RabbitMQ settings
- JWT secret
- Service ports

### Kong Configuration

Kong can be configured via:
1. Admin API (http://localhost:8001)
2. Konga UI (http://localhost:1337)
3. Setup script (`scripts/setup-kong.js`)

### Service Configuration

Each service has its own configuration in `services/[service-name]/src/config/`:
- Database connection
- Redis connection
- Service-specific settings

## Monitoring

### Prometheus Metrics

Access Prometheus at http://localhost:9090

Available metrics for each service:
- HTTP request duration
- HTTP request count
- Node.js process metrics
- Custom business metrics

### Grafana Dashboards

Access Grafana at http://localhost:3000 (admin/admin)

Pre-configured datasources:
- Prometheus

Create custom dashboards or import community dashboards.

### Logs with ELK Stack

Access Kibana at http://localhost:5601

Features:
- Centralized logging
- Log search and filtering
- Log visualization

## Database Schema

### Main Tables

- `users` - User accounts and authentication
- `addresses` - User delivery addresses
- `restaurants` - Restaurant information
- `restaurant_addresses` - Restaurant locations
- `menu_categories` - Menu category organization
- `menu_items` - Restaurant menu items
- `orders` - Customer orders
- `order_items` - Items in each order
- `deliveries` - Delivery tracking
- `reviews` - Restaurant and order reviews

### Sample Data

The database is seeded with sample data:
- 4 users (customer, restaurant owner, driver, admin)
- 3 restaurants (Pizza, Sushi, Burgers)
- Sample menu items
- Password for all users: `password123`

## API Examples

### Register User

```bash
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "firstName": "John",
    "lastName": "Doe",
    "role": "customer"
  }'
```

### Login

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "password123"
  }'
```

### Get Restaurants

```bash
curl http://localhost:8000/api/restaurants
```

## Deployment

### Production Considerations

1. **Security**:
   - Change all default passwords
   - Use strong JWT secrets
   - Enable HTTPS/TLS
   - Configure Kong authentication plugins
   - Set up firewall rules

2. **Scalability**:
   - Use Docker Swarm or Kubernetes
   - Scale services horizontally
   - Use managed database (RDS, Cloud SQL)
   - Use managed Redis (ElastiCache, Cloud Memorystore)
   - CDN for static assets

3. **Monitoring**:
   - Set up alerting in Prometheus
   - Configure log retention policies
   - Enable distributed tracing (Jaeger)
   - Set up uptime monitoring

4. **Backups**:
   - Automated database backups
   - Backup verification
   - Disaster recovery plan

### Docker Swarm Deployment

```bash
# Initialize swarm
docker swarm init

# Deploy stack
docker stack deploy -c docker-compose.yml food-flow

# Scale services
docker service scale food-flow_user-service=3
```

### Kubernetes Deployment

See `k8s/` directory for Kubernetes manifests (to be created).

## Troubleshooting

### Services not starting

Check logs:
```bash
docker-compose logs [service-name]
```

### Kong not responding

Restart Kong:
```bash
docker-compose restart kong
docker-compose restart kong-migration
```

### Database connection issues

Check PostgreSQL is running:
```bash
docker-compose ps postgres
docker-compose logs postgres
```

### Clear all data and restart

```bash
docker-compose down -v
docker-compose up --build -d
```

## Project Structure

```
food-flow/
├── services/                   # Microservices
│   ├── user-service/          # User & Auth service
│   ├── restaurant-service/    # Restaurant management
│   ├── order-service/         # Order processing
│   └── delivery-service/      # Delivery tracking
├── database/                   # Database scripts
│   └── init/                  # Initialization SQL
├── monitoring/                 # Monitoring configs
│   ├── prometheus/            # Prometheus configuration
│   └── grafana/               # Grafana dashboards
├── nginx/                      # Nginx configuration
├── scripts/                    # Utility scripts
│   └── setup-kong.js          # Kong setup automation
├── docker-compose.yml         # Docker orchestration
├── package.json               # Root package config
└── README.md                  # This file
```

## Technology Stack

### Backend
- **Node.js** - Runtime environment
- **TypeScript** - Type-safe JavaScript
- **Express** - Web framework
- **PostgreSQL** - Relational database
- **Redis** - Caching layer
- **RabbitMQ** - Message broker

### API Gateway
- **Kong** - API Gateway
- **Konga** - Kong Admin UI

### Monitoring
- **Prometheus** - Metrics collection
- **Grafana** - Visualization
- **Elasticsearch** - Log storage
- **Kibana** - Log visualization

### DevOps
- **Docker** - Containerization
- **Docker Compose** - Orchestration
- **Nginx** - Reverse proxy

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- GitHub Issues: [Create an issue]
- Email: support@foodflow.com
- Documentation: [Wiki]

## Roadmap

- [ ] Implement authentication logic in User Service
- [ ] Add payment gateway integration
- [ ] Implement real-time tracking with WebSocket
- [ ] Add email notifications
- [ ] Implement recommendation engine
- [ ] Add admin dashboard
- [ ] Mobile app integration
- [ ] Multi-language support
- [ ] Advanced analytics
- [ ] CI/CD pipeline

## Acknowledgments

Built with best practices for:
- Microservices architecture
- API Gateway pattern
- Event-driven architecture
- Container orchestration
- Observability
- DevOps automation
