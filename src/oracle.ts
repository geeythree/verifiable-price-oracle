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
  maxDeviation: number; // max % deviation from median
}

// --- Fetch with retry ---

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
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
      // Brief pause before retry
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// --- Price Sources ---

async function fetchCoinGecko(asset: string): Promise<PriceSource> {
  const data = await fetchWithRetry(
    `https://api.coingecko.com/api/v3/simple/price?ids=${asset}&vs_currencies=usd`
  );
  const price = data[asset]?.usd;
  if (typeof price !== 'number') throw new Error(`No price for ${asset}`);
  return { name: 'coingecko', price, timestamp: Date.now() };
}

async function fetchDeFiLlama(asset: string): Promise<PriceSource> {
  const data = await fetchWithRetry(
    `https://coins.llama.fi/prices/current/coingecko:${asset}`
  );
  const coin = data.coins?.[`coingecko:${asset}`];
  if (!coin?.price) throw new Error(`No price for ${asset}`);
  return { name: 'defillama', price: coin.price, timestamp: Date.now() };
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

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function detectOutlier(prices: number[], median: number): { outlierDetected: boolean; maxDeviation: number } {
  if (median === 0 || prices.length < 2) return { outlierDetected: false, maxDeviation: 0 };
  const deviations = prices.map(p => Math.abs((p - median) / median) * 100);
  const maxDeviation = Math.max(...deviations);
  // Flag if any source deviates more than 2% from median
  return { outlierDetected: maxDeviation > 2, maxDeviation: Math.round(maxDeviation * 100) / 100 };
}

// --- Public API ---

export async function fetchPrices(asset: string): Promise<PriceResult> {
  const results = await Promise.allSettled([
    fetchCoinGecko(asset),
    fetchDeFiLlama(asset),
    fetchDexScreener(asset),
  ]);

  const sources: PriceSource[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      sources.push(result.value);
    } else {
      console.warn(`[oracle] Source failed for ${asset}: ${result.reason}`);
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
  return Promise.all(assets.map(fetchPrices));
}
