# Yeastar PBX Integration Service

WebSocket integration with Yeastar PBX for call handling, logging, and CRM integration in FoodFlow system.

## Features

### Call Management
- **Real-time Call Events**: WebSocket connection to Yeastar PBX
- **Call Logging**: Automatic logging of all inbound/outbound calls to PostgreSQL
- **Call Status Tracking**: Ringing, Answered, Ended, Missed
- **Duration Tracking**: Automatic calculation of call duration
- **Customer Linking**: Link calls to customers in CRM
- **Order Linking**: Associate calls with orders

### Click-to-Call
- **API Endpoint**: Initiate calls programmatically
- **Auto-answer**: Optional auto-answer for internal calls
- **Caller ID**: Custom caller ID name support

### Analytics & Reporting
- **Call History**: Complete call logs with search and filtering
- **Extension Statistics**: Calls per extension, average duration
- **Customer History**: View all calls from/to specific phone number
- **Performance Metrics**: Answer rates, missed calls, busy time

### Real-time Updates
- **Socket.IO**: Push call events to connected clients
- **Live Dashboard**: Real-time call status in admin panel
- **Notifications**: Pop-ups for incoming calls with customer info

## Architecture

### WebSocket Connection Flow

```
Yeastar PBX
    |
    | (WebSocket)
    ↓
Yeastar Service
    |
    ├─→ Call Logger (PostgreSQL)
    ├─→ Socket.IO (Frontend Updates)
    └─→ Event Handlers (CRM Integration)
```

### Event Types

1. **NewCdr**: New call detected
2. **CallRinging**: Call is ringing
3. **CallAnswered**: Call was answered
4. **CallEnded**: Call completed/ended
5. **ExtensionStatus**: Extension status changed

## Setup

### 1. Yeastar PBX Configuration

#### Enable API Access
1. Log in to Yeastar web interface
2. Go to **Settings** → **API**
3. Enable API access
4. Create API user with permissions:
   - Call Control
   - CDR Query
   - Extension Query
   - WebSocket Events

#### Configure WebSocket
1. Enable WebSocket API
2. Set WebSocket port (default: 8088)
3. Configure SSL certificate (recommended)

### 2. Service Configuration

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your Yeastar settings:

```bash
# Yeastar PBX IP or hostname
YEASTAR_HOST=192.168.1.100

# API port (usually 8088)
YEASTAR_PORT=8088

# API credentials
YEASTAR_USERNAME=api_user
YEASTAR_PASSWORD=your_secure_password

# API version
YEASTAR_API_VERSION=v2.0.0
```

### 3. Database Setup

Tables are created automatically on first run:

- **call_logs**: All call records with customer/order links
- **extensions**: Extension information and status

### 4. Install & Run

```bash
# Install dependencies
npm install

# Build
npm run build

# Start
npm start

# Development mode
npm run dev
```

## Docker Deployment

```bash
# Build
docker build -t yeastar-service .

# Run
docker run -d \
  -p 3008:3008 \
  -e YEASTAR_HOST=192.168.1.100 \
  -e YEASTAR_USERNAME=api_user \
  -e YEASTAR_PASSWORD=password \
  -e DATABASE_URL=postgresql://... \
  --name yeastar-service \
  yeastar-service
```

Or use docker-compose (already configured in main project).

## API Endpoints

### Health Check
```
GET /health
```

### Active Calls
```
GET /api/calls/active
```

Returns list of currently active calls.

### Call Logs
```
GET /api/calls/logs?limit=100&offset=0
```

Get paginated call history.

### Call Logs by Phone
```
GET /api/calls/logs/phone/:number
```

Get all calls from/to specific phone number.

### Extension Statistics
```
GET /api/calls/stats/:extension?from=2024-01-01&to=2024-01-31
```

Get call statistics for extension in date range.

### Click-to-Call
```
POST /api/calls/dial
Content-Type: application/json

{
  "from": "100",  // extension number
  "to": "+79991234567",  // phone to call
  "autoAnswer": true
}
```

### Hangup Call
```
POST /api/calls/hangup/:callId
```

### Link Call to Customer
```
POST /api/calls/:callId/customer
Content-Type: application/json

{
  "customerId": 123,
  "customerName": "John Doe",
  "customerPhone": "+79991234567"
}
```

