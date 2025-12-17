// server.js - Backend API server for orderbook data
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for all origins
app.use(cors());
app.use(express.json());

// Serve static files (the HTML frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Asset mapping - 4 exchanges
const assetMapping = {
    'BTC': { hl: 'BTC', lighter: 1, aster: 'BTCUSDT', binance: 'BTCUSDT' },
    'ETH': { hl: 'ETH', lighter: 0, aster: 'ETHUSDT', binance: 'ETHUSDT' },
    'SOL': { hl: 'SOL', lighter: 2, aster: 'SOLUSDT', binance: 'SOLUSDT' }
};

// In-memory cache for Lighter data (updated via WebSocket)
let lighterCache = {
    BTC: { bids: [], asks: [], lastUpdate: null },
    ETH: { bids: [], asks: [], lastUpdate: null },
    SOL: { bids: [], asks: [], lastUpdate: null }
};

// Lighter WebSocket connection
let lighterWs = null;
let lighterReconnectTimer = null;

function connectLighterWebSocket() {
    if (lighterWs) {
        try { lighterWs.close(); } catch (e) {}
    }
    
    console.log('[Lighter WS] Connecting...');
    
    try {
        lighterWs = new WebSocket('wss://wss.lighter.xyz/v1/stream');
        
        lighterWs.on('open', () => {
            console.log('[Lighter WS] Connected!');
            // Subscribe to all markets
            [0, 1, 2].forEach(marketId => {
                lighterWs.send(JSON.stringify({
                    method: 'subscribe',
                    params: { channel: 'orderbook', market_id: marketId }
                }));
            });
        });
        
        lighterWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.channel === 'orderbook' && msg.data) {
                    const marketId = msg.data.market_id;
                    const asset = marketId === 1 ? 'BTC' : marketId === 0 ? 'ETH' : 'SOL';
                    
                    if (msg.data.bids && msg.data.asks) {
                        lighterCache[asset] = {
                            bids: msg.data.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
                            asks: msg.data.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
                            lastUpdate: Date.now()
                        };
                    }
                }
            } catch (e) {}
        });
        
        lighterWs.on('close', () => {
            console.log('[Lighter WS] Disconnected, reconnecting in 5s...');
            lighterReconnectTimer = setTimeout(connectLighterWebSocket, 5000);
        });
        
        lighterWs.on('error', (err) => {
            console.log('[Lighter WS] Error:', err.message);
        });
    } catch (e) {
        console.log('[Lighter WS] Failed to connect:', e.message);
        lighterReconnectTimer = setTimeout(connectLighterWebSocket, 5000);
    }
}

// Start Lighter WebSocket
connectLighterWebSocket();

// Fetch functions for each exchange
async function fetchHyperliquid(asset) {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: assetMapping[asset].hl })
    });
    const data = await response.json();
    if (!data.levels) throw new Error('Invalid Hyperliquid response');
    return {
        bids: data.levels[0].map(l => ({ price: parseFloat(l.px), size: parseFloat(l.sz) })),
        asks: data.levels[1].map(l => ({ price: parseFloat(l.px), size: parseFloat(l.sz) }))
    };
}

function fetchLighterFromCache(asset) {
    const cached = lighterCache[asset];
    if (cached && cached.bids.length > 0 && cached.lastUpdate && (Date.now() - cached.lastUpdate < 30000)) {
        return { bids: cached.bids, asks: cached.asks };
    }
    return { bids: [], asks: [] };
}

// UPDATED: Aster API URL (changed from perp-api.aster.finance to fapi.asterdex.com)
async function fetchAster(asset) {
    const symbol = assetMapping[asset].aster;
    // Try the new API endpoint first
    const urls = [
        `https://fapi.asterdex.com/fapi/v1/depth?symbol=${symbol}&limit=100`,
        `https://fapi.asterdex.com/fapi/v3/depth?symbol=${symbol}&limit=100`
    ];
    
    let lastError = null;
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'OrderbookAnalyzer/1.0',
                    'Accept': 'application/json'
                }
            });
            if (!response.ok) continue;
            const data = await response.json();
            if (data.bids && data.asks) {
                return {
                    bids: data.bids.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) })),
                    asks: data.asks.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
                };
            }
        } catch (e) {
            lastError = e;
        }
    }
    throw new Error(lastError?.message || 'Aster API unavailable');
}

