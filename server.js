/**
 * Improved Orderbook API Server
 * Uses TCOE's approach: Direct REST API calls to all exchanges
 * No WebSocket dependency, no file cache issues
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3001;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// =============================================================================
// CONFIGURATION
// =============================================================================

// Asset mapping for different exchanges
const ASSET_CONFIG = {
    'BTC': {
        hyperliquid: 'BTC',
        lighter_market_id: 1,     // BTC-PERP market ID on Lighter
        aster: 'BTCUSDT',
        binance: 'BTCUSDT'
    },
    'ETH': {
        hyperliquid: 'ETH',
        lighter_market_id: 0,     // ETH-PERP market ID on Lighter  
        aster: 'ETHUSDT',
        binance: 'ETHUSDT'
    },
    'SOL': {
        hyperliquid: 'SOL',
        lighter_market_id: 2,     // SOL-PERP market ID on Lighter
        aster: 'SOLUSDT',
        binance: 'SOLUSDT'
    },
    'ARB': {
        hyperliquid: 'ARB',
        lighter_market_id: 50,    // ARB-PERP market ID on Lighter
        aster: 'ARBUSDT',
        binance: 'ARBUSDT'
    },
    'AVAX': {
        hyperliquid: 'AVAX',
        lighter_market_id: 9,     // AVAX-PERP market ID on Lighter
        aster: 'AVAXUSDT',
        binance: 'AVAXUSDT'
    }
};

// API Endpoints
const ENDPOINTS = {
    hyperliquid: 'https://api.hyperliquid.xyz/info',
    lighter: 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails',
    aster: 'https://fapi.asterdex.com/fapi/v1/depth',
    binance: 'https://fapi.binance.com/fapi/v1/depth'
};

// =============================================================================
// HYPERLIQUID API
// =============================================================================

async function fetchHyperliquid(asset) {
    try {
        const coin = ASSET_CONFIG[asset].hyperliquid;
        
        const response = await fetch(ENDPOINTS.hyperliquid, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                type: 'l2Book', 
                coin: coin 
            })
        });
        
        if (!response.ok) {
            throw new Error(`Hyperliquid API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Parse response (handle different formats)
        let bids, asks;
        
        if (data.levels && Array.isArray(data.levels) && data.levels.length === 2) {
            bids = data.levels[0] || [];
            asks = data.levels[1] || [];
        } else if (Array.isArray(data) && data.length === 2) {
            bids = data[0] || [];
            asks = data[1] || [];
        } else {
            throw new Error('Unexpected Hyperliquid response format');
        }
        
        // Convert to standard format
        const orderbook = {
            bids: bids.map(level => ({ 
                price: parseFloat(level.px), 
                size: parseFloat(level.sz)
            })),
            asks: asks.map(level => ({ 
                price: parseFloat(level.px), 
                size: parseFloat(level.sz)
            })),
            timestamp: Date.now()
        };
        
        return orderbook;
        
    } catch (error) {
        console.error(`❌ Hyperliquid error (${asset}):`, error.message);
        throw error;
    }
}

// =============================================================================
// LIGHTER API (TCOE's Approach - Direct REST)
// =============================================================================

async function fetchLighter(asset) {
    try {
        const marketId = ASSET_CONFIG[asset].lighter_market_id;
        const url = `${ENDPOINTS.lighter}?market_id=${marketId}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Lighter API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Lighter API returns order book in their format
        // Response structure: { bids: [[price, size], ...], asks: [[price, size], ...] }
        
        if (!data.bids || !data.asks) {
            throw new Error('Invalid Lighter response: missing bids/asks');
        }
        
        // Convert to standard format
        const orderbook = {
            bids: data.bids.map(level => ({
                price: parseFloat(level[0]),
                size: parseFloat(level[1])
            })),
            asks: data.asks.map(level => ({
                price: parseFloat(level[0]),
                size: parseFloat(level[1])
            })),
            timestamp: Date.now()
        };
        
        // Validate orderbook
        if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
            throw new Error('Empty orderbook from Lighter');
        }
        
        const bestBid = orderbook.bids[0].price;
        const bestAsk = orderbook.asks[0].price;
        
        if (bestBid >= bestAsk) {
            throw new Error(`Crossed orderbook: bid ${bestBid} >= ask ${bestAsk}`);
        }
        
        return orderbook;
        
    } catch (error) {
        console.error(`❌ Lighter error (${asset}):`, error.message);
        throw error;
    }
}

// =============================================================================
// ASTER API
// =============================================================================

async function fetchAster(asset) {
    try {
        const symbol = ASSET_CONFIG[asset].aster;
        const url = `${ENDPOINTS.aster}?symbol=${symbol}&limit=100`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error(`Aster API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Aster uses Binance-compatible format
        const orderbook = {
            bids: (data.bids || []).map(level => ({
                price: parseFloat(level[0]),
                size: parseFloat(level[1])
            })),
            asks: (data.asks || []).map(level => ({
                price: parseFloat(level[0]),
                size: parseFloat(level[1])
            })),
            timestamp: Date.now()
        };
        
        return orderbook;
        
    } catch (error) {
        console.error(`❌ Aster error (${asset}):`, error.message);
        throw error;
    }
}

// =============================================================================
// BINANCE API (Optional - for comparison)
// =============================================================================

async function fetchBinance(asset) {
    try {
        const symbol = ASSET_CONFIG[asset].binance;
        const url = `${ENDPOINTS.binance}?symbol=${symbol}&limit=100`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error(`Binance API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        const orderbook = {
            bids: (data.bids || []).map(level => ({
                price: parseFloat(level[0]),
                size: parseFloat(level[1])
            })),
            asks: (data.asks || []).map(level => ({
                price: parseFloat(level[0]),
                size: parseFloat(level[1])
            })),
            timestamp: Date.now()
        };
        
        return orderbook;
        
    } catch (error) {
        console.error(`❌ Binance error (${asset}):`, error.message);
        throw error;
    }
}

// =============================================================================
// MAIN API ENDPOINT (TCOE's Synchronized Approach)
// =============================================================================

app.post('/api/orderbook', async (req, res) => {
    const { asset = 'BTC' } = req.body;
    const startTime = Date.now();
    
    // Validate asset
    if (!ASSET_CONFIG[asset]) {
        return res.status(400).json({
            success: false,
            error: `Invalid asset: ${asset}. Valid assets: ${Object.keys(ASSET_CONFIG).join(', ')}`
        });
    }
    
    console.log(`\n📊 Fetching orderbook data for ${asset}...`);
    
    try {
        // TCOE's Approach: Fetch all exchanges SIMULTANEOUSLY
        // This ensures all data is from approximately the same moment
        const [hyperliquid, lighter, aster] = await Promise.all([
            fetchHyperliquid(asset).catch(err => ({ error: err.message })),
            fetchLighter(asset).catch(err => ({ error: err.message })),
            fetchAster(asset).catch(err => ({ error: err.message }))
        ]);
        
        const fetchDuration = Date.now() - startTime;
        
        // Log results
        if (!hyperliquid.error) {
            console.log(`✓ Hyperliquid: ${hyperliquid.bids.length} bids, ${hyperliquid.asks.length} asks`);
        } else {
            console.log(`✗ Hyperliquid: ${hyperliquid.error}`);
        }
        
        if (!lighter.error) {
            console.log(`✓ Lighter: ${lighter.bids.length} bids, ${lighter.asks.length} asks`);
        } else {
            console.log(`✗ Lighter: ${lighter.error}`);
        }
        
        if (!aster.error) {
            console.log(`✓ Aster: ${aster.bids.length} bids, ${aster.asks.length} asks`);
        } else {
            console.log(`✗ Aster: ${aster.error}`);
        }
        
        console.log(`⏱️  Fetch completed in ${fetchDuration}ms`);
        
        // Return results
        res.json({
            success: true,
            asset: asset,
            timestamp: startTime,
            fetch_duration_ms: fetchDuration,
            exchanges: {
                hyperliquid: hyperliquid.error ? { error: hyperliquid.error } : hyperliquid,
                lighter: lighter.error ? { error: lighter.error } : lighter,
                aster: aster.error ? { error: aster.error } : aster
            }
        });
        
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        supported_assets: Object.keys(ASSET_CONFIG),
        endpoints: {
            hyperliquid: ENDPOINTS.hyperliquid,
            lighter: ENDPOINTS.lighter,
            aster: ENDPOINTS.aster,
            binance: ENDPOINTS.binance
        }
    });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(70));
    console.log('🚀 Improved Orderbook API Server (TCOE Approach)');
    console.log('='.repeat(70));
    console.log(`📡 Local:   http://localhost:${PORT}`);
    console.log(`🌐 Network: http://0.0.0.0:${PORT}`);
    console.log(`📊 Health:  http://localhost:${PORT}/health`);
    console.log(`📡 API:     POST http://localhost:${PORT}/api/orderbook`);
    console.log('='.repeat(70));
    console.log('\n💡 Benefits of TCOE Approach:');
    console.log('   ✅ All exchanges fetched SIMULTANEOUSLY');
    console.log('   ✅ Direct REST API calls (no WebSocket dependency)');
    console.log('   ✅ No file cache corruption issues');
    console.log('   ✅ Validated data before serving');
    console.log('   ✅ Consistent timestamps across exchanges');
    console.log('\n' + '='.repeat(70) + '\n');
});
