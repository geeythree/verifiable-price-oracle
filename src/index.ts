import dotenv from 'dotenv';
import Fastify from 'fastify';
import { hashMessage, encodeAbiParameters, parseAbiParameters } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

dotenv.config();

// --- Config ---
const ASSETS = (process.env.ASSETS || 'ethereum,bitcoin').split(',').map(a => a.trim());
const PRICE_INTERVAL_MS = parseInt(process.env.PRICE_INTERVAL_MS || '300000', 10);
const PORT = Number(process.env.PORT ?? 8080);

// Base token addresses for DexScreener
const BASE_TOKEN_ADDRESSES: Record<string, string> = {
  ethereum: '0x4200000000000000000000000000000000000006',
  bitcoin: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
};

// --- Types ---
interface PriceSource {
  name: string;
  price: number;
  timestamp: number;
}

interface PriceResult {
  asset: string;
  median: number;
  sources: PriceSource[];
  sourceCount: number;
  timestamp: number;
  lowConfidence: boolean;
}

interface AttestedPrice extends PriceResult {
  signature: string;
  signer: string;
  message: string;
  messageHash: string;
  encodedData: string;
}

// --- Oracle: Price Fetching ---

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

async function fetchCoinGecko(asset: string): Promise<PriceSource> {
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${asset}&vs_currencies=usd`
  );
  const price = data[asset]?.usd;
  if (typeof price !== 'number') throw new Error(`No price for ${asset}`);
  return { name: 'coingecko', price, timestamp: Date.now() };
}

async function fetchDeFiLlama(asset: string): Promise<PriceSource> {
  const data = await fetchJson(
    `https://coins.llama.fi/prices/current/coingecko:${asset}`
  );
  const coin = data.coins?.[`coingecko:${asset}`];
  if (!coin?.price) throw new Error(`No price for ${asset}`);
  return { name: 'defillama', price: coin.price, timestamp: Date.now() };
}

async function fetchDexScreener(asset: string): Promise<PriceSource> {
  const address = BASE_TOKEN_ADDRESSES[asset];
  if (!address) throw new Error(`No Base address for ${asset}`);
  const data = await fetchJson(
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

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function fetchPrices(asset: string): Promise<PriceResult> {
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

  return {
    asset,
    median,
    sources,
    sourceCount: sources.length,
    timestamp: Date.now(),
    lowConfidence: sources.length < 2,
  };
}

// --- Main ---

async function main() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error('MNEMONIC environment variable is not set');
    process.exit(1);
  }

  // Derive the TEE wallet
  const account = mnemonicToAccount(mnemonic);

  console.log('=== Verifiable Price Oracle ===');
  console.log(`TEE wallet: ${account.address}`);
  console.log(`Assets: ${ASSETS.join(', ')}`);
  console.log(`Interval: ${PRICE_INTERVAL_MS / 1000}s`);

  // In-memory store
  const priceCache = new Map<string, AttestedPrice>();
  const attestationLog: AttestedPrice[] = [];
  const MAX_LOG = 100;
  const startTime = Date.now();

  // Sign and attest a price result using the TEE wallet
  async function attestPrice(result: PriceResult): Promise<AttestedPrice> {
    const priceUsd = BigInt(Math.round(result.median * 1e8));
    const timestamp = BigInt(Math.floor(result.timestamp / 1000));
    const sourceNames = JSON.stringify(result.sources.map(s => s.name));

    // ABI-encode the price data (same schema as EAS attestation)
    const encodedData = encodeAbiParameters(
      parseAbiParameters('string asset, uint256 priceUsd, uint8 sourceCount, uint64 timestamp, string sources'),
      [result.asset, priceUsd, result.sourceCount, timestamp, sourceNames]
    );

    // Create a signed attestation message
    const message = `PriceOracle|${result.asset}|${priceUsd.toString()}|${result.sourceCount}|${timestamp}|${sourceNames}`;
    const messageHash = hashMessage(message);
    const signature = await account.signMessage({ message });

    return {
      ...result,
      signature,
      signer: account.address,
      message,
      messageHash,
      encodedData,
    };
  }

  // Price loop
  async function priceLoop() {
    console.log(`[oracle] Fetching prices for: ${ASSETS.join(', ')}`);
    for (const asset of ASSETS) {
      try {
        const result = await fetchPrices(asset);
        console.log(
          `[oracle] ${asset} = $${result.median.toFixed(2)} (${result.sourceCount}/3 sources${result.lowConfidence ? ', LOW CONFIDENCE' : ''})`
        );

        if (!result.lowConfidence && result.median > 0) {
          const attested = await attestPrice(result);
          priceCache.set(asset, attested);
          attestationLog.push(attested);
          if (attestationLog.length > MAX_LOG) {
            attestationLog.splice(0, attestationLog.length - MAX_LOG);
          }
        }
      } catch (err: any) {
        console.error(`[oracle] Error for ${asset}: ${err.message}`);
      }
    }
  }

  // --- Fastify Server ---
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    wallet: account.address,
    assets: ASSETS,
    intervalMs: PRICE_INTERVAL_MS,
    cachedAssets: Array.from(priceCache.keys()),
    totalAttestations: attestationLog.length,
  }));

  server.get('/prices', async () => {
    const prices: Record<string, AttestedPrice> = {};
    for (const [key, val] of priceCache) {
      prices[key] = val;
    }
    return { prices, count: priceCache.size };
  });

  server.get<{ Params: { asset: string } }>('/prices/:asset', async (request, reply) => {
    const result = priceCache.get(request.params.asset);
    if (!result) {
      reply.code(404);
      return { error: `No price data for ${request.params.asset}` };
    }
    return result;
  });

  server.get('/attestations', async () => ({
    attestations: attestationLog.slice(-50).map(a => ({
      asset: a.asset,
      price: a.median,
      sourceCount: a.sourceCount,
      timestamp: a.timestamp,
      signature: a.signature,
      signer: a.signer,
      messageHash: a.messageHash,
    })),
    total: attestationLog.length,
  }));

  // Endpoint to verify a specific attestation
  server.get('/verify', async () => ({
    description: 'All prices are signed by the TEE wallet. Verify any attestation by recovering the signer from the signature and confirming it matches the TEE wallet address.',
    teeWallet: account.address,
    schema: 'string asset, uint256 priceUsd, uint8 sourceCount, uint64 timestamp, string sources',
    priceDecimals: 8,
    note: 'priceUsd uses 8 decimal places (Chainlink convention). Divide by 1e8 to get USD value.',
  }));

  // Start server
  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }

  // Initial fetch + schedule
  await priceLoop();
  setInterval(priceLoop, PRICE_INTERVAL_MS);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
