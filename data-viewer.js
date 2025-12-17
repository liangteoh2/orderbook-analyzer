// data-viewer.js - Analyze collected slippage data
// Run: node data-viewer.js [command]
// Commands: summary, winners, hourly, export, last [n]

const fs = require('fs');

const DATA_FILE = 'slippage-data.json';

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        console.log('❌ No data file found. Run data-collector.js first.');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function formatDate(iso) {
    return new Date(iso).toLocaleString();
}

function formatBps(bps) {
    return bps ? bps.toFixed(2) + ' bps' : 'N/A';
}

// ============================================
// COMMANDS
// ============================================

function showSummary(data) {
    const records = data.records;
    const totalRecords = records.length;
    
    if (totalRecords === 0) {
        console.log('No records found.');
        return;
    }
    
    const first = records[0];
    const last = records[records.length - 1];
    
    // Win counts
    const wins = { hyperliquid: 0, lighter: 0, aster: 0, binance: 0 };
    const slippages = { hyperliquid: [], lighter: [], aster: [], binance: [] };
    
    records.forEach(r => {
        if (r.winner) wins[r.winner]++;
        ['hyperliquid', 'lighter', 'aster', 'binance'].forEach(p => {
            if (r[p]?.valid) slippages[p].push(r[p].slippageBps);
        });
    });
    
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b) / arr.length : 0;
    const min = arr => arr.length ? Math.min(...arr) : 0;
    const max = arr => arr.length ? Math.max(...arr) : 0;
    
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                     📊 DATA SUMMARY                              ║
╠══════════════════════════════════════════════════════════════════╣
║  Total Records:    ${totalRecords.toString().padEnd(45)}║
║  First Record:     ${formatDate(first.timestamp).padEnd(45)}║
║  Last Record:      ${formatDate(last.timestamp).padEnd(45)}║
║  Asset:            ${first.asset.padEnd(45)}║
║  Trade Size:       $${first.tradeSize.toLocaleString().padEnd(44)}║
╠══════════════════════════════════════════════════════════════════╣
║                     🏆 WIN COUNTS                                ║
╠══════════════════════════════════════════════════════════════════╣
║  Hyperliquid:      ${wins.hyperliquid.toString().padEnd(10)} (${(wins.hyperliquid/totalRecords*100).toFixed(1)}%)${' '.repeat(28)}║
║  Lighter:          ${wins.lighter.toString().padEnd(10)} (${(wins.lighter/totalRecords*100).toFixed(1)}%)${' '.repeat(28)}║
║  Aster:            ${wins.aster.toString().padEnd(10)} (${(wins.aster/totalRecords*100).toFixed(1)}%)${' '.repeat(28)}║
║  Binance:          ${wins.binance.toString().padEnd(10)} (${(wins.binance/totalRecords*100).toFixed(1)}%)${' '.repeat(28)}║
╠══════════════════════════════════════════════════════════════════╣
║                  📈 SLIPPAGE STATS (bps)                         ║
╠══════════════════════════════════════════════════════════════════╣
║  Platform      │  Avg      │  Min      │  Max      │  Samples    ║
║  ─────────────────────────────────────────────────────────────── ║
║  Hyperliquid   │  ${avg(slippages.hyperliquid).toFixed(2).padEnd(8)} │  ${min(slippages.hyperliquid).toFixed(2).padEnd(8)} │  ${max(slippages.hyperliquid).toFixed(2).padEnd(8)} │  ${slippages.hyperliquid.length.toString().padEnd(10)} ║
║  Lighter       │  ${avg(slippages.lighter).toFixed(2).padEnd(8)} │  ${min(slippages.lighter).toFixed(2).padEnd(8)} │  ${max(slippages.lighter).toFixed(2).padEnd(8)} │  ${slippages.lighter.length.toString().padEnd(10)} ║
║  Aster         │  ${avg(slippages.aster).toFixed(2).padEnd(8)} │  ${min(slippages.aster).toFixed(2).padEnd(8)} │  ${max(slippages.aster).toFixed(2).padEnd(8)} │  ${slippages.aster.length.toString().padEnd(10)} ║
║  Binance       │  ${avg(slippages.binance).toFixed(2).padEnd(8)} │  ${min(slippages.binance).toFixed(2).padEnd(8)} │  ${max(slippages.binance).toFixed(2).padEnd(8)} │  ${slippages.binance.length.toString().padEnd(10)} ║
╚══════════════════════════════════════════════════════════════════╝
`);
}

function showLast(data, n = 10) {
    const records = data.records.slice(-n).reverse();
    
    console.log(`\n📋 Last ${records.length} Records:\n`);
    console.log('Timestamp            │ Winner      │ HL (bps)  │ LT (bps)  │ AS (bps)  │ BN (bps)');
    console.log('─────────────────────┼─────────────┼───────────┼───────────┼───────────┼──────────');
    
    records.forEach(r => {
        const time = new Date(r.timestamp).toLocaleString().padEnd(20);
        const winner = (r.winner || 'N/A').padEnd(11);
        const hl = r.hyperliquid.valid ? r.hyperliquid.slippageBps.toFixed(2).padEnd(9) : 'N/A'.padEnd(9);
        const lt = r.lighter.valid ? r.lighter.slippageBps.toFixed(2).padEnd(9) : 'N/A'.padEnd(9);
        const as = r.aster.valid ? r.aster.slippageBps.toFixed(2).padEnd(9) : 'N/A'.padEnd(9);
        const bn = r.binance.valid ? r.binance.slippageBps.toFixed(2).padEnd(9) : 'N/A'.padEnd(9);
        
        console.log(`${time} │ ${winner} │ ${hl} │ ${lt} │ ${as} │ ${bn}`);
    });
    console.log('');
}

function showHourly(data) {
    const records = data.records;
    const hourlyData = {};
    
    records.forEach(r => {
        const hour = new Date(r.timestamp).toISOString().slice(0, 13) + ':00';
        if (!hourlyData[hour]) {
            hourlyData[hour] = { wins: { hyperliquid: 0, lighter: 0, aster: 0, binance: 0 }, count: 0, slippage: { hyperliquid: [], lighter: [], aster: [], binance: [] } };
        }
        hourlyData[hour].count++;
        if (r.winner) hourlyData[hour].wins[r.winner]++;
        ['hyperliquid', 'lighter', 'aster', 'binance'].forEach(p => {
            if (r[p]?.valid) hourlyData[hour].slippage[p].push(r[p].slippageBps);
        });
    });
    
    console.log('\n📊 Hourly Summary:\n');
    console.log('Hour (UTC)           │ Count │ Winner      │ Avg HL   │ Avg LT   │ Avg AS   │ Avg BN');
    console.log('─────────────────────┼───────┼─────────────┼──────────┼──────────┼──────────┼─────────');
    
    const avg = arr => arr.length ? (arr.reduce((a, b) => a + b) / arr.length).toFixed(2) : 'N/A';
    
    Object.entries(hourlyData).slice(-24).forEach(([hour, d]) => {
        const maxWins = Math.max(d.wins.hyperliquid, d.wins.lighter, d.wins.aster, d.wins.binance);
        const topWinner = Object.entries(d.wins).find(([k, v]) => v === maxWins)?.[0] || 'N/A';
        
        console.log(`${hour.padEnd(20)} │ ${d.count.toString().padEnd(5)} │ ${topWinner.padEnd(11)} │ ${avg(d.slippage.hyperliquid).padEnd(8)} │ ${avg(d.slippage.lighter).padEnd(8)} │ ${avg(d.slippage.aster).padEnd(8)} │ ${avg(d.slippage.binance)}`);
    });
    console.log('');
}

function exportCSV(data) {
    const records = data.records;
    const filename = `slippage-export-${new Date().toISOString().slice(0, 10)}.csv`;
    
    const headers = [
        'timestamp', 'asset', 'tradeSize', 'side', 'winner',
        'hl_valid', 'hl_midPrice', 'hl_slippage', 'hl_slippageBps', 'hl_levels',
        'lt_valid', 'lt_midPrice', 'lt_slippage', 'lt_slippageBps', 'lt_levels',
        'as_valid', 'as_midPrice', 'as_slippage', 'as_slippageBps', 'as_levels',
        'bn_valid', 'bn_midPrice', 'bn_slippage', 'bn_slippageBps', 'bn_levels'
    ];
    
    const rows = records.map(r => [
        r.timestamp, r.asset, r.tradeSize, r.side, r.winner || '',
        r.hyperliquid.valid, r.hyperliquid.midPrice, r.hyperliquid.slippage, r.hyperliquid.slippageBps, r.hyperliquid.levels,
        r.lighter.valid, r.lighter.midPrice, r.lighter.slippage, r.lighter.slippageBps, r.lighter.levels,
        r.aster.valid, r.aster.midPrice, r.aster.slippage, r.aster.slippageBps, r.aster.levels,
        r.binance.valid, r.binance.midPrice, r.binance.slippage, r.binance.slippageBps, r.binance.levels
    ].join(','));
    
    const csv = [headers.join(','), ...rows].join('\n');
    fs.writeFileSync(filename, csv);
    
    console.log(`✅ Exported ${records.length} records to ${filename}`);
}

function showWinners(data) {
    const records = data.records;
    
    // Daily winner breakdown
    const daily = {};
    records.forEach(r => {
        const day = r.timestamp.slice(0, 10);
        if (!daily[day]) daily[day] = { hyperliquid: 0, lighter: 0, aster: 0, binance: 0, total: 0 };
        daily[day].total++;
        if (r.winner) daily[day][r.winner]++;
    });
    
    console.log('\n🏆 Daily Winner Breakdown:\n');
    console.log('Date       │ Total │ Hyperliquid │ Lighter │ Aster │ Binance │ Top Winner');
    console.log('───────────┼───────┼─────────────┼─────────┼───────┼─────────┼───────────');
    
    Object.entries(daily).forEach(([day, d]) => {
        const maxWins = Math.max(d.hyperliquid, d.lighter, d.aster, d.binance);
        const topWinner = Object.entries(d).filter(([k]) => k !== 'total').find(([k, v]) => v === maxWins)?.[0] || 'N/A';
        
        console.log(`${day} │ ${d.total.toString().padEnd(5)} │ ${d.hyperliquid.toString().padEnd(11)} │ ${d.lighter.toString().padEnd(7)} │ ${d.aster.toString().padEnd(5)} │ ${d.binance.toString().padEnd(7)} │ ${topWinner}`);
    });
    console.log('');
}

// ============================================
// MAIN
// ============================================

const args = process.argv.slice(2);
const command = args[0] || 'summary';
const data = loadData();

switch (command) {
    case 'summary':
        showSummary(data);
        break;
    case 'last':
        showLast(data, parseInt(args[1]) || 10);
        break;
    case 'hourly':
        showHourly(data);
        break;
    case 'winners':
        showWinners(data);
        break;
    case 'export':
        exportCSV(data);
        break;
    default:
        console.log(`
Usage: node data-viewer.js [command]

Commands:
  summary     Show overall statistics (default)
  last [n]    Show last n records (default: 10)
  hourly      Show hourly breakdown (last 24h)
  winners     Show daily winner breakdown
  export      Export all data to CSV
`);
}
