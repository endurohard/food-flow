#!/usr/bin/env node

const http = require('http');

const KONG_ADMIN_URL = process.env.KONG_ADMIN_URL || 'http://localhost:8001';

const services = [
  {
    name: 'user-service',
    url: 'http://user-service:3001',
    routes: [
      { paths: ['/api/users'], strip_path: true },
      { paths: ['/api/auth'], strip_path: true }
    ]
  },
  {
    name: 'restaurant-service',
    url: 'http://restaurant-service:3002',
    routes: [
      { paths: ['/api/restaurants'], strip_path: true },
      { paths: ['/api/menus'], strip_path: true }
    ]
  },
  {
    name: 'order-service',
    url: 'http://order-service:3003',
    routes: [
      { paths: ['/api/orders'], strip_path: true },
      { paths: ['/api/cart'], strip_path: true }
    ]
  },
  {
    name: 'delivery-service',
    url: 'http://delivery-service:3004',
    routes: [
      { paths: ['/api/deliveries'], strip_path: true },
      { paths: ['/api/tracking'], strip_path: true }
    ]
  }
];

function makeRequest(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function createService(service) {
  console.log(`Creating service: ${service.name}...`);

  const options = {
    hostname: 'localhost',
    port: 8001,
    path: '/services',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const serviceData = {
    name: service.name,
    url: service.url,
    protocol: 'http',
    connect_timeout: 60000,
    write_timeout: 60000,
    read_timeout: 60000
  };

  try {
    const result = await makeRequest(options, serviceData);

    if (result.status === 201 || result.status === 409) {
      console.log(`✓ Service ${service.name} created/exists`);
      return result.data;
    } else {
      console.error(`✗ Failed to create service ${service.name}:`, result);
      return null;
    }
  } catch (error) {
    console.error(`✗ Error creating service ${service.name}:`, error.message);
    return null;
  }
}

async function createRoute(serviceName, route) {
  console.log(`Creating route for ${serviceName}: ${route.paths[0]}...`);

  const options = {
    hostname: 'localhost',
    port: 8001,
    path: `/services/${serviceName}/routes`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const routeData = {
    paths: route.paths,
    strip_path: route.strip_path !== undefined ? route.strip_path : false,
    methods: route.methods || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
  };

  try {
    const result = await makeRequest(options, routeData);

    if (result.status === 201 || result.status === 409) {
      console.log(`✓ Route ${route.paths[0]} created/exists`);
      return result.data;
    } else {
      console.error(`✗ Failed to create route ${route.paths[0]}:`, result);
      return null;
    }
  } catch (error) {
    console.error(`✗ Error creating route ${route.paths[0]}:`, error.message);
    return null;
  }
}

async function enableCORS() {
  console.log('Enabling CORS globally...');

  const options = {
    hostname: 'localhost',
    port: 8001,
    path: '/plugins',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const corsData = {
    name: 'cors',
    config: {
      origins: ['*'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers: ['Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Content-Type', 'Date', 'Authorization'],
      exposed_headers: ['X-Auth-Token'],
      credentials: true,
      max_age: 3600
    }
  };

  try {
    const result = await makeRequest(options, corsData);

    if (result.status === 201 || result.status === 409) {
      console.log('✓ CORS enabled');
    } else {
      console.error('✗ Failed to enable CORS:', result);
    }
  } catch (error) {
    console.error('✗ Error enabling CORS:', error.message);
  }
}

async function enableRateLimiting() {
  console.log('Enabling rate limiting...');

  const options = {
    hostname: 'localhost',
    port: 8001,
    path: '/plugins',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const rateLimitData = {
    name: 'rate-limiting',
    config: {
      minute: 100,
      hour: 1000,
      policy: 'local'
    }
  };

  try {
    const result = await makeRequest(options, rateLimitData);

    if (result.status === 201 || result.status === 409) {
      console.log('✓ Rate limiting enabled');
    } else {
      console.error('✗ Failed to enable rate limiting:', result);
    }
  } catch (error) {
    console.error('✗ Error enabling rate limiting:', error.message);
  }
}

async function waitForKong(maxRetries = 30) {
  console.log('Waiting for Kong to be ready...');

  for (let i = 0; i < maxRetries; i++) {
    try {
      const options = {
        hostname: 'localhost',
        port: 8001,
        path: '/status',
        method: 'GET'
      };

      const result = await makeRequest(options);

      if (result.status === 200) {
        console.log('✓ Kong is ready');
        return true;
      }
    } catch (error) {
      // Kong not ready yet
    }

    console.log(`Waiting... (${i + 1}/${maxRetries})`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.error('✗ Kong did not become ready in time');
  return false;
}

async function main() {
  console.log('Kong Setup Script\n');

  const isReady = await waitForKong();
  if (!isReady) {
    process.exit(1);
  }

  // Create services and routes
  for (const service of services) {
    const createdService = await createService(service);

    if (createdService) {
      for (const route of service.routes) {
        await createRoute(service.name, route);
      }
    }

    console.log('');
  }

  // Enable plugins
  await enableCORS();
  await enableRateLimiting();

  console.log('\n✓ Kong setup completed!');
  console.log('\nKong Admin UI: http://localhost:8002');
  console.log('Konga UI: http://localhost:1337');
  console.log('API Gateway: http://localhost:8000');
}

main().catch(console.error);
