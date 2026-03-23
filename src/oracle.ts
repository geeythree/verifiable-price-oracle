import { BASE_TOKEN_ADDRESSES } from './config.js';

// --- Types ---

export interface PriceSource {
  name: string;
  price: number;
  timestamp: number;
}

export interface PriceResult {
  asset: string;
  median: number;
  sources: PriceSource[];
  sourceCount: number;
  timestamp: number;
  lowConfidence: boolean;
  outlierDetected: boolean;
  maxDeviation: number;
}

// --- Fetch with retry ---

async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string, retries = 1): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// --- Batch Price Sources ---
// CoinGecko and DeFiLlama support batch queries — one request for all assets

let coinGeckoCache: { data: Record<string, number>; ts: number } = { data: {}, ts: 0 };
let defiLlamaCache: { data: Record<string, number>; ts: number } = { data: {}, ts: 0 };

export async function batchFetchCoinGecko(assets: string[]): Promise<void> {
  try {
    const ids = assets.join(',');
    const data = await fetchWithRetry(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );
    const prices: Record<string, number> = {};
    for (const asset of assets) {
      if (data[asset]?.usd) prices[asset] = data[asset].usd;
    }
    coinGeckoCache = { data: prices, ts: Date.now() };
  } catch (err) {
    console.warn(`[oracle] CoinGecko batch failed: ${err}`);
  }
}

export async function batchFetchDeFiLlama(assets: string[]): Promise<void> {
  try {
    const ids = assets.map(a => `coingecko:${a}`).join(',');
    const data = await fetchWithRetry(
      `https://coins.llama.fi/prices/current/${ids}`
    );
    const prices: Record<string, number> = {};
    for (const asset of assets) {
      const coin = data.coins?.[`coingecko:${asset}`];
      if (coin?.price) prices[asset] = coin.price;
    }
    defiLlamaCache = { data: prices, ts: Date.now() };
  } catch (err) {
    console.warn(`[oracle] DeFiLlama batch failed: ${err}`);
  }
}

async function fetchDexScreener(asset: string): Promise<PriceSource> {
  const address = BASE_TOKEN_ADDRESSES[asset];
  if (!address) throw new Error(`No Base address for ${asset}`);
  const data = await fetchWithRetry(
    `https://api.dexscreener.com/tokens/v1/base/${address}`
  );
  const pairs = Array.isArray(data) ? data : [];
  if (pairs.length === 0) throw new Error(`No pairs for ${asset}`);
  const best = pairs.reduce((a: any, b: any) =>
    (b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a
  );
  const price = parseFloat(best.priceUsd);
  if (isNaN(price)) throw new Error(`Invalid price for ${asset}`);
  return { name: 'dexscreener', price, timestamp: Date.now() };
}

// --- Aggregation ---

export function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function detectOutlier(prices: number[], median: number): { outlierDetected: boolean; maxDeviation: number } {
  if (median === 0 || prices.length < 2) return { outlierDetected: false, maxDeviation: 0 };
  const deviations = prices.map(p => Math.abs((p - median) / median) * 100);
  const maxDeviation = Math.max(...deviations);
  return { outlierDetected: maxDeviation > 2, maxDeviation: Math.round(maxDeviation * 100) / 100 };
}

// --- Public API ---

export async function fetchPrices(asset: string): Promise<PriceResult> {
  const sources: PriceSource[] = [];

  // Pull from batch caches
  if (coinGeckoCache.data[asset]) {
    sources.push({ name: 'coingecko', price: coinGeckoCache.data[asset], timestamp: coinGeckoCache.ts });
  }
  if (defiLlamaCache.data[asset]) {
    sources.push({ name: 'defillama', price: defiLlamaCache.data[asset], timestamp: defiLlamaCache.ts });
  }

  // DexScreener is per-asset (only for assets with Base addresses)
  if (BASE_TOKEN_ADDRESSES[asset]) {
    try {
      sources.push(await fetchDexScreener(asset));
    } catch (err) {
      console.warn(`[oracle] DexScreener failed for ${asset}: ${err}`);
    }
  }

  const prices = sources.map(s => s.price);
  const median = prices.length > 0 ? computeMedian(prices) : 0;
  const { outlierDetected, maxDeviation } = detectOutlier(prices, median);

  if (outlierDetected) {
    console.warn(`[oracle] Outlier detected for ${asset}: max deviation ${maxDeviation}% from median`);
  }

  return {
    asset,
    median,
    sources,
    sourceCount: sources.length,
    timestamp: Date.now(),
    lowConfidence: sources.length < 2,
    outlierDetected,
    maxDeviation,
  };
}

export async function fetchAllPrices(assets: string[]): Promise<PriceResult[]> {
  // Batch fetch from CoinGecko and DeFiLlama (1 request each for ALL assets)
  await Promise.all([
    batchFetchCoinGecko(assets),
    batchFetchDeFiLlama(assets),
  ]);

  // Then resolve per-asset (DexScreener only for assets with Base addresses)
  const results: PriceResult[] = [];
  for (const asset of assets) {
    results.push(await fetchPrices(asset));
  }
  return results;
}
