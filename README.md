# Orderbook Depth & Slippage Analyzer

Multi-exchange orderbook analyzer comparing Hyperliquid, Lighter, Aster, and Binance Futures.

## Features
- Real-time slippage comparison
- Live auto-refresh (5s - 5min intervals)
- Fee tier display (Retail / MM)
- Win counter tracking
- Depth analysis
- Google Sheets integration

## Deployment

### Railway (Recommended)
1. Push to GitHub
2. Connect Railway to your repo
3. Deploy automatically

### Manual
```bash
npm install
npm start
```

## API Endpoints
- `GET /` - Frontend
- `POST /api/orderbook` - Get orderbook data
- `GET /api/sheets` - Google Sheets API
- `GET /health` - Health check
