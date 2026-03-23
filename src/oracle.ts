import { BASE_TOKEN_ADDRESSES, isValidAsset } from './config.js';

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

async function fetchJson(url: string, timeoutMs = 10000): Promise<unknown> {
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

async function fetchWithRetry(url: string, retries = 1): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw new Error('unreachable');
}

// --- Aggregation (exported for testing) ---

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
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

// --- Oracle class (encapsulates cache state) ---

export class PriceOracle {
  private coinGeckoCache: { data: Record<string, number>; ts: number } = { data: {}, ts: 0 };
  private defiLlamaCache: { data: Record<string, number>; ts: number } = { data: {}, ts: 0 };
  private lastFetchError: string | null = null;
  private lastSuccessTs = 0;

  get lastError(): string | null { return this.lastFetchError; }
  get lastSuccess(): number { return this.lastSuccessTs; }

  private async batchFetchCoinGecko(assets: readonly string[]): Promise<void> {
    const safeAssets = assets.filter(isValidAsset);
    if (safeAssets.length === 0) return;

    const ids = safeAssets.join(',');
    const data = await fetchWithRetry(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`
    ) as Record<string, { usd?: number }>;

    const prices: Record<string, number> = {};
    for (const asset of safeAssets) {
      const price = data[asset]?.usd;
      if (typeof price === 'number' && price > 0) {
        prices[asset] = price;
      }
    }
    this.coinGeckoCache = { data: prices, ts: Date.now() };
  }

  private async batchFetchDeFiLlama(assets: readonly string[]): Promise<void> {
    const safeAssets = assets.filter(isValidAsset);
    if (safeAssets.length === 0) return;

    const ids = safeAssets.map(a => `coingecko:${a}`).join(',');
    const data = await fetchWithRetry(
      `https://coins.llama.fi/prices/current/${encodeURIComponent(ids)}`
    ) as { coins?: Record<string, { price?: number }> };

    const prices: Record<string, number> = {};
    for (const asset of safeAssets) {
      const price = data.coins?.[`coingecko:${asset}`]?.price;
      if (typeof price === 'number' && price > 0) {
        prices[asset] = price;
      }
    }
    this.defiLlamaCache = { data: prices, ts: Date.now() };
  }

  private async fetchDexScreener(asset: string): Promise<PriceSource> {
    const address = BASE_TOKEN_ADDRESSES[asset];
    if (!address) throw new Error(`No Base address for ${asset}`);
    const data = await fetchWithRetry(
      `https://api.dexscreener.com/tokens/v1/base/${address}`
    );
    const pairs = Array.isArray(data) ? data : [];
    if (pairs.length === 0) throw new Error(`No pairs for ${asset}`);
    const best = pairs.reduce((a: Record<string, any>, b: Record<string, any>) =>
      ((b.liquidity?.usd as number) || 0) > ((a.liquidity?.usd as number) || 0) ? b : a
    );
    const price = parseFloat(best.priceUsd as string);
    if (isNaN(price) || price <= 0) throw new Error(`Invalid price for ${asset}`);
    return { name: 'dexscreener', price, timestamp: Date.now() };
  }

  async fetchPrices(asset: string): Promise<PriceResult> {
    const sources: PriceSource[] = [];

    if (this.coinGeckoCache.data[asset]) {
      sources.push({ name: 'coingecko', price: this.coinGeckoCache.data[asset], timestamp: this.coinGeckoCache.ts });
    }
    if (this.defiLlamaCache.data[asset]) {
      sources.push({ name: 'defillama', price: this.defiLlamaCache.data[asset], timestamp: this.defiLlamaCache.ts });
    }

    if (BASE_TOKEN_ADDRESSES[asset]) {
      try {
        sources.push(await this.fetchDexScreener(asset));
      } catch (err) {
        console.warn(`[oracle] DexScreener failed for ${asset}: ${err}`);
      }
    }

    const prices = sources.map(s => s.price);
    const median = computeMedian(prices);
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

  async fetchAllPrices(assets: readonly string[]): Promise<PriceResult[]> {
    this.lastFetchError = null;

    // Batch fetch from CoinGecko and DeFiLlama (1 request each for ALL assets)
    const batchResults = await Promise.allSettled([
      this.batchFetchCoinGecko(assets),
      this.batchFetchDeFiLlama(assets),
    ]);

    for (const r of batchResults) {
      if (r.status === 'rejected') {
        this.lastFetchError = String(r.reason);
      }
    }

    const results: PriceResult[] = [];
    for (const asset of assets) {
      results.push(await this.fetchPrices(asset));
    }

    if (results.some(r => !r.lowConfidence)) {
      this.lastSuccessTs = Date.now();
    }

    return results;
  }
}
