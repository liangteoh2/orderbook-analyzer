// server.js - Backend API server for orderbook data
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// ASSET MAPPING - Updated with correct indices
// ============================================
const assetMapping = {
    'BTC': { hl: 'BTC', lighter: 1, aster: 'BTCUSDT', binance: 'BTCUSDT' },
    'ETH': { hl: 'ETH', lighter: 0, aster: 'ETHUSDT', binance: 'ETHUSDT' },
    'SOL': { hl: 'SOL', lighter: 2, aster: 'SOLUSDT', binance: 'SOLUSDT' },
    'DOGE': { hl: 'DOGE', lighter: 3, aster: 'DOGEUSDT', binance: 'DOGEUSDT' },
    'XRP': { hl: 'XRP', lighter: 7, aster: 'XRPUSDT', binance: 'XRPUSDT' },
    'LINK': { hl: 'LINK', lighter: 8, aster: 'LINKUSDT', binance: 'LINKUSDT' },
    'AVAX': { hl: 'AVAX', lighter: 9, aster: 'AVAXUSDT', binance: 'AVAXUSDT' }
};

// ============================================
// LIGHTER CONFIG - Premium API
// ============================================
const LIGHTER_AUTH_TOKEN = 'ro:113070:single:1791877505:90a116e6a7209c7c8087b0c77ce55c6a6325466c9f7c87c77d20c764de3b38cf';
const LIGHTER_CACHE_TTL = 5000; // 5 seconds cache (reduced since you have Premium)
const lighterCache = {};

// Rate limit tracking
const rateLimitStats = {
    lighter: { limit: null, remaining: null, reset: null, lastUpdate: null }
};

// ============================================
// FETCH FUNCTIONS
// ============================================

// Hyperliquid - REST API
async function fetchHyperliquid(asset) {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: assetMapping[asset].hl })
    });
    const data = await response.json();
    if (!data.levels) throw new Error('Invalid response');
    return {
        bids: data.levels[0].map(l => ({ price: parseFloat(l.px), size: parseFloat(l.sz) })),
        asks: data.levels[1].map(l => ({ price: parseFloat(l.px), size: parseFloat(l.sz) }))
    };
}

// Lighter - REST API with Premium support
async function fetchLighter(asset) {
    // Check cache first
    const cached = lighterCache[asset];
    if (cached && (Date.now() - cached.timestamp) < LIGHTER_CACHE_TTL) {
        console.log(`[LT] Cache hit for ${asset}`);
        return cached.data;
    }
    
    const marketIndex = assetMapping[asset].lighter;
    const url = `https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_index=${marketIndex}`;
    
    console.log(`[LT] Fetching ${asset} (market_index=${marketIndex})...`);
    
    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Authorization': LIGHTER_AUTH_TOKEN
            }
        });
        
        // Track rate limits
        rateLimitStats.lighter = {
            limit: response.headers.get('x-ratelimit-limit') || response.headers.get('X-RateLimit-Limit'),
            remaining: response.headers.get('x-ratelimit-remaining') || response.headers.get('X-RateLimit-Remaining'),
            reset: response.headers.get('x-ratelimit-reset') || response.headers.get('X-RateLimit-Reset'),
            lastUpdate: new Date().toISOString()
        };
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[LT] HTTP ${response.status}: ${errorText}`);
            
            // If rate limited (shouldn't happen with Premium), use cache
            if (response.status === 429 && cached) {
                console.log(`[LT] Rate limited, using cached data`);
                return cached.data;
            }
            throw new Error(`API returned ${response.status}`);
        }
        
        const data = await response.json();
        
        // Parse orderbook data - handle multiple possible formats
        let bids = data.bids || data.bid || [];
        let asks = data.asks || data.ask || [];
        
        console.log(`[LT] Raw data: ${bids.length} bids, ${asks.length} asks`);
        
        if (bids.length === 0 || asks.length === 0) {
            console.error(`[LT] Empty orderbook. Sample response:`, JSON.stringify(data).substring(0, 300));
            throw new Error('Empty orderbook data');
        }
        
        const result = {
            bids: bids
                .map(l => ({
                    price: parseFloat(l.price || l.Price || l[0] || 0),
                    size: parseFloat(l.size || l.Size || l.quantity || l[1] || 0)
                }))
                .filter(l => l.price > 0 && l.size > 0)
                .sort((a, b) => b.price - a.price),
            asks: asks
                .map(l => ({
                    price: parseFloat(l.price || l.Price || l[0] || 0),
                    size: parseFloat(l.size || l.Size || l.quantity || l[1] || 0)
                }))
                .filter(l => l.price > 0 && l.size > 0)
                .sort((a, b) => a.price - b.price)
        };
        
        if (result.bids.length === 0 || result.asks.length === 0) {
            throw new Error('No valid price levels after parsing');
        }
        
        console.log(`[LT] Parsed: ${result.bids.length} bids, ${result.asks.length} asks | Best bid: $${result.bids[0].price.toFixed(2)}, Best ask: $${result.asks[0].price.toFixed(2)}`);
        console.log(`[LT] Rate limit: ${rateLimitStats.lighter.remaining}/${rateLimitStats.lighter.limit}`);
        
        // Cache the result
        lighterCache[asset] = { data: result, timestamp: Date.now() };
        
        return result;
        
    } catch (error) {
        console.error(`[LT] Error: ${error.message}`);
        
        // Return stale cache if available
        if (cached) {
            console.log(`[LT] Using stale cache due to error`);
            return cached.data;
        }
        
        throw error;
    }
}

// Aster - REST API
async function fetchAster(asset) {
    const symbol = assetMapping[asset].aster;
    const response = await fetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${symbol}&limit=100`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    if (!data.bids || !data.asks) throw new Error('Invalid response');
    return {
        bids: data.bids.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) })),
        asks: data.asks.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
    };
}