async function fetchBinance(asset) {
    const symbol = assetMapping[asset].binance;
    const response = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`);
    const data = await response.json();
    if (!data.bids || !data.asks) throw new Error('Invalid Binance response');
    return {
        bids: data.bids.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) })),
        asks: data.asks.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
    };
}

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        lighterConnected: lighterWs?.readyState === WebSocket.OPEN,
        lighterCache: {
            BTC: lighterCache.BTC.lastUpdate ? `${Math.round((Date.now() - lighterCache.BTC.lastUpdate)/1000)}s ago` : 'no data',
            ETH: lighterCache.ETH.lastUpdate ? `${Math.round((Date.now() - lighterCache.ETH.lastUpdate)/1000)}s ago` : 'no data',
            SOL: lighterCache.SOL.lastUpdate ? `${Math.round((Date.now() - lighterCache.SOL.lastUpdate)/1000)}s ago` : 'no data'
        }
    });
});

// Main orderbook API
app.post('/api/orderbook', async (req, res) => {
    const { asset = 'BTC' } = req.body;
    console.log(`[API] Fetching ${asset}...`);
    
    try {
        const [hyperliquid, lighter, aster, binance] = await Promise.all([
            fetchHyperliquid(asset).catch(e => ({ bids: [], asks: [], error: e.message })),
            Promise.resolve(fetchLighterFromCache(asset)),
            fetchAster(asset).catch(e => ({ bids: [], asks: [], error: e.message })),
            fetchBinance(asset).catch(e => ({ bids: [], asks: [], error: e.message }))
        ]);
        
        console.log(`[API] Results - HL: ${hyperliquid.bids?.length || 0} bids, LT: ${lighter.bids?.length || 0} bids, AS: ${aster.bids?.length || 0} bids, BN: ${binance.bids?.length || 0} bids`);
        
        res.json({ success: true, asset, timestamp: new Date().toISOString(), hyperliquid, lighter, aster, binance });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Google Sheets API
app.get('/api/sheets', async (req, res) => {
    const asset = req.query.asset || 'BTC';
    const tradeSize = parseFloat(req.query.tradeSize) || 10000;
    const side = req.query.side || 'buy';
    
    try {
        const [hyperliquid, lighter, aster, binance] = await Promise.all([
            fetchHyperliquid(asset).catch(e => null),
            Promise.resolve(fetchLighterFromCache(asset)),
            fetchAster(asset).catch(e => null),
            fetchBinance(asset).catch(e => null)
        ]);
        
        function calcSlippage(orderbook, size, side) {
            if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
                return { valid: false, midPrice: 0, avgPrice: 0, slippage: 0, filled: 0, levels: 0 };
            }
            const bestBid = orderbook.bids[0]?.price || 0;
            const bestAsk = orderbook.asks[0]?.price || 0;
            if (bestAsk <= 0 || bestBid <= 0) {
                return { valid: false, midPrice: 0, avgPrice: 0, slippage: 0, filled: 0, levels: 0 };
            }
            const midPrice = (bestBid + bestAsk) / 2;
            const levels = side === 'buy' ? orderbook.asks : orderbook.bids;
            let remaining = size, totalCost = 0, totalFilled = 0, levelsUsed = 0;
            for (const level of levels) {
                if (remaining <= 0 || !level?.price || !level?.size) continue;
                const fillUsd = Math.min(remaining, level.price * level.size);
                totalCost += fillUsd;
                totalFilled += fillUsd / level.price;
                remaining -= fillUsd;
                levelsUsed++;
            }
            if (totalFilled === 0) return { valid: false, midPrice, avgPrice: midPrice, slippage: 0, filled: 0, levels: levelsUsed };
            const avgPrice = totalCost / totalFilled;
            const slippage = Math.abs((avgPrice - midPrice) / midPrice * 100);
            return { valid: true, midPrice, avgPrice, slippage, filled: totalFilled, levels: levelsUsed };
        }
        
        const hlResult = calcSlippage(hyperliquid, tradeSize, side);
        const ltResult = calcSlippage(lighter, tradeSize, side);
        const asResult = calcSlippage(aster, tradeSize, side);
        const bnResult = calcSlippage(binance, tradeSize, side);
        
        const validResults = [];
        if (hlResult.valid) validResults.push({ name: 'Hyperliquid', slippage: hlResult.slippage });
        if (ltResult.valid) validResults.push({ name: 'Lighter', slippage: ltResult.slippage });
        if (asResult.valid) validResults.push({ name: 'Aster', slippage: asResult.slippage });
        if (bnResult.valid) validResults.push({ name: 'Binance', slippage: bnResult.slippage });
        
        let winner = 'N/A';
        if (validResults.length > 0) {
            validResults.sort((a, b) => a.slippage - b.slippage);
            winner = validResults[0].name;
        }
        
        const validMids = [hlResult, ltResult, asResult, bnResult].filter(r => r.valid).map(r => r.midPrice);
        const avgMidPrice = validMids.length > 0 ? validMids.reduce((a, b) => a + b, 0) / validMids.length : 0;
        
        res.json({
            timestamp: new Date().toISOString(),
            asset, tradeSize, side, avgMidPrice, winner,
            hl_valid: hlResult.valid, hl_midPrice: hlResult.midPrice, hl_avgExecution: hlResult.avgPrice, hl_slippage: hlResult.slippage, hl_filled: hlResult.filled, hl_levels: hlResult.levels,
            lt_valid: ltResult.valid, lt_midPrice: ltResult.midPrice, lt_avgExecution: ltResult.avgPrice, lt_slippage: ltResult.slippage, lt_filled: ltResult.filled, lt_levels: ltResult.levels,
            as_valid: asResult.valid, as_midPrice: asResult.midPrice, as_avgExecution: asResult.avgPrice, as_slippage: asResult.slippage, as_filled: asResult.filled, as_levels: asResult.levels,
            bn_valid: bnResult.valid, bn_midPrice: bnResult.midPrice, bn_avgExecution: bnResult.avgPrice, bn_slippage: bnResult.slippage, bn_filled: bnResult.filled, bn_levels: bnResult.levels
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Orderbook Analyzer Server`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📡 Running on port ${PORT}`);
    console.log(`🌐 API: /api/orderbook, /api/sheets`);
    console.log(`${'='.repeat(60)}\n`);
});
