# Food Flow - Architecture Documentation

## System Architecture

Food Flow is built using a microservices architecture pattern with API Gateway, providing scalability, maintainability, and independent deployment of services.

## Architecture Principles

1. **Microservices**: Each service is independent and focuses on a specific business domain
2. **API Gateway**: Centralized entry point with Kong for routing, authentication, and rate limiting
3. **Event-Driven**: Asynchronous communication using RabbitMQ for loose coupling
4. **Database per Service**: Each service has its own data domain (shared PostgreSQL with logical separation)
5. **Containerization**: All services are containerized with Docker
6. **Observability**: Comprehensive monitoring and logging with Prometheus, Grafana, and ELK stack

## Service Breakdown

### 1. User Service (Port 3001)

**Responsibilities**:
- User registration and authentication
- JWT token management
- User profile management
- Address management
- Role-based access control (RBAC)

**Technologies**:
- Express.js with TypeScript
- bcryptjs for password hashing
- jsonwebtoken for JWT
- PostgreSQL for data persistence
- Redis for session caching

**API Endpoints**:
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/refresh` - Token refresh
- `POST /api/auth/logout` - User logout
- `GET /api/users/profile` - Get user profile
- `PUT /api/users/profile` - Update profile
- `GET /api/users/addresses` - Get addresses
- `POST /api/users/addresses` - Add address

### 2. Restaurant Service (Port 3002)

**Responsibilities**:
- Restaurant registration and management
- Menu category management
- Menu item management
- Restaurant search and filtering
- Restaurant availability management

**Technologies**:
- Express.js with TypeScript
- PostgreSQL for data persistence
- Redis for caching popular restaurants

**API Endpoints**:
- `GET /api/restaurants` - List restaurants
- `GET /api/restaurants/:id` - Get restaurant details
- `POST /api/restaurants` - Create restaurant (owner)
- `PUT /api/restaurants/:id` - Update restaurant
- `GET /api/restaurants/:id/menu` - Get menu
- `POST /api/menus/categories` - Create menu category
- `POST /api/menus/items` - Create menu item

### 3. Order Service (Port 3003)

**Responsibilities**:
- Shopping cart management
- Order creation and processing
- Order status tracking
- Order history
- Payment integration
- Publish order events to RabbitMQ

**Technologies**:
- Express.js with TypeScript
- PostgreSQL for order data
- Redis for cart caching
- RabbitMQ for event publishing

**API Endpoints**:
- `GET /api/cart` - Get cart
- `POST /api/cart/items` - Add to cart
- `DELETE /api/cart/items/:id` - Remove from cart
- `POST /api/orders` - Create order
- `GET /api/orders` - Get order history
- `GET /api/orders/:id` - Get order details
- `PUT /api/orders/:id/status` - Update order status

**Events Published**:
- `order.created` - New order created
- `order.confirmed` - Order confirmed by restaurant
- `order.ready` - Order ready for pickup
- `order.cancelled` - Order cancelled

### 4. Delivery Service (Port 3004)

**Responsibilities**:
- Delivery assignment to drivers
- Real-time location tracking
- Delivery status updates
- WebSocket for real-time updates
- Consume order events from RabbitMQ

**Technologies**:
- Express.js with TypeScript
- Socket.IO for WebSocket
- PostgreSQL for delivery data
- RabbitMQ for event consumption

**API Endpoints**:
- `GET /api/deliveries` - Get deliveries (driver)
- `GET /api/deliveries/:id` - Get delivery details
- `PUT /api/deliveries/:id/status` - Update delivery status
- `PUT /api/deliveries/:id/location` - Update location
- `GET /api/tracking/:orderId` - Track order (customer)

**Events Consumed**:
- `order.ready` - Assign delivery to driver

**WebSocket Events**:
- `location_update` - Driver location update
- `status_change` - Delivery status change

## Infrastructure Components

### Kong API Gateway (Port 8000)

**Purpose**: Centralized API management

**Features**:
- Request routing to microservices
- Rate limiting (100 req/min, 1000 req/hour)
- CORS handling
- Authentication (JWT plugin - to be configured)
- Request/response transformation
- API analytics

**Configuration**:
- Admin API: Port 8001
- Manager UI: Port 8002
- Konga Dashboard: Port 1337

### PostgreSQL (Port 5432)

**Purpose**: Primary data store

**Features**:
- ACID transactions
- Complex queries with JOINs
- UUID primary keys
- Automatic timestamps with triggers
- Indexes for performance

**Database**: `foodflow`
**User**: `foodflow`

### Redis (Port 6379)

**Purpose**: Caching and session storage

**Use Cases**:
- User session caching
- Shopping cart storage
- Restaurant data caching
- Rate limiting counters

### RabbitMQ (Port 5672, Management 15672)

**Purpose**: Message broker for async communication

**Exchanges & Queues**:
- `orders_exchange` - Order events
- `delivery_queue` - Delivery assignments
- `notification_queue` - Notification events

**Pattern**: Publish-Subscribe with topic exchange

### Nginx (Port 80)

**Purpose**: Reverse proxy and load balancer

**Features**:
- Frontend static file serving
- API request proxying to Kong
- Rate limiting
- Gzip compression
- Security headers

## Monitoring Stack

### Prometheus (Port 9090)

**Purpose**: Metrics collection and storage

**Metrics Collected**:
- HTTP request duration
- HTTP request count
- Node.js process metrics (CPU, memory)
- Custom business metrics
- Database connection pool metrics

**Scrape Interval**: 15 seconds

### Grafana (Port 3000)

**Purpose**: Metrics visualization

**Default Credentials**: admin/admin

**Dashboards**:
- Service health overview
- Request rate and latency
- Error rates
- Resource usage (CPU, memory)
- Business metrics (orders, users)

### Elasticsearch + Kibana (Ports 9200, 5601)

**Purpose**: Log aggregation and analysis

**Features**:
- Centralized logging
- Full-text search
- Log patterns and anomalies
- Custom visualizations

## Data Flow Examples

### Order Creation Flow

```
1. Customer → Nginx → Kong → Order Service
   POST /api/orders

