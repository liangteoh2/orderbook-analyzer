// server.js - Backend API server with built-in data collector
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
// CONFIGURATION
// ============================================
const assetMapping = {
    'BTC': { hl: 'BTC', lighter: 1, aster: 'BTCUSDT', binance: 'BTCUSDT' },
    'ETH': { hl: 'ETH', lighter: 0, aster: 'ETHUSDT', binance: 'ETHUSDT' },
    'SOL': { hl: 'SOL', lighter: 2, aster: 'SOLUSDT', binance: 'SOLUSDT' }
};

const LIGHTER_AUTH_TOKEN = 'ro:113070:single:1791877505:90a116e6a7209c7c8087b0c77ce55c6a6325466c9f7c87c77d20c764de3b38cf';
const LIGHTER_CACHE_TTL = 10000;
const lighterCache = { BTC: { data: null, timestamp: 0 }, ETH: { data: null, timestamp: 0 }, SOL: { data: null, timestamp: 0 } };

// ============================================
// IN-MEMORY DATA STORAGE (for collection)
// ============================================
const collectedData = {
    records: [],
    config: { asset: 'BTC', tradeSize: 100000, side: 'buy', intervalSec: 5 },
    startedAt: null,
    maxRecords: 100000  // Keep last 100k records (~5.8 days at 5s)
};

// ============================================
// FETCH FUNCTIONS
// ============================================
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

async function fetchLighter(asset) {
    const cached = lighterCache[asset];
    if (cached.data && (Date.now() - cached.timestamp) < LIGHTER_CACHE_TTL) return cached.data;
    
    const marketIndex = assetMapping[asset].lighter;
    const response = await fetch(`https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_index=${marketIndex}`, {
        headers: { 'Accept': 'application/json', 'Authorization': LIGHTER_AUTH_TOKEN }
    });
    
    if (!response.ok) {
        if (response.status === 429 && cached.data) return cached.data;
        throw new Error(`API returned ${response.status}`);
    }
    
    const data = await response.json();
    if (data.asks && data.bids) {
        const result = {
            bids: data.bids.map(l => ({ price: parseFloat(l.price || 0), size: parseFloat(l.size || 0) })).filter(l => l.price > 0).sort((a, b) => b.price - a.price),
            asks: data.asks.map(l => ({ price: parseFloat(l.price || 0), size: parseFloat(l.size || 0) })).filter(l => l.price > 0).sort((a, b) => a.price - b.price)
        };
        if (result.bids.length && result.asks.length) {
            lighterCache[asset] = { data: result, timestamp: Date.now() };
            return result;
        }
    }
    throw new Error('No valid data');
}

async function fetchAster(asset) {
    const response = await fetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${assetMapping[asset].aster}&limit=100`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    if (!data.bids || !data.asks) throw new Error('Invalid response');
    return {
        bids: data.bids.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) })),
        asks: data.asks.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
    };
}

async function fetchBinance(asset) {
    const response = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${assetMapping[asset].binance}&limit=100`);
    const data = await response.json();
    if (!data.bids || !data.asks) throw new Error('Invalid response');
    return {
        bids: data.bids.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) })),
        asks: data.asks.map(l => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
    };
}

// ============================================
// SLIPPAGE CALCULATION
// ============================================
function calcSlippage(ob, size, side) {
    if (!ob?.bids?.length || !ob?.asks?.length) return { valid: false };
    const bestBid = ob.bids[0]?.price || 0, bestAsk = ob.asks[0]?.price || 0;
    if (bestAsk <= 0 || bestBid <= 0) return { valid: false };
    
    const midPrice = (bestBid + bestAsk) / 2;
    const levels = side === 'buy' ? ob.asks : ob.bids;
    let remaining = size, totalCost = 0, totalFilled = 0, levelsUsed = 0;
    
    for (const lvl of levels) {
        if (remaining <= 0) break;
        const fillUsd = Math.min(remaining, lvl.price * lvl.size);
        totalCost += fillUsd; totalFilled += fillUsd / lvl.price; remaining -= fillUsd; levelsUsed++;
    }
    
    if (totalFilled === 0) return { valid: false };
    const avgPrice = totalCost / totalFilled;
    const slippage = Math.abs((avgPrice - midPrice) / midPrice * 100);
    
    return { valid: true, midPrice, avgPrice, slippage, slippageBps: slippage * 100, levels: levelsUsed, filledUsd: totalCost };
}