// Binance Futures - REST API
async function fetchBinance(asset) {
    const symbol = assetMapping[asset].binance;
    const response = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`);
    const data = await response.json();
    if (!data.bids || !data.asks) throw new Error('Invalid response');
    return {
        bids: data.bids.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) })),
        asks: data.asks.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
    };
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        lighterCacheTTL: LIGHTER_CACHE_TTL + 'ms',
        lighterRateLimit: rateLimitStats.lighter,
        isPremium: rateLimitStats.lighter.limit && parseInt(rateLimitStats.lighter.limit) > 1000
    });
});

app.post('/api/orderbook', async (req, res) => {
    const { asset = 'BTC' } = req.body;
    const startTime = Date.now();
    console.log(`\n[API] Fetching ${asset}...`);
    
    try {
        const [hyperliquid, lighter, aster, binance] = await Promise.all([
            fetchHyperliquid(asset).catch(e => { console.log(`[HL] ${e.message}`); return { bids: [], asks: [] }; }),
            fetchLighter(asset).catch(e => { console.log(`[LT] ${e.message}`); return { bids: [], asks: [] }; }),
            fetchAster(asset).catch(e => { console.log(`[AS] ${e.message}`); return { bids: [], asks: [] }; }),
            fetchBinance(asset).catch(e => { console.log(`[BN] ${e.message}`); return { bids: [], asks: [] }; })
        ]);
        
        console.log(`[API] HL:${hyperliquid.bids?.length||0}, LT:${lighter.bids?.length||0}, AS:${aster.bids?.length||0}, BN:${binance.bids?.length||0} (${Date.now()-startTime}ms)`);
        
        res.json({ 
            success: true, 
            asset, 
            timestamp: new Date().toISOString(), 
            hyperliquid, 
            lighter, 
            aster, 
            binance,
            rateLimits: rateLimitStats
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/sheets', async (req, res) => {
    const asset = req.query.asset || 'BTC';
    const tradeSize = parseFloat(req.query.tradeSize) || 10000;
    const side = req.query.side || 'buy';
    
    try {
        const [hyperliquid, lighter, aster, binance] = await Promise.all([
            fetchHyperliquid(asset).catch(() => null),
            fetchLighter(asset).catch(() => null),
            fetchAster(asset).catch(() => null),
            fetchBinance(asset).catch(() => null)
        ]);
        
        function calcSlippage(ob, size, side) {
            if (!ob?.bids?.length || !ob?.asks?.length) return { valid: false, midPrice: 0, avgPrice: 0, slippage: 0, filled: 0, levels: 0 };
            const bestBid = ob.bids[0]?.price || 0, bestAsk = ob.asks[0]?.price || 0;
            if (bestAsk <= 0 || bestBid <= 0) return { valid: false, midPrice: 0, avgPrice: 0, slippage: 0, filled: 0, levels: 0 };
            const midPrice = (bestBid + bestAsk) / 2, levels = side === 'buy' ? ob.asks : ob.bids;
            let remaining = size, totalCost = 0, totalFilled = 0, levelsUsed = 0;
            for (const lvl of levels) {
                if (remaining <= 0) break;
                const fillUsd = Math.min(remaining, lvl.price * lvl.size);
                totalCost += fillUsd; totalFilled += fillUsd / lvl.price; remaining -= fillUsd; levelsUsed++;
            }
            if (totalFilled === 0) return { valid: false, midPrice, avgPrice: midPrice, slippage: 0, filled: 0, levels: levelsUsed };
            const avgPrice = totalCost / totalFilled;
            return { valid: true, midPrice, avgPrice, slippage: Math.abs((avgPrice - midPrice) / midPrice * 100), filled: totalFilled, levels: levelsUsed };
        }
        
        const hl = calcSlippage(hyperliquid, tradeSize, side);
        const lt = calcSlippage(lighter, tradeSize, side);
        const as = calcSlippage(aster, tradeSize, side);
        const bn = calcSlippage(binance, tradeSize, side);
        
        const valid = [hl.valid && { name: 'Hyperliquid', s: hl.slippage }, lt.valid && { name: 'Lighter', s: lt.slippage }, as.valid && { name: 'Aster', s: as.slippage }, bn.valid && { name: 'Binance', s: bn.slippage }].filter(Boolean);
        const winner = valid.length ? valid.sort((a, b) => a.s - b.s)[0].name : 'N/A';
        const mids = [hl, lt, as, bn].filter(r => r.valid).map(r => r.midPrice);
        const avgMid = mids.length ? mids.reduce((a, b) => a + b) / mids.length : 0;
        
        res.json({
            timestamp: new Date().toISOString(), asset, tradeSize, side, avgMidPrice: avgMid, winner,
            hl_valid: hl.valid, hl_midPrice: hl.midPrice, hl_avgExecution: hl.avgPrice, hl_slippage: hl.slippage, hl_filled: hl.filled, hl_levels: hl.levels,
            lt_valid: lt.valid, lt_midPrice: lt.midPrice, lt_avgExecution: lt.avgPrice, lt_slippage: lt.slippage, lt_filled: lt.filled, lt_levels: lt.levels,
            as_valid: as.valid, as_midPrice: as.midPrice, as_avgExecution: as.avgPrice, as_slippage: as.slippage, as_filled: as.filled, as_levels: as.levels,
            bn_valid: bn.valid, bn_midPrice: bn.midPrice, bn_avgExecution: bn.avgPrice, bn_slippage: bn.slippage, bn_filled: bn.filled, bn_levels: bn.levels,
            rateLimits: rateLimitStats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint to test Lighter directly
app.get('/api/test-lighter', async (req, res) => {
    const asset = req.query.asset || 'BTC';
    const marketIndex = assetMapping[asset]?.lighter;
    
    if (!marketIndex && marketIndex !== 0) {
        return res.status(400).json({ error: `Unknown asset: ${asset}` });
    }
    
    const url = `https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_index=${marketIndex}`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Authorization': LIGHTER_AUTH_TOKEN
            }
        });
        
        const data = await response.json();
        
        res.json({
            success: response.ok,
            asset,
            marketIndex,
            url,
            status: response.status,
            rateLimit: {
                limit: response.headers.get('x-ratelimit-limit'),
                remaining: response.headers.get('x-ratelimit-remaining'),
                reset: response.headers.get('x-ratelimit-reset')
            },
            isPremium: parseInt(response.headers.get('x-ratelimit-limit')) > 1000,
            rawData: data,
            dataKeys: Object.keys(data),
            bidCount: (data.bids || data.bid || []).length,
            askCount: (data.asks || data.ask || []).length,
            sampleBid: (data.bids || data.bid || [])[0],
            sampleAsk: (data.asks || data.ask || [])[0]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// Rate limit monitoring endpoint
app.get('/api/rate-limits', (req, res) => {
    res.json(rateLimitStats);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Orderbook Analyzer - Lighter Premium Edition`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`⏱️  Lighter cache: ${LIGHTER_CACHE_TTL/1000}s`);
    console.log(`🔑 Lighter Premium: ENABLED (24k req/min)`);
    console.log(`${'='.repeat(60)}\n`);
});
