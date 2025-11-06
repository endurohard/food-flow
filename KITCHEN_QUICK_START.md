# Kitchen System Quick Start

## 5-Minute Setup Guide

### Step 1: Configure Printer (2 minutes)

Edit `.env` file:

```bash
# For Network Printer (easiest)
PRINTER_TYPE=network
PRINTER_INTERFACE=192.168.1.100:9100  # Your printer's IP:port
AUTO_PRINT=true

# For USB Printer
PRINTER_TYPE=usb
PRINTER_INTERFACE=/dev/usb/lp0
```

**Find Printer IP:**
- Print configuration page (hold FEED button while powering on)
- Or check your router's connected devices

### Step 2: Start Kitchen Service (1 minute)

```bash
# Start all services including kitchen
docker-compose up -d

# Or just kitchen service
docker-compose up -d kitchen-service

# Check logs
docker-compose logs -f kitchen-service
```

Wait for: `Printer connected successfully`

### Step 3: Test Printer (30 seconds)

```bash
# Test print
curl -X POST http://localhost:3005/api/printers/test

# Check status
curl http://localhost:3005/api/printers/status
```

If printer doesn't print, it will run in simulation mode (logs only).

### Step 4: Open Kitchen Display (1 minute)

**On Computer:**
```
http://localhost/kds/index.html?restaurantId=650e8400-e29b-41d4-a716-446655440001
```

**On iPad/Tablet:**
1. Open Safari/Chrome
2. Navigate to KDS URL above
3. Tap Share → "Add to Home Screen"
4. Launch from home screen (fullscreen)

**Kiosk Mode (dedicated display):**
```bash
# Chrome
google-chrome --kiosk --app="http://localhost/kds/index.html?restaurantId=XXX"

# Firefox
firefox --kiosk "http://localhost/kds/index.html?restaurantId=XXX"
```

### Step 5: Test with Order (30 seconds)

1. Go to Order Service Swagger: http://localhost:3003/api-docs
2. Create a test order
3. KDS should show the order + sound notification
4. Printer should print kitchen ticket (if auto-print enabled)

## Quick Reference

### Kitchen Display Controls

| Button | Action |
|--------|--------|
| Start Preparing | Order status: confirmed → preparing |
| Mark as Ready | Order status: preparing → ready |
| Complete | Order status: ready → picked_up (removes from display) |
| 🔔/🔕 | Toggle sound notifications |

### Order Status Colors

| Color | Meaning |
|-------|---------|
| Red border | New order (just arrived) |
| Yellow timer | Order > 20 minutes |
| Red blinking timer | Order > 30 minutes (urgent!) |

### Manual Print

```bash
# Print kitchen ticket for specific order
curl -X POST http://localhost:3005/api/printers/print/kitchen \
  -H "Content-Type: application/json" \
  -d '{"orderNumber":"ORD-123","customerName":"John","items":[...]}'

# Print customer receipt
curl -X POST http://localhost:3005/api/printers/print/receipt \
  -H "Content-Type: application/json" \
  -d '{"orderNumber":"ORD-123","total":25.99,...}'
```

## Troubleshooting (1 minute fixes)

### Printer Not Printing

```bash
# 1. Check printer IP is reachable
ping 192.168.1.100

# 2. Restart printer (power cycle)

# 3. Reconnect via API
curl -X POST http://localhost:3005/api/printers/reconnect

# 4. Restart service
docker-compose restart kitchen-service
```

### KDS Not Showing Orders

```bash
# 1. Check WebSocket connection (browser console - F12)
# Should see: "Connected to kitchen service"

# 2. Check RabbitMQ
http://localhost:15672  # Login: foodflow/foodflow_secret
# Verify "kitchen_orders_queue" exists and has messages

# 3. Check service logs
docker-compose logs -f kitchen-service
```

### Orders Not Auto-Printing

1. Check `AUTO_PRINT=true` in `.env`
2. Verify printer status: `curl http://localhost:3005/api/printers/status`
3. Test manual print: `curl -X POST http://localhost:3005/api/printers/test`

## Common Configurations

### Multiple Restaurants

Each restaurant needs its own KDS URL:
```
http://localhost/kds/index.html?restaurantId=restaurant-1-uuid
http://localhost/kds/index.html?restaurantId=restaurant-2-uuid
```

### Multiple Printers

Configure different printers for kitchen, bar, receipts in config.

### Static Printer IP

Set static IP in printer's web interface:
1. Go to `http://[printer-ip]`
2. Network Settings → Static IP
3. Set IP: `192.168.1.100`
4. Save and reboot

## Printer Compatibility

✅ **Tested Working:**
- Epson TM-T20/TM-T20II/TM-M30
- Star TSP100/TSP650
- Bixolon SRP-350III
- Citizen CT-S310II

Most ESC/POS printers work out of the box.

## Full Documentation

For complete setup guide including:
- Detailed printer configuration
- USB printer setup
- Bluetooth printers
- Troubleshooting
- Best practices

Read: [KITCHEN_PRINTER_SETUP.md](./KITCHEN_PRINTER_SETUP.md)

## Support

- Swagger API: http://localhost:3005/api-docs
- Service Health: http://localhost:3005/health
- Metrics: http://localhost:3005/metrics
- Logs: `docker-compose logs -f kitchen-service`

---

**Setup Time**: ~5 minutes
**Difficulty**: Easy
**Requirements**: Network printer or USB printer