// ============================================
// DATA COLLECTOR
// ============================================
async function collectDataPoint() {
    const { asset, tradeSize, side } = collectedData.config;
    const timestamp = new Date().toISOString();
    
    const [hl, lt, as, bn] = await Promise.all([
        fetchHyperliquid(asset).catch(() => null),
        fetchLighter(asset).catch(() => null),
        fetchAster(asset).catch(() => null),
        fetchBinance(asset).catch(() => null)
    ]);
    
    const hlSlip = calcSlippage(hl, tradeSize, side);
    const ltSlip = calcSlippage(lt, tradeSize, side);
    const asSlip = calcSlippage(as, tradeSize, side);
    const bnSlip = calcSlippage(bn, tradeSize, side);
    
    const valid = [
        hlSlip.valid && { p: 'hyperliquid', s: hlSlip.slippageBps },
        ltSlip.valid && { p: 'lighter', s: ltSlip.slippageBps },
        asSlip.valid && { p: 'aster', s: asSlip.slippageBps },
        bnSlip.valid && { p: 'binance', s: bnSlip.slippageBps }
    ].filter(Boolean);
    
    const winner = valid.length ? valid.sort((a, b) => a.s - b.s)[0].p : null;
    
    const record = {
        t: timestamp,
        ts: Date.now(),
        w: winner,
        hl: hlSlip.valid ? { m: hlSlip.midPrice, s: hlSlip.slippageBps, l: hlSlip.levels } : null,
        lt: ltSlip.valid ? { m: ltSlip.midPrice, s: ltSlip.slippageBps, l: ltSlip.levels } : null,
        as: asSlip.valid ? { m: asSlip.midPrice, s: asSlip.slippageBps, l: asSlip.levels } : null,
        bn: bnSlip.valid ? { m: bnSlip.midPrice, s: bnSlip.slippageBps, l: bnSlip.levels } : null
    };
    
    collectedData.records.push(record);
    
    // Trim to max records
    if (collectedData.records.length > collectedData.maxRecords) {
        collectedData.records = collectedData.records.slice(-collectedData.maxRecords);
    }
    
    console.log(`[Collector] ${timestamp.slice(11, 19)} | Winner: ${winner || 'N/A'} | HL:${hlSlip.slippageBps?.toFixed(1) || '-'} LT:${ltSlip.slippageBps?.toFixed(1) || '-'} AS:${asSlip.slippageBps?.toFixed(1) || '-'} BN:${bnSlip.slippageBps?.toFixed(1) || '-'} bps | Total: ${collectedData.records.length}`);
}

// Start collector on server start
function startCollector() {
    collectedData.startedAt = new Date().toISOString();
    console.log(`\n📊 Data Collector Started - ${collectedData.config.asset} $${collectedData.config.tradeSize} ${collectedData.config.side} every ${collectedData.config.intervalSec}s\n`);
    
    collectDataPoint(); // Run immediately
    setInterval(collectDataPoint, collectedData.config.intervalSec * 1000);
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        collector: {
            running: !!collectedData.startedAt,
            startedAt: collectedData.startedAt,
            records: collectedData.records.length,
            config: collectedData.config
        }
    });
});

