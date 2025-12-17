// data-collector.js - Collects orderbook slippage data and saves to JSON
// Run: node data-collector.js

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    asset: 'BTC',
    tradeSize: 100000,  // $100,000 USD
    side: 'buy',
    refreshInterval: 30000,  // 30 seconds
    dataFile: 'slippage-data.json',
    maxRecords: 100000  // Keep last 100k records (~35 days at 30s intervals)
};

// Asset mapping
const assetMapping = {
    'BTC': { hl: 'BTC', lighter: 1, aster: 'BTCUSDT', binance: 'BTCUSDT' },
    'ETH': { hl: 'ETH', lighter: 0, aster: 'ETHUSDT', binance: 'ETHUSDT' },
    'SOL': { hl: 'SOL', lighter: 2, aster: 'SOLUSDT', binance: 'SOLUSDT' }
};

// Lighter auth token
const LIGHTER_AUTH_TOKEN = 'ro:113070:single:1791877505:90a116e6a7209c7c8087b0c77ce55c6a6325466c9f7c87c77d20c764de3b38cf';

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
    const marketIndex = assetMapping[asset].lighter;
    const response = await fetch(`https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_index=${marketIndex}`, {
        headers: { 'Accept': 'application/json', 'Authorization': LIGHTER_AUTH_TOKEN }
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    if (!data.asks || !data.bids) throw new Error('Invalid response');
    return {
        bids: data.bids.map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) })).filter(l => l.price > 0).sort((a, b) => b.price - a.price),
        asks: data.asks.map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) })).filter(l => l.price > 0).sort((a, b) => a.price - b.price)
    };
}

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
// SLIPPAGE CALCULATION
// ============================================

function calculateSlippage(orderbook, tradeSize, side) {
    if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
        return { valid: false, midPrice: 0, avgPrice: 0, slippage: 0, slippageBps: 0, filled: 0, levels: 0 };
    }
    
    const bestBid = orderbook.bids[0]?.price || 0;
    const bestAsk = orderbook.asks[0]?.price || 0;
    
    if (bestAsk <= 0 || bestBid <= 0) {
        return { valid: false, midPrice: 0, avgPrice: 0, slippage: 0, slippageBps: 0, filled: 0, levels: 0 };
    }
    
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = ((bestAsk - bestBid) / midPrice) * 100;
    const levels = side === 'buy' ? orderbook.asks : orderbook.bids;
    
    let remaining = tradeSize;
    let totalCost = 0;
    let totalFilled = 0;
    let levelsUsed = 0;
    
    for (const level of levels) {
        if (remaining <= 0) break;
        const fillUsd = Math.min(remaining, level.price * level.size);
        totalCost += fillUsd;
        totalFilled += fillUsd / level.price;
        remaining -= fillUsd;
        levelsUsed++;
    }
    
    if (totalFilled === 0) {
        return { valid: false, midPrice, avgPrice: midPrice, slippage: 0, slippageBps: 0, filled: 0, levels: levelsUsed };
    }
    
    const avgPrice = totalCost / totalFilled;
    const slippage = Math.abs((avgPrice - midPrice) / midPrice * 100);
    const slippageBps = slippage * 100; // Convert to basis points
    
    return {
        valid: true,
        midPrice,
        avgPrice,
        slippage,
        slippageBps,
        spread,
        filled: totalFilled,
        filledUsd: totalCost,
        levels: levelsUsed,
        partialFill: remaining > 0,
        unfilledUsd: remaining
    };
}

// ============================================
// DATA STORAGE
// ============================================

function loadData() {
    try {
        if (fs.existsSync(CONFIG.dataFile)) {
            const content = fs.readFileSync(CONFIG.dataFile, 'utf8');
            return JSON.parse(content);
        }
    } catch (e) {
        console.log(`[WARN] Could not load existing data: ${e.message}`);
    }
    return { records: [], metadata: { created: new Date().toISOString(), config: CONFIG } };
}

function saveData(data) {
    // Keep only last maxRecords
    if (data.records.length > CONFIG.maxRecords) {
        data.records = data.records.slice(-CONFIG.maxRecords);
    }
    data.metadata.lastUpdated = new Date().toISOString();
    data.metadata.totalRecords = data.records.length;
    
    fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data, null, 2));
}

// ============================================
// MAIN COLLECTOR
// ============================================