### Link Call to Order
```
POST /api/calls/:callId/order
Content-Type: application/json

{
  "orderId": 456
}
```

### Add Note to Call
```
POST /api/calls/:callId/notes
Content-Type: application/json

{
  "note": "Customer requested callback"
}
```

### Get Extension Status
```
GET /api/extensions/:number/status
```

## Socket.IO Events

### Client → Server
Connect to `http://localhost:3008` with Socket.IO client.

### Server → Client

#### Connection Events
- `yeastar:connected` - Connected to Yeastar PBX
- `yeastar:disconnected` - Disconnected from PBX

#### Call Events
- `call:new` - New call initiated
- `call:ringing` - Call is ringing
- `call:answered` - Call answered
- `call:ended` - Call ended

#### Extension Events
- `extension:status` - Extension status changed

### Example Frontend Code

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3008');

socket.on('connect', () => {
  console.log('Connected to Yeastar service');
});

socket.on('call:new', (call) => {
  console.log('New call:', call);
  // Show notification popup
  showIncomingCallPopup(call);
});

socket.on('call:answered', (call) => {
  console.log('Call answered:', call);
  // Update UI
});

socket.on('call:ended', (call) => {
  console.log('Call ended. Duration:', call.duration);
  // Log to CRM
});
```

## Integration with FoodFlow

### Customer Recognition

When incoming call detected:
1. Extract caller phone number
2. Query customer database
3. Show customer profile popup:
   - Name, contact info
   - Order history
   - Loyalty status
   - Last interaction notes

### Order Creation

During call:
1. Quick order button in popup
2. Pre-fill customer information
3. Save call ID with order
4. Track call-to-order conversion

### Performance Tracking

- Calls handled per waiter/operator
- Average response time
- Missed call rate
- Customer satisfaction correlation

## Troubleshooting

### Cannot Connect to Yeastar

1. **Check network connectivity**:
   ```bash
   ping <YEASTAR_HOST>
   telnet <YEASTAR_HOST> 8088
   ```

2. **Verify API credentials**:
   - Username/password correct?
   - API user has proper permissions?

3. **Check SSL certificate**:
   - For self-signed certs, service accepts them
   - For production, use valid SSL

### No Call Events Received

1. **Verify WebSocket subscription**:
   - Check logs for "Subscribed to Yeastar events"

2. **Check event configuration in Yeastar**:
   - WebSocket events enabled?
   - Correct events selected?

3. **Heartbeat timeout**:
   - Adjust `YEASTAR_HEARTBEAT_INTERVAL`

### Database Connection Failed

1. **Check DATABASE_URL**:
   ```bash
   psql $DATABASE_URL
   ```

2. **Verify PostgreSQL is running**:
   ```bash
   docker-compose ps postgres
   ```

## Yeastar Models Supported

Tested with:
- Yeastar S-Series VoIP PBX (S20, S50, S100, S300)
- Yeastar P-Series PBX System
- Yeastar Cloud PBX

API Version: v2.0.0

## Security

- **API Authentication**: Token-based auth with Yeastar
- **HTTPS**: Recommended for production
- **Database**: Credentials stored in environment variables
- **CORS**: Configurable origin restrictions

## Performance

- **WebSocket**: Persistent connection, minimal latency
- **Database**: Indexed queries for fast lookups
- **Caching**: Redis caching for customer data (optional)
- **Scalability**: Horizontal scaling with multiple instances

## Monitoring

Logs include:
- Connection status
- All call events
- API requests
- Errors and warnings

Use with ELK stack or similar for production monitoring.

## Future Enhancements

- [ ] Call recording integration
- [ ] IVR flow tracking
- [ ] Queue monitoring
- [ ] SIP trunk statistics
- [ ] Voicemail transcription
- [ ] SMS integration
- [ ] Call whisper/barge features
- [ ] Advanced analytics dashboard

## Support

For issues related to:
- **Yeastar PBX**: Check Yeastar documentation
- **Service**: Create GitHub issue
- **Integration**: Contact FoodFlow support

## License

Part of FoodFlow Restaurant Management System.
