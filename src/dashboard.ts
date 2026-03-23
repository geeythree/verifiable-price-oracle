// Inline HTML dashboard — no external dependencies
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verifiable Price Oracle — EigenCompute TEE</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0a0f; color: #e0e0e0; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  header { text-align: center; padding: 30px 0 20px; border-bottom: 1px solid #1a1a2e; margin-bottom: 24px; }
  header h1 { font-size: 1.6em; color: #00d4ff; letter-spacing: 2px; }
  header .subtitle { color: #666; font-size: 0.85em; margin-top: 6px; }
  .tee-badge { display: inline-block; background: #0d2818; color: #00ff88; border: 1px solid #00ff8844; padding: 4px 12px; border-radius: 4px; font-size: 0.75em; margin-top: 10px; }

  .status-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .status-card { background: #12121f; border: 1px solid #1a1a2e; border-radius: 8px; padding: 14px; }
  .status-card .label { color: #666; font-size: 0.7em; text-transform: uppercase; letter-spacing: 1px; }
  .status-card .value { color: #00d4ff; font-size: 1.1em; margin-top: 4px; word-break: break-all; }
  .status-card .value.green { color: #00ff88; }
  .status-card .value.yellow { color: #ffaa00; }
  .status-card .value.red { color: #ff4444; }

  h2 { color: #888; font-size: 0.9em; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; }
  .section { margin-bottom: 28px; }

  .price-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  .price-card { background: #12121f; border: 1px solid #1a1a2e; border-radius: 8px; padding: 16px; transition: border-color 0.3s; }
  .price-card:hover { border-color: #00d4ff44; }
  .price-card .asset-name { font-size: 1.1em; color: #fff; text-transform: capitalize; }
  .price-card .price { font-size: 1.8em; color: #00d4ff; margin: 8px 0; }
  .price-card .meta { font-size: 0.75em; color: #666; }
  .price-card .sources { margin-top: 10px; }
  .source-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 0.8em; border-bottom: 1px solid #1a1a2e; }
  .source-row .name { color: #888; }
  .source-row .val { color: #ccc; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 0.7em; margin-left: 6px; }
  .badge.ok { background: #0d2818; color: #00ff88; }
  .badge.warn { background: #2d1f00; color: #ffaa00; }
  .badge.low { background: #2d0000; color: #ff4444; }

  .attestation-table { width: 100%; border-collapse: collapse; font-size: 0.8em; }
  .attestation-table th { text-align: left; color: #666; padding: 8px; border-bottom: 1px solid #1a1a2e; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1px; }
  .attestation-table td { padding: 8px; border-bottom: 1px solid #0f0f1a; color: #ccc; }
  .attestation-table tr:hover { background: #14142a; }
  .hash { color: #00d4ff; font-size: 0.85em; }

  .verify-section { background: #12121f; border: 1px solid #1a1a2e; border-radius: 8px; padding: 20px; }
  .verify-section textarea { width: 100%; background: #0a0a0f; border: 1px solid #1a1a2e; color: #e0e0e0; padding: 10px; border-radius: 4px; font-family: inherit; font-size: 0.85em; resize: vertical; margin-top: 8px; }
  .verify-section button { background: #00d4ff; color: #0a0a0f; border: none; padding: 8px 20px; border-radius: 4px; cursor: pointer; font-family: inherit; font-weight: bold; margin-top: 10px; }
  .verify-section button:hover { background: #00b8e6; }
  .verify-result { margin-top: 12px; padding: 10px; border-radius: 4px; font-size: 0.85em; display: none; }
  .verify-result.valid { background: #0d2818; color: #00ff88; border: 1px solid #00ff8844; display: block; }
  .verify-result.invalid { background: #2d0000; color: #ff4444; border: 1px solid #ff444444; display: block; }

  .refresh-info { text-align: center; color: #444; font-size: 0.75em; margin-top: 20px; }
  footer { text-align: center; color: #333; font-size: 0.7em; padding: 20px 0; border-top: 1px solid #1a1a2e; margin-top: 30px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>VERIFIABLE PRICE ORACLE</h1>
    <div class="subtitle">Tamper-proof price feeds from inside a Trusted Execution Environment</div>
    <div class="tee-badge">EigenCompute TEE (AMD SEV-SNP)</div>
  </header>

  <div class="status-bar" id="status-bar">
    <div class="status-card"><div class="label">Status</div><div class="value" id="s-status">Loading...</div></div>
    <div class="status-card"><div class="label">TEE Wallet</div><div class="value" id="s-wallet">—</div></div>
    <div class="status-card"><div class="label">Balance</div><div class="value" id="s-balance">—</div></div>
    <div class="status-card"><div class="label">Uptime</div><div class="value" id="s-uptime">—</div></div>
    <div class="status-card"><div class="label">Chain</div><div class="value" id="s-chain">—</div></div>
    <div class="status-card"><div class="label">Attestations</div><div class="value" id="s-attestations">—</div></div>
  </div>

  <div class="section">
    <h2>Live Prices</h2>
    <div class="price-grid" id="price-grid"></div>
  </div>

  <div class="section">
    <h2>Recent Attestations</h2>
    <table class="attestation-table">
      <thead><tr><th>Asset</th><th>Price</th><th>Sources</th><th>Time</th><th>Signature</th><th>On-chain</th></tr></thead>
      <tbody id="attestation-body"></tbody>
    </table>
  </div>

  <div class="section">
    <h2>Verify Attestation</h2>
    <div class="verify-section">
      <p style="color:#888;font-size:0.85em;">Paste a signed message and signature from any attestation to verify it was signed by the TEE wallet.</p>
      <textarea id="v-message" rows="2" placeholder="Message (from attestation)"></textarea>
      <textarea id="v-signature" rows="2" placeholder="Signature (0x...)"></textarea>
      <button onclick="verifyAttestation()">Verify</button>
      <div class="verify-result" id="v-result"></div>
    </div>
  </div>

  <div class="refresh-info">Auto-refreshes every 15 seconds</div>
  <footer>Verifiable Price Oracle — Running on EigenCompute TEE | Synthesis Hackathon 2026</footer>
</div>

<script>
const API = '';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function truncate(s, n) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + s + 's';
}

async function fetchHealth() {
  try {
    const res = await fetch(API + '/health');
    const data = await res.json();
    document.getElementById('s-status').textContent = data.status.toUpperCase();
    document.getElementById('s-status').className = 'value green';
    document.getElementById('s-wallet').textContent = truncate(data.wallet, 18);
    document.getElementById('s-balance').textContent = data.balance;
    document.getElementById('s-balance').className = 'value ' + (data.balance === '0.000000 ETH' ? 'yellow' : 'green');
    document.getElementById('s-uptime').textContent = formatUptime(data.uptime);
    document.getElementById('s-chain').textContent = data.chain || 'Base';
    document.getElementById('s-attestations').textContent = data.totalAttestations;
  } catch (e) {
    document.getElementById('s-status').textContent = 'ERROR';
    document.getElementById('s-status').className = 'value red';
  }
}

async function fetchPrices() {
  try {
    const res = await fetch(API + '/prices');
    const data = await res.json();
    const grid = document.getElementById('price-grid');
    grid.innerHTML = '';
    for (const [asset, info] of Object.entries(data.prices)) {
      const p = info;
      const card = document.createElement('div');
      card.className = 'price-card';
      const badge = p.lowConfidence ? '<span class="badge low">LOW CONFIDENCE</span>'
        : p.outlierDetected ? '<span class="badge warn">OUTLIER ±' + p.maxDeviation + '%</span>'
        : '<span class="badge ok">' + p.sourceCount + '/3</span>';
      card.innerHTML =
        '<div class="asset-name">' + asset + ' ' + badge + '</div>' +
        '<div class="price">$' + p.median.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '</div>' +
        '<div class="meta">Updated ' + formatTime(p.timestamp) + '</div>' +
        '<div class="sources">' +
        (p.sources || []).map(function(s) {
          return '<div class="source-row"><span class="name">' + s.name + '</span><span class="val">$' + s.price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '</span></div>';
        }).join('') +
        '</div>';
      grid.appendChild(card);
    }
  } catch (e) {
    console.error('Price fetch failed:', e);
  }
}

async function fetchAttestations() {
  try {
    const res = await fetch(API + '/attestations');
    const data = await res.json();
    const tbody = document.getElementById('attestation-body');
    tbody.innerHTML = '';
    (data.attestations || []).slice(-15).reverse().forEach(function(a) {
      const tr = document.createElement('tr');
      const onchain = a.onchainUid && a.onchainUid !== '0x'
        ? '<span class="hash">' + truncate(a.onchainUid, 14) + '</span>'
        : '<span style="color:#444">off-chain</span>';
      tr.innerHTML =
        '<td style="text-transform:capitalize">' + a.asset + '</td>' +
        '<td>$' + a.price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '</td>' +
        '<td>' + a.sourceCount + '/3</td>' +
        '<td>' + formatTime(a.timestamp) + '</td>' +
        '<td><span class="hash">' + truncate(a.signature, 16) + '</span></td>' +
        '<td>' + onchain + '</td>';
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Attestation fetch failed:', e);
  }
}

async function verifyAttestation() {
  const msg = document.getElementById('v-message').value.trim();
  const sig = document.getElementById('v-signature').value.trim();
  const el = document.getElementById('v-result');
  if (!msg || !sig) { el.className = 'verify-result invalid'; el.style.display = 'block'; el.textContent = 'Both fields required'; return; }
  try {
    const res = await fetch(API + '/verify', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: msg, signature: sig})
    });
    const data = await res.json();
    if (data.valid) {
      el.className = 'verify-result valid';
      el.textContent = 'VALID — Signed by TEE wallet ' + data.teeWallet;
    } else {
      el.className = 'verify-result invalid';
      el.textContent = data.error || data.message || 'Invalid signature';
    }
    el.style.display = 'block';
  } catch (e) {
    el.className = 'verify-result invalid';
    el.textContent = 'Verification request failed';
    el.style.display = 'block';
  }
}

function refresh() { fetchHealth(); fetchPrices(); fetchAttestations(); }
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