async function collectData() {
    const timestamp = new Date().toISOString();
    const timestampMs = Date.now();
    
    console.log(`\n[${new Date().toLocaleTimeString()}] Collecting ${CONFIG.asset} data...`);
    
    // Fetch all orderbooks
    const results = {};
    const platforms = ['hyperliquid', 'lighter', 'aster', 'binance'];
    
    const [hl, lt, as, bn] = await Promise.all([
        fetchHyperliquid(CONFIG.asset).catch(e => { console.log(`  [HL] Error: ${e.message}`); return null; }),
        fetchLighter(CONFIG.asset).catch(e => { console.log(`  [LT] Error: ${e.message}`); return null; }),
        fetchAster(CONFIG.asset).catch(e => { console.log(`  [AS] Error: ${e.message}`); return null; }),
        fetchBinance(CONFIG.asset).catch(e => { console.log(`  [BN] Error: ${e.message}`); return null; })
    ]);
    
    // Calculate slippage for each
    const hlSlip = calculateSlippage(hl, CONFIG.tradeSize, CONFIG.side);
    const ltSlip = calculateSlippage(lt, CONFIG.tradeSize, CONFIG.side);
    const asSlip = calculateSlippage(as, CONFIG.tradeSize, CONFIG.side);
    const bnSlip = calculateSlippage(bn, CONFIG.tradeSize, CONFIG.side);
    
    // Determine winner (lowest slippage)
    const validResults = [
        hlSlip.valid && { platform: 'hyperliquid', slippage: hlSlip.slippage },
        ltSlip.valid && { platform: 'lighter', slippage: ltSlip.slippage },
        asSlip.valid && { platform: 'aster', slippage: asSlip.slippage },
        bnSlip.valid && { platform: 'binance', slippage: bnSlip.slippage }
    ].filter(Boolean);
    
    const winner = validResults.length > 0 
        ? validResults.sort((a, b) => a.slippage - b.slippage)[0].platform 
        : null;
    
    // Create record
    const record = {
        timestamp,
        timestampMs,
        asset: CONFIG.asset,
        tradeSize: CONFIG.tradeSize,
        side: CONFIG.side,
        winner,
        validPlatforms: validResults.length,
        hyperliquid: {
            valid: hlSlip.valid,
            midPrice: hlSlip.midPrice,
            avgPrice: hlSlip.avgPrice,
            slippage: hlSlip.slippage,
            slippageBps: hlSlip.slippageBps,
            spread: hlSlip.spread,
            levels: hlSlip.levels,
            filledUsd: hlSlip.filledUsd
        },
        lighter: {
            valid: ltSlip.valid,
            midPrice: ltSlip.midPrice,
            avgPrice: ltSlip.avgPrice,
            slippage: ltSlip.slippage,
            slippageBps: ltSlip.slippageBps,
            spread: ltSlip.spread,
            levels: ltSlip.levels,
            filledUsd: ltSlip.filledUsd
        },
        aster: {
            valid: asSlip.valid,
            midPrice: asSlip.midPrice,
            avgPrice: asSlip.avgPrice,
            slippage: asSlip.slippage,
            slippageBps: asSlip.slippageBps,
            spread: asSlip.spread,
            levels: asSlip.levels,
            filledUsd: asSlip.filledUsd
        },
        binance: {
            valid: bnSlip.valid,
            midPrice: bnSlip.midPrice,
            avgPrice: bnSlip.avgPrice,
            slippage: bnSlip.slippage,
            slippageBps: bnSlip.slippageBps,
            spread: bnSlip.spread,
            levels: bnSlip.levels,
            filledUsd: bnSlip.filledUsd
        }
    };
    
    // Print summary
    console.log(`  Mid Price: $${(hlSlip.midPrice || bnSlip.midPrice || 0).toLocaleString()}`);
    console.log(`  Slippage (bps): HL=${hlSlip.valid ? hlSlip.slippageBps.toFixed(2) : 'N/A'}, LT=${ltSlip.valid ? ltSlip.slippageBps.toFixed(2) : 'N/A'}, AS=${asSlip.valid ? asSlip.slippageBps.toFixed(2) : 'N/A'}, BN=${bnSlip.valid ? bnSlip.slippageBps.toFixed(2) : 'N/A'}`);
    console.log(`  Winner: ${winner ? winner.toUpperCase() : 'N/A'}`);
    
    // Load, append, and save
    const data = loadData();
    data.records.push(record);
    saveData(data);
    
    console.log(`  Saved! Total records: ${data.records.length}`);
}

// ============================================
// STARTUP
// ============================================

console.log(`
╔══════════════════════════════════════════════════════════╗
║         📊 Slippage Data Collector                       ║
╠══════════════════════════════════════════════════════════╣
║  Asset:        ${CONFIG.asset.padEnd(40)}║
║  Trade Size:   $${CONFIG.tradeSize.toLocaleString().padEnd(38)}║
║  Side:         ${CONFIG.side.padEnd(40)}║
║  Interval:     ${(CONFIG.refreshInterval/1000)}s${' '.repeat(37)}║
║  Data File:    ${CONFIG.dataFile.padEnd(40)}║
╚══════════════════════════════════════════════════════════╝
`);

// Run immediately, then on interval
collectData();
setInterval(collectData, CONFIG.refreshInterval);

console.log(`Collector started. Press Ctrl+C to stop.\n`);