// Main orderbook API (for website)
app.post('/api/orderbook', async (req, res) => {
    const { asset = 'BTC' } = req.body;
    try {
        const [hyperliquid, lighter, aster, binance] = await Promise.all([
            fetchHyperliquid(asset).catch(() => ({ bids: [], asks: [] })),
            fetchLighter(asset).catch(() => ({ bids: [], asks: [] })),
            fetchAster(asset).catch(() => ({ bids: [], asks: [] })),
            fetchBinance(asset).catch(() => ({ bids: [], asks: [] }))
        ]);
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
        const [hl, lt, as, bn] = await Promise.all([
            fetchHyperliquid(asset).catch(() => null),
            fetchLighter(asset).catch(() => null),
            fetchAster(asset).catch(() => null),
            fetchBinance(asset).catch(() => null)
        ]);
        
        const hlR = calcSlippage(hl, tradeSize, side);
        const ltR = calcSlippage(lt, tradeSize, side);
        const asR = calcSlippage(as, tradeSize, side);
        const bnR = calcSlippage(bn, tradeSize, side);
        
        const valid = [hlR.valid && { n: 'Hyperliquid', s: hlR.slippage }, ltR.valid && { n: 'Lighter', s: ltR.slippage }, asR.valid && { n: 'Aster', s: asR.slippage }, bnR.valid && { n: 'Binance', s: bnR.slippage }].filter(Boolean);
        const winner = valid.length ? valid.sort((a, b) => a.s - b.s)[0].n : 'N/A';
        
        res.json({
            timestamp: new Date().toISOString(), asset, tradeSize, side, winner,
            hl_valid: hlR.valid, hl_midPrice: hlR.midPrice || 0, hl_slippage: hlR.slippage || 0, hl_levels: hlR.levels || 0,
            lt_valid: ltR.valid, lt_midPrice: ltR.midPrice || 0, lt_slippage: ltR.slippage || 0, lt_levels: ltR.levels || 0,
            as_valid: asR.valid, as_midPrice: asR.midPrice || 0, as_slippage: asR.slippage || 0, as_levels: asR.levels || 0,
            bn_valid: bnR.valid, bn_midPrice: bnR.midPrice || 0, bn_slippage: bnR.slippage || 0, bn_levels: bnR.levels || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// DATA DOWNLOAD ENDPOINTS
// ============================================

// Get collected data stats
app.get('/api/data/stats', (req, res) => {
    const records = collectedData.records;
    const wins = { hyperliquid: 0, lighter: 0, aster: 0, binance: 0 };
    const slippages = { hyperliquid: [], lighter: [], aster: [], binance: [] };
    
    records.forEach(r => {
        if (r.w) wins[r.w]++;
        if (r.hl) slippages.hyperliquid.push(r.hl.s);
        if (r.lt) slippages.lighter.push(r.lt.s);
        if (r.as) slippages.aster.push(r.as.s);
        if (r.bn) slippages.binance.push(r.bn.s);
    });
    
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b) / arr.length : 0;
    const min = arr => arr.length ? Math.min(...arr) : 0;
    const max = arr => arr.length ? Math.max(...arr) : 0;
    
    res.json({
        totalRecords: records.length,
        startedAt: collectedData.startedAt,
        config: collectedData.config,
        firstRecord: records[0]?.t || null,
        lastRecord: records[records.length - 1]?.t || null,
        wins,
        avgSlippageBps: {
            hyperliquid: avg(slippages.hyperliquid),
            lighter: avg(slippages.lighter),
            aster: avg(slippages.aster),
            binance: avg(slippages.binance)
        },
        minSlippageBps: {
            hyperliquid: min(slippages.hyperliquid),
            lighter: min(slippages.lighter),
            aster: min(slippages.aster),
            binance: min(slippages.binance)
        },
        maxSlippageBps: {
            hyperliquid: max(slippages.hyperliquid),
            lighter: max(slippages.lighter),
            aster: max(slippages.aster),
            binance: max(slippages.binance)
        }
    });
});

// Download all data as JSON
app.get('/api/data/json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=slippage-data-${new Date().toISOString().slice(0, 10)}.json`);
    res.json({
        exportedAt: new Date().toISOString(),
        config: collectedData.config,
        startedAt: collectedData.startedAt,
        totalRecords: collectedData.records.length,
        records: collectedData.records
    });
});

// Download as CSV
app.get('/api/data/csv', (req, res) => {
    const records = collectedData.records;
    
    const headers = 'timestamp,winner,hl_slippage_bps,hl_mid_price,hl_levels,lt_slippage_bps,lt_mid_price,lt_levels,as_slippage_bps,as_mid_price,as_levels,bn_slippage_bps,bn_mid_price,bn_levels';
    
    const rows = records.map(r => [
        r.t,
        r.w || '',
        r.hl?.s || '', r.hl?.m || '', r.hl?.l || '',
        r.lt?.s || '', r.lt?.m || '', r.lt?.l || '',
        r.as?.s || '', r.as?.m || '', r.as?.l || '',
        r.bn?.s || '', r.bn?.m || '', r.bn?.l || ''
    ].join(','));
    
    const csv = [headers, ...rows].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=slippage-data-${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
});

// Get last N records
app.get('/api/data/recent', (req, res) => {
    const n = Math.min(parseInt(req.query.n) || 100, 1000);
    res.json({
        count: n,
        records: collectedData.records.slice(-n)
    });
});

// Serve frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================
// START SERVER + COLLECTOR
// ============================================
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Orderbook Analyzer Server`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`📊 Data endpoints:`);
    console.log(`   GET /api/data/stats  - View statistics`);
    console.log(`   GET /api/data/json   - Download JSON`);
    console.log(`   GET /api/data/csv    - Download CSV`);
    console.log(`   GET /api/data/recent?n=100 - Last N records`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Start the data collector
    startCollector();
});
