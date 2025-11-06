# Kitchen Display System & Printer Setup Guide

Complete guide for setting up the Kitchen Display System (KDS) and thermal receipt printers in Food Flow.

## Overview

The Kitchen Service provides two main features:
1. **Kitchen Display System (KDS)** - Real-time order display for kitchen staff
2. **Thermal Printer Integration** - Automatic printing of kitchen tickets and customer receipts

## Architecture

```
Order Service → RabbitMQ → Kitchen Service → {
                                               ├─> Thermal Printer (ESC/POS)
                                               └─> Kitchen Display (WebSocket)
                                             }
```

## Kitchen Service Features

### 1. Automatic Order Reception
- Listens to RabbitMQ for new orders
- Automatically processes and displays orders
- Optional auto-print to thermal printer

### 2. Kitchen Display System
- Real-time order updates via WebSocket
- Color-coded by order age (green → yellow → red)
- Sound notifications for new orders
- Order status management (Confirmed → Preparing → Ready)
- Order statistics dashboard

### 3. Printer Integration
- Supports ESC/POS thermal printers
- Kitchen tickets (simplified for cooking)
- Customer receipts (detailed with totals)
- QR codes for order tracking
- Test print functionality

## Printer Setup

### Supported Printer Types

#### 1. Network Printers (Recommended)
- **Connection**: Via IP address and port
- **Configuration**: Set `PRINTER_TYPE=network` and `PRINTER_INTERFACE=192.168.1.100:9100`
- **Advantages**: Easy setup, no USB drivers needed
- **Best For**: Permanent kitchen installations

#### 2. USB Printers
- **Connection**: Direct USB connection
- **Configuration**: Set `PRINTER_TYPE=usb` and `PRINTER_INTERFACE=/dev/usb/lp0`
- **Docker**: Requires device mapping and privileged mode
- **Best For**: Single workstation setups

#### 3. Bluetooth Printers
- **Connection**: Bluetooth pairing
- **Configuration**: Set `PRINTER_TYPE=bluetooth` and device address
- **Best For**: Mobile or tablet-based KDS

### Compatible Printer Models

Tested and compatible models:
- **Epson TM-T20II/III** (USB, Network, Bluetooth)
- **Epson TM-M30** (Network, Bluetooth)
- **Star Micronics TSP100** (USB, Network)
- **Star Micronics TSP650** (Network)
- **Bixolon SRP-350III** (USB, Network)
- **Citizen CT-S310II** (USB, Network, Bluetooth)

Most ESC/POS compatible printers will work.

## Installation Steps

### Step 1: Configure Environment Variables

Edit `.env` or `docker-compose.yml`:

```bash
# Kitchen Service Configuration
PORT=3005
DATABASE_URL=postgresql://foodflow:foodflow_secret@postgres:5432/foodflow
RABBITMQ_URL=amqp://foodflow:foodflow_secret@rabbitmq:5672

# Printer Settings
PRINTER_TYPE=network              # network, usb, or bluetooth
PRINTER_INTERFACE=192.168.1.100:9100  # IP:port for network, device path for USB
PRINTER_ENCODING=UTF-8
PRINTER_WIDTH=48                  # characters per line (32, 48, or 80)
AUTO_PRINT=true                   # Auto-print orders when received

# Kitchen Display Settings
ORDER_TIMEOUT=1800                # seconds (30 minutes)
SOUND_ENABLED=true
AUTO_REFRESH=30                   # seconds
```

### Step 2: Network Printer Setup

#### Find Printer IP Address

**Method 1: Print Configuration Page**
1. Turn off printer
2. Hold FEED button while turning on
3. Release when it starts printing
4. Look for IP address on printout

**Method 2: Router Admin Panel**
1. Log into your router
2. Check connected devices
3. Find device named "EPSON" or your printer brand

#### Configure Printer IP (Static)

For reliable operation, set a static IP:

1. Access printer's web interface: `http://[printer-ip]`
2. Navigate to Network Settings
3. Set to Static IP
4. Configure:
   - IP Address: `192.168.1.100`
   - Subnet Mask: `255.255.255.0`
   - Gateway: `192.168.1.1`
   - DNS: `8.8.8.8`
5. Save and reboot printer

#### Test Connection

```bash
# Test if printer is reachable
ping 192.168.1.100

# Test if print port is open (9100 is standard)
telnet 192.168.1.100 9100

# Or use netcat
nc -zv 192.168.1.100 9100
```

