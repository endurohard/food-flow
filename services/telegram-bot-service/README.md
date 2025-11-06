# Telegram Bot Service

Telegram bot for processing invoices and managing inventory arrivals in FoodFlow system.

## Features

- **Invoice Photo Processing**: Send photos of invoices to automatically extract data
- **OCR Text Recognition**: Uses Tesseract.js for Russian and English text recognition
- **AI-Powered Parsing**: Optional OpenAI integration for intelligent invoice parsing
- **Inventory Integration**: Automatically creates inventory arrivals in restaurant service
- **Access Control**: Only authorized users (admin/owner) can use the bot
- **Invoice Storage**: Stores all processed invoices for future reference
- **Multi-format Support**: Handles photos and documents

## Setup

### 1. Create Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` command
3. Follow instructions to create your bot
4. Copy the bot token provided

### 2. Get Your Telegram User ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. Copy your user ID

### 3. Configure Environment

Create `.env` file or set environment variables:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_here
ALLOWED_USER_IDS=123456789,987654321  # Comma-separated list

# Optional - for webhook mode (production)
WEBHOOK_URL=https://yourdomain.com/webhook

# Optional - for AI-powered parsing
OPENAI_API_KEY=your_openai_key

# Service configuration
PORT=3007
INVENTORY_API_URL=http://restaurant-service:3002/api/inventory
UPLOAD_DIR=/app/uploads/invoices
```

### 4. Install Dependencies

```bash
npm install
```

### 5. Build

```bash
npm run build
```

### 6. Run

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

## Docker Deployment

The service is included in the main docker-compose.yml:

```bash
# Build and start
docker-compose up --build -d telegram-bot-service

# View logs
docker-compose logs -f telegram-bot-service

# Stop
docker-compose stop telegram-bot-service
```

## Usage

### Commands

- `/start` - Initialize bot and see instructions
- `/help` - Display help information
- `/invoices` - List all processed invoices
- `/get <id>` - View specific invoice details

### Processing Invoices

1. Send a photo or document of an invoice to the bot
2. Bot will:
   - Download and save the image
   - Perform OCR to extract text
   - Parse invoice data (supplier, items, prices)
   - Create inventory arrival in restaurant service
   - Send confirmation with extracted data

### Example Invoice Format

The bot can parse invoices with formats like:

```
НАКЛАДНАЯ №12345
Дата: 15.01.2024
Поставщик: ООО "Продукты+"

Наименование          Кол-во  Ед.  Цена    Сумма
Мука пшеничная        50      кг   45.00   2250.00
Сахар                 25      кг   60.00   1500.00
Масло подсолнечное    10      л    120.00  1200.00

Итого:                                     4950.00 руб
```

## Architecture

### Services

- **BotService** (`bot.service.ts`): Main Telegraf bot with message handlers
- **OCRService** (`ocr.service.ts`): Image preprocessing and text recognition
- **InvoiceParserService** (`invoice-parser.service.ts`): Extract structured data from OCR text
- **InventoryApiService** (`inventory-api.service.ts`): Communication with restaurant service API

### Data Flow

```
User sends photo
  → Bot downloads image
  → OCR extracts text
  → Parser extracts structured data
  → Inventory API creates arrival
  → Bot confirms to user
```

## Invoice Parsing

### AI-Powered Parsing (Recommended)

If `OPENAI_API_KEY` is set, the bot uses GPT-4 to intelligently parse invoice text:

- More accurate extraction
- Handles various invoice formats
- Better handling of unclear text
- Contextual understanding

### Regex-Based Parsing (Fallback)

Without OpenAI, uses regex patterns to extract:

- Supplier name: "Поставщик:", "Продавец:", "ООО", "ИП"
- Invoice number: "Накладная №", "Счет №"
- Date: DD.MM.YYYY or YYYY-MM-DD formats
- Items: Pattern matching for name, quantity, unit, price
- Total: "Итого:", "Всего:", "Сумма:"

## API Endpoints

- `GET /health` - Health check
- `POST /webhook` - Telegram webhook (if configured)

## Monitoring

View logs:
```bash
# Docker
docker-compose logs -f telegram-bot-service

# Direct
tail -f logs/app.log
```

## Troubleshooting

### Bot not responding

1. Check bot token is correct
2. Verify your user ID is in ALLOWED_USER_IDS
3. Check bot is running: `docker-compose ps`
4. View logs for errors

### OCR not working

1. Ensure Tesseract is installed (included in Docker image)
2. Check image quality (must be readable)
3. Verify Russian language data is installed

### Inventory arrival not created

1. Check restaurant-service is running
2. Verify INVENTORY_API_URL is correct
3. Check network connectivity between services
4. View logs for API errors

## Development

### Run tests
```bash
npm test
```

### Type checking
```bash
npm run type-check
```

### Linting
```bash
npm run lint
```

## Security

- Bot validates user IDs before processing any commands
- Invoice photos are stored securely with unique IDs
- No sensitive data is logged
- Environment variables for secrets

## Future Enhancements

- [ ] PDF invoice support
- [ ] Batch invoice processing
- [ ] Invoice editing and correction
- [ ] Supplier management
- [ ] Automatic item matching with existing inventory
- [ ] Email invoice forwarding
- [ ] Invoice approval workflow
- [ ] Analytics and reports