2. Order Service → PostgreSQL
   Save order data

3. Order Service → RabbitMQ
   Publish 'order.created' event

4. Order Service → Response to Customer
   Return order confirmation

5. RabbitMQ → Restaurant Service
   Consume 'order.created' event
   Send notification to restaurant

6. Restaurant confirms → Order Service
   PUT /api/orders/:id/status (status: confirmed)

7. Order Service → RabbitMQ
   Publish 'order.confirmed' event

8. Order ready → Order Service
   PUT /api/orders/:id/status (status: ready)

9. Order Service → RabbitMQ
   Publish 'order.ready' event

10. RabbitMQ → Delivery Service
    Consume 'order.ready' event
    Assign delivery to available driver
```

### Real-time Delivery Tracking Flow

```
1. Customer → Nginx → Delivery Service
   WebSocket connection to track order

2. Driver updates location → Delivery Service
   PUT /api/deliveries/:id/location

3. Delivery Service → PostgreSQL
   Save location data

4. Delivery Service → WebSocket
   Broadcast location to customer

5. Customer receives real-time update
   Display on map
```

## Security Considerations

### Authentication & Authorization

- JWT tokens for authentication
- Role-based access control (RBAC)
- Token expiration: 7 days
- Refresh token mechanism

### API Security

- Kong rate limiting
- CORS configuration
- Helmet.js security headers
- Input validation with Joi
- SQL injection prevention with parameterized queries

### Data Security

- Password hashing with bcrypt (10 rounds)
- Sensitive data encryption
- Environment variable management
- No credentials in code

## Scalability Strategies

### Horizontal Scaling

- Scale individual services independently
- Use Docker Swarm or Kubernetes
- Load balancing with Nginx or Kong

### Caching

- Redis for frequently accessed data
- Restaurant catalog caching
- User session caching
- Cart data caching

### Database Optimization

- Proper indexing strategy
- Connection pooling
- Read replicas for read-heavy operations
- Query optimization

### Asynchronous Processing

- RabbitMQ for non-blocking operations
- Background job processing
- Event-driven notifications

## Deployment Architecture

### Development Environment

```
docker-compose up
```

All services run on localhost with port mapping.

### Production Environment (Recommended)

**Option 1: Docker Swarm**
```bash
docker swarm init
docker stack deploy -c docker-compose.yml food-flow
```

**Option 2: Kubernetes**
- Use Helm charts for deployment
- Ingress controller for routing
- Horizontal Pod Autoscaling (HPA)
- Persistent Volumes for data

**Option 3: Cloud Managed Services**
- AWS ECS/EKS for container orchestration
- RDS for PostgreSQL
- ElastiCache for Redis
- Amazon MQ for RabbitMQ
- CloudWatch for monitoring

## Performance Considerations

### Response Time Goals

- API Gateway: < 50ms overhead
- Service response: < 200ms (p95)
- Database queries: < 50ms (p95)
- WebSocket latency: < 100ms

### Throughput Goals

- 1000 requests/second per service
- 10,000 concurrent users
- 100 concurrent WebSocket connections per instance

### Resource Allocation

**Per Service**:
- CPU: 0.5-1 core
- Memory: 512MB-1GB
- Storage: Based on data volume

## Monitoring & Alerting

### Key Metrics

1. **Service Health**
   - Uptime percentage
   - Response time (p50, p95, p99)
   - Error rate

2. **Business Metrics**
   - Orders per minute
   - User registrations
   - Average order value
   - Delivery completion time

3. **Infrastructure Metrics**
   - CPU usage
   - Memory usage
   - Disk I/O
   - Network traffic

### Alerting Rules

- Service down > 1 minute
- Error rate > 5%
- Response time p95 > 500ms
- CPU usage > 80%
- Memory usage > 85%
- Database connections > 80% of pool

## Disaster Recovery

### Backup Strategy

- PostgreSQL automated backups (daily)
- Redis snapshots (hourly)
- Configuration backups
- Database transaction logs

### Recovery Procedures

- Database restore from backup
- Service rollback using Docker images
- Configuration restore
- Data consistency checks

## Future Enhancements

1. **Service Mesh**: Implement Istio or Linkerd for advanced traffic management
2. **Circuit Breaker**: Add Hystrix or similar for fault tolerance
3. **API Versioning**: Implement versioning strategy (URL or header-based)
4. **GraphQL Gateway**: Add GraphQL layer for flexible queries
5. **Machine Learning**: Recommendation engine, demand prediction
6. **Mobile Backend**: GraphQL subscriptions for mobile apps
7. **Analytics Service**: Dedicated service for business analytics
8. **Notification Service**: Email, SMS, and push notifications
9. **Search Service**: Elasticsearch-based advanced search
10. **Payment Service**: Payment gateway integration microservice