### Step 3: USB Printer Setup (Linux/Docker)

#### Find USB Device

```bash
# List USB devices
lsusb

# Find printer device
ls -l /dev/usb/

# Common paths:
# /dev/usb/lp0
# /dev/usb/lp1
```

#### Docker USB Access

Uncomment in `docker-compose.yml`:

```yaml
kitchen-service:
  devices:
    - "/dev/usb/lp0:/dev/usb/lp0"
  privileged: true
```

### Step 4: Start Kitchen Service

```bash
# Start only kitchen service
docker-compose up -d kitchen-service

# Or start all services
docker-compose up -d

# Check logs
docker-compose logs -f kitchen-service
```

Expected output:
```
Kitchen service listening on port 3005
RabbitMQ service started successfully
Printer connected successfully
```

### Step 5: Test Printer

#### Via API

```bash
# Test print
curl -X POST http://localhost:3005/api/printers/test

# Check printer status
curl http://localhost:3005/api/printers/status
```

#### Via Swagger UI

1. Open http://localhost:3005/api-docs
2. Navigate to "Printers" section
3. Try "POST /api/printers/test"
4. Click "Execute"

Expected: Printer should print a test page.

## Kitchen Display System Setup

### Step 1: Access KDS Interface

Open in full-screen browser (Chrome/Firefox recommended):

```
http://localhost/kds/index.html?restaurantId=<your-restaurant-id>
```

Or direct to kitchen service:
```
http://localhost:3005/kds/index.html?restaurantId=<your-restaurant-id>
```

### Step 2: Configure Display

**Recommended Setup:**
- **Device**: Dedicated tablet or monitor
- **Browser**: Chrome or Firefox in kiosk mode
- **Resolution**: 1920x1080 or higher
- **Internet**: Stable connection (wired preferred)

**Kiosk Mode Setup:**

**Chrome (Linux/Mac/Windows):**
```bash
# Linux
google-chrome --kiosk --app="http://localhost/kds/index.html?restaurantId=XXX"

# Mac
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --kiosk --app="http://localhost/kds/index.html?restaurantId=XXX"

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --app="http://localhost/kds/index.html?restaurantId=XXX"
```

**Firefox:**
```bash
firefox --kiosk "http://localhost/kds/index.html?restaurantId=XXX"
```

### Step 3: iPad/Android Tablet Setup

1. Open Safari (iPad) or Chrome (Android)
2. Navigate to KDS URL
3. **iOS**: Tap Share → Add to Home Screen
4. **Android**: Tap Menu → Add to Home Screen
5. Open from home screen (launches in fullscreen)

### Step 4: Test Real-Time Updates

1. Create a test order through API or Swagger
2. KDS should show new order with sound notification
3. Click "Start Preparing" - status should update
4. Click "Mark as Ready" - order should turn green

## Usage Guide

### Kitchen Staff Workflow

1. **New Order Arrives**
   - Sound notification plays
   - Order card appears with pulsing animation
   - Kitchen ticket prints automatically (if AUTO_PRINT=true)

2. **Start Preparing**
   - Click "Start Preparing" button
   - Order card changes color
   - Timer shows elapsed time

3. **Mark as Ready**
   - When food is ready, click "Mark as Ready"
   - Order moves to "Ready" column
   - Delivery service is notified

4. **Order Picked Up**
   - Driver/customer picks up order
   - Click "Complete" button
   - Order disappears from display

### Order Status Colors

- **Red border**: New/Confirmed order
- **Yellow timer**: Order > 20 minutes (warning)
- **Red timer**: Order > 30 minutes (critical)

### Manual Print Operations

#### Print Kitchen Ticket

```bash
curl -X POST http://localhost:3005/api/printers/print/kitchen \
  -H "Content-Type: application/json" \
  -d '{
    "orderNumber": "ORD-12345",
    "orderType": "delivery",
    "customerName": "John Doe",
    "items": [
      {"name": "Pizza Margherita", "quantity": 2, "specialInstructions": "Extra cheese"}
    ],
    "specialInstructions": "Ring doorbell",
    "timestamp": "2024-01-01T12:00:00Z"
  }'
```

#### Print Customer Receipt

