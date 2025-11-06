.PHONY: help build up down clean logs restart setup kong-setup db-migrate

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

build: ## Build all Docker images
	docker-compose build

up: ## Start all services
	docker-compose up -d

down: ## Stop all services
	docker-compose down

clean: ## Stop and remove all containers, networks, and volumes
	docker-compose down -v
	docker system prune -f

logs: ## Follow logs from all services
	docker-compose logs -f

logs-service: ## Follow logs from specific service (usage: make logs-service SERVICE=user-service)
	docker-compose logs -f $(SERVICE)

restart: ## Restart all services
	docker-compose restart

restart-service: ## Restart specific service (usage: make restart-service SERVICE=user-service)
	docker-compose restart $(SERVICE)

setup: up kong-setup ## Full setup: start services and configure Kong
	@echo "Waiting for services to be ready..."
	@sleep 10
	@echo "Setup complete!"

kong-setup: ## Setup Kong API Gateway
	@echo "Setting up Kong API Gateway..."
	node scripts/setup-kong.js

db-migrate: ## Run database migrations
	docker-compose exec postgres psql -U foodflow -d foodflow -f /docker-entrypoint-initdb.d/01-init.sql

db-seed: ## Seed database with sample data
	docker-compose exec postgres psql -U foodflow -d foodflow -f /docker-entrypoint-initdb.d/02-seed.sql

db-shell: ## Open PostgreSQL shell
	docker-compose exec postgres psql -U foodflow -d foodflow

redis-shell: ## Open Redis CLI
	docker-compose exec redis redis-cli

rabbitmq-shell: ## Open RabbitMQ management
	@echo "Opening RabbitMQ Management UI at http://localhost:15672"
	@echo "Username: foodflow, Password: foodflow_secret"

test: ## Run tests for all services
	npm test

lint: ## Run linter for all services
	npm run lint

format: ## Format code
	npm run format

install: ## Install dependencies for all services
	npm install

dev-user: ## Start user service in development mode
	cd services/user-service && npm run dev

dev-restaurant: ## Start restaurant service in development mode
	cd services/restaurant-service && npm run dev

dev-order: ## Start order service in development mode
	cd services/order-service && npm run dev

dev-delivery: ## Start delivery service in development mode
	cd services/delivery-service && npm run dev

ps: ## Show running containers
	docker-compose ps

stats: ## Show container resource usage
	docker stats

health: ## Check health of all services
	@echo "Checking service health..."
	@curl -s http://localhost:3001/health | jq . || echo "User Service: DOWN"
	@curl -s http://localhost:3002/health | jq . || echo "Restaurant Service: DOWN"
	@curl -s http://localhost:3003/health | jq . || echo "Order Service: DOWN"
	@curl -s http://localhost:3004/health | jq . || echo "Delivery Service: DOWN"
	@curl -s http://localhost:8001/status | jq . || echo "Kong: DOWN"
