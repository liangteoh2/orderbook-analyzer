// server.js - Backend API server for orderbook data
// Using REST APIs for ALL exchanges (more reliable than WebSocket)
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Asset mapping - market_index for Lighter: ETH=0, BTC=1, SOL=2
const assetMapping = {
    'BTC': { hl: 'BTC', lighter: 1, aster: 'BTCUSDT', binance: 'BTCUSDT' },
    'ETH': { hl: 'ETH', lighter: 0, aster: 'ETHUSDT', binance: 'ETHUSDT' },
    'SOL': { hl: 'SOL', lighter: 2, aster: 'SOLUSDT', binance: 'SOLUSDT' }
};

// ============================================
// FETCH FUNCTIONS - ALL USING REST APIs
// ============================================

// Hyperliquid - REST API
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

// Lighter - REST API (using correct parameter: market_index)
async function fetchLighter(asset) {
    const marketIndex = assetMapping[asset].lighter;
    
    // Try orderBookDetails endpoint first (has aggregated bids/asks)
    const endpoints = [
        `https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_index=${marketIndex}`,
        `https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_index=${marketIndex}`
    ];
    
    let lastError = null;
    
    for (const url of endpoints) {
        try {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'OrderbookAnalyzer/1.0'
                }
            });
            
            if (!response.ok) {
                lastError = new Error(`Lighter API returned ${response.status}`);
                continue;
            }
            
            const data = await response.json();
            
            // orderBookDetails format: { asks: [{price, size}], bids: [{price, size}] }
            if (data.asks && data.bids && Array.isArray(data.asks) && Array.isArray(data.bids)) {
                const bids = data.bids
                    .map(l => ({ 
                        price: parseFloat(l.price || l.px || 0), 
                        size: parseFloat(l.size || l.sz || l.remaining_base_amount || 0) 
                    }))
                    .filter(l => l.price > 0 && l.size > 0)
                    .sort((a, b) => b.price - a.price);
                
                const asks = data.asks
                    .map(l => ({ 
                        price: parseFloat(l.price || l.px || 0), 
                        size: parseFloat(l.size || l.sz || l.remaining_base_amount || 0) 
                    }))
                    .filter(l => l.price > 0 && l.size > 0)
                    .sort((a, b) => a.price - b.price);
                
                if (bids.length > 0 && asks.length > 0) {
                    return { bids, asks };
                }
            }
            
            // orderBookOrders format might be different - try alternative parsing
            if (data.orders && Array.isArray(data.orders)) {
                const bids = data.orders
                    .filter(o => !o.is_ask)
                    .map(o => ({ price: parseFloat(o.price), size: parseFloat(o.remaining_base_amount || o.size) }))
                    .filter(l => l.price > 0 && l.size > 0)
                    .sort((a, b) => b.price - a.price);
                
                const asks = data.orders
                    .filter(o => o.is_ask)
                    .map(o => ({ price: parseFloat(o.price), size: parseFloat(o.remaining_base_amount || o.size) }))
                    .filter(l => l.price > 0 && l.size > 0)
                    .sort((a, b) => a.price - b.price);
                
                if (bids.length > 0 && asks.length > 0) {
                    return { bids, asks };
                }
            }
            
        } catch (e) {
            lastError = e;
        }
    }
    
    throw lastError || new Error('No valid data from Lighter');
}

// Aster - REST API (updated URL)
async function fetchAster(asset) {
    const symbol = assetMapping[asset].aster;
    const urls = [
        `https://fapi.asterdex.com/fapi/v1/depth?symbol=${symbol}&limit=100`,
        `https://fapi.asterdex.com/fapi/v3/depth?symbol=${symbol}&limit=100`
    ];
    
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'OrderbookAnalyzer/1.0', 'Accept': 'application/json' }
            });
            if (!response.ok) continue;
            const data = await response.json();
            if (data.bids && data.asks) {
                return {
                    bids: data.bids.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) })),
                    asks: data.asks.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
                };
            }
        } catch (e) { continue; }
    }
    throw new Error('Aster API unavailable');
}

// Binance Futures - REST API
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

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/health', async (req, res) => {
    let lighterStatus = 'unknown';
    try {
        const response = await fetch('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
        lighterStatus = response.ok ? 'ok' : `error: ${response.status}`;
    } catch (e) {
        lighterStatus = 'error: ' + e.message;
    }
    
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        method: 'REST API (no WebSocket)',
        lighter: lighterStatus
    });
});

// Main orderbook API
app.post('/api/orderbook', async (req, res) => {
    const { asset = 'BTC' } = req.body;
    const startTime = Date.now();
    console.log(`\n[API] Fetching ${asset}...`);
    
    try {
        const [hyperliquid, lighter, aster, binance] = await Promise.all([
            fetchHyperliquid(asset).catch(e => { console.log(`[HL] Error: ${e.message}`); return { bids: [], asks: [], error: e.message }; }),
            fetchLighter(asset).catch(e => { console.log(`[LT] Error: ${e.message}`); return { bids: [], asks: [], error: e.message }; }),
            fetchAster(asset).catch(e => { console.log(`[AS] Error: ${e.message}`); return { bids: [], asks: [], error: e.message }; }),
            fetchBinance(asset).catch(e => { console.log(`[BN] Error: ${e.message}`); return { bids: [], asks: [], error: e.message }; })
        ]);
        
        const fetchTime = Date.now() - startTime;
        console.log(`[API] HL: ${hyperliquid.bids?.length || 0}, LT: ${lighter.bids?.length || 0}, AS: ${aster.bids?.length || 0}, BN: ${binance.bids?.length || 0} bids (${fetchTime}ms)`);
        
        res.json({ 
            success: true, 
            asset, 
            timestamp: new Date().toISOString(), 
            fetchTimeMs: fetchTime,
            hyperliquid, 
            lighter, 
            aster, 
            binance 
        });
    } catch (error) {
        console.error(`[API] Error: ${error.message}`);
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
            fetchLighter(asset).catch(e => null),
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
    console.log(`🚀 Orderbook Analyzer Server (REST API Mode)`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔗 Method: Pure REST API (no WebSocket)`);
    console.log(`📊 Exchanges: Hyperliquid, Lighter, Aster, Binance`);
    console.log(`${'='.repeat(60)}\n`);
});