```bash
curl -X POST http://localhost:3005/api/printers/print/receipt \
  -H "Content-Type: application/json" \
  -d '{
    "orderNumber": "ORD-12345",
    "restaurant": {
      "name": "Pizza Paradise",
      "address": "123 Main St",
      "phone": "+1234567890"
    },
    "customer": {"name": "John Doe"},
    "items": [
      {"name": "Pizza Margherita", "quantity": 2, "price": 12.99}
    ],
    "subtotal": 25.98,
    "deliveryFee": 3.99,
    "tax": 2.40,
    "total": 32.37,
    "orderType": "delivery",
    "timestamp": "2024-01-01T12:00:00Z"
  }'
```

## Troubleshooting

### Printer Not Connecting

**Network Printer:**
```bash
# 1. Check network connectivity
ping 192.168.1.100

# 2. Check port
telnet 192.168.1.100 9100

# 3. Check printer power and cable
# 4. Restart printer
# 5. Check firewall rules
```

**USB Printer:**
```bash
# 1. Check USB connection
lsusb | grep -i printer

# 2. Check device permissions
ls -l /dev/usb/lp0

# 3. Grant permissions
sudo chmod 666 /dev/usb/lp0

# 4. Restart Docker container
docker-compose restart kitchen-service
```

### KDS Not Receiving Orders

**Check WebSocket Connection:**
1. Open browser console (F12)
2. Look for "Connected to kitchen service" message
3. If disconnected, check network/firewall

**Check RabbitMQ:**
```bash
# Access RabbitMQ management
http://localhost:15672

# Login: foodflow / foodflow_secret
# Check queues: should see "kitchen_orders_queue"
# Check messages: should see incoming messages
```

**Check Kitchen Service Logs:**
```bash
docker-compose logs -f kitchen-service
```

### Print Quality Issues

**Text Too Large/Small:**
- Adjust `PRINTER_WIDTH` setting (32, 48, or 80)

**Characters Not Printing Correctly:**
- Change `PRINTER_ENCODING` to match your language
- Common: UTF-8, ASCII, GB18030 (Chinese), Shift-JIS (Japanese)

**Alignment Issues:**
- Ensure `PRINTER_WIDTH` matches your printer's actual width
- Check printer paper width setting

### Orders Not Auto-Printing

1. Check `AUTO_PRINT=true` in environment
2. Verify printer connection
3. Check kitchen service logs for errors
4. Test manual print via API

## Advanced Configuration

### Multiple Printers

To print to different printers (kitchen, bar, receipt):

```javascript
// In kitchen-service config
const printers = {
  kitchen: { interface: '192.168.1.100:9100' },
  bar: { interface: '192.168.1.101:9100' },
  receipt: { interface: '192.168.1.102:9100' }
};
```

### Custom Receipt Templates

Edit `/services/kitchen-service/src/services/printer.service.ts` to customize:
- Header/footer text
- Logo (requires image support)
- Font sizes
- Layout

### Load Balancing KDS

For multiple displays:

```nginx
# nginx.conf
upstream kds {
  server kds-display-1:3005;
  server kds-display-2:3005;
}
```

## Monitoring

### Printer Health Check

```bash
# API endpoint
curl http://localhost:3005/api/printers/status

# Prometheus metrics
curl http://localhost:3005/metrics | grep orders_printed
```

### KDS Analytics

```bash
# Kitchen statistics
curl "http://localhost:3005/api/kitchen/stats?restaurantId=XXX"

# Response:
{
  "pending": 3,
  "preparing": 5,
  "ready": 2,
  "averageTime": 18  # minutes
}
```

## Best Practices

1. **Network Stability**
   - Use wired connection for printers
   - Use static IP addresses
   - Dedicated VLAN for kitchen devices

2. **Backup Printer**
   - Keep a spare printer configured
   - Document printer settings
   - Keep backup paper rolls

3. **Display Maintenance**
   - Clean screen regularly
   - Adjust brightness for kitchen environment
   - Set screen timeout to "Never"

4. **Staff Training**
   - Train all kitchen staff on KDS usage
   - Post quick reference guide near display
   - Practice with test orders

## Printer Maintenance

- **Daily**: Check paper roll level
- **Weekly**: Clean print head with alcohol wipes
- **Monthly**: Clean paper path and sensors
- **Quarterly**: Replace worn parts (cutter blade)

## Support

For issues:
1. Check logs: `docker-compose logs kitchen-service`
2. Test connectivity: `curl http://localhost:3005/health`
3. Review troubleshooting section above
4. Check [GitHub Issues](https://github.com/your-repo/issues)

---

**Kitchen Service Version**: 1.0.0
**Last Updated**: 2024
