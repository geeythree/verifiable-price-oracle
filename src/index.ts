import Fastify from 'fastify';
import cors from '@fastify/cors';
import { verifyMessage } from 'viem';
import { createConfig } from './config.js';
import { PriceOracle } from './oracle.js';
import { Attestor, type AttestedPrice, type AttestationRecord } from './attestation.js';
import { getDashboardHtml } from './dashboard.js';

const MAX_BODY_SIZE = 8192; // 8KB limit for POST /verify

async function main() {
  const config = createConfig();

  if (!config.mnemonic) {
    console.error('MNEMONIC environment variable is not set');
    process.exit(1);
  }

  // --- Initialize ---
  const attestor = new Attestor(config);
  const oracle = new PriceOracle();

  console.log('=== Verifiable Price Oracle ===');
  console.log(`TEE wallet: ${attestor.address}`);
  console.log(`Assets: ${config.assets.join(', ')}`);
  console.log(`Interval: ${config.priceIntervalMs / 1000}s`);
  console.log(`Chain: ${config.chainId === 84532 ? 'Base Sepolia' : 'Base Mainnet'}`);
  console.log(`On-chain attestation: ${config.enableOnchainAttestation ? 'enabled' : 'disabled'}`);

  const balance = await attestor.getBalance();
  console.log(`Balance: ${balance} ETH`);

  if (parseFloat(balance) === 0) {
    console.warn('[wallet] WARNING: Zero balance — on-chain attestations will fail until funded');
  }

  // Register schema if needed and wallet is funded
  if (config.enableOnchainAttestation && (!config.easSchemaUid || config.easSchemaUid.length <= 2) && parseFloat(balance) > 0) {
    try {
      await attestor.registerSchema();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[attestor] Schema registration failed: ${msg}`);
      console.warn('[attestor] Continuing with off-chain attestations only');
    }
  }

  // --- In-memory store ---
  const priceCache = new Map<string, AttestedPrice>();
  const attestationLog: AttestationRecord[] = [];
  const priceHistory: Array<{ asset: string; price: number; timestamp: number }> = [];
  const MAX_LOG = 100;
  const MAX_HISTORY = 500;
  const startTime = Date.now();
  let consecutiveFailures = 0;

  // --- Price Loop ---
  let loopRunning = false;

  async function priceLoop() {
    if (loopRunning) return;
    loopRunning = true;

    try {
      console.log(`[oracle] Fetching prices for: ${config.assets.join(', ')}`);
      const allResults = await oracle.fetchAllPrices(config.assets);

      for (const result of allResults) {
        try {
          console.log(
            `[oracle] ${result.asset} = $${result.median.toFixed(2)} ` +
            `(${result.sourceCount}/3 sources` +
            `${result.lowConfidence ? ', LOW CONFIDENCE' : ''}` +
            `${result.outlierDetected ? `, OUTLIER ±${result.maxDeviation}%` : ''})`
          );

          if (result.lowConfidence || result.median <= 0) continue;

          const attested = await attestor.signAttestation(result);

          // Attempt on-chain EAS attestation
          if (config.enableOnchainAttestation && config.easSchemaUid && config.easSchemaUid.length > 2) {
            try {
              const { uid, txHash } = await attestor.attestOnchain(result);
              attested.onchainUid = uid;
              attested.txHash = txHash;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[attestor] On-chain attestation failed for ${result.asset}: ${msg}`);
            }
          }

          priceCache.set(result.asset, attested);

          attestationLog.push({
            asset: attested.asset,
            price: attested.median,
            sourceCount: attested.sourceCount,
            timestamp: attested.timestamp,
            signature: attested.signature,
            signer: attested.signer,
            messageHash: attested.messageHash,
            onchainUid: attested.onchainUid,
            txHash: attested.txHash,
          });
          if (attestationLog.length > MAX_LOG) {
            attestationLog.splice(0, attestationLog.length - MAX_LOG);
          }

          priceHistory.push({ asset: result.asset, price: result.median, timestamp: result.timestamp });
          if (priceHistory.length > MAX_HISTORY) {
            priceHistory.splice(0, priceHistory.length - MAX_HISTORY);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[oracle] Error for ${result.asset}: ${msg}`);
        }
      }

      consecutiveFailures = 0;
    } catch (err: unknown) {
      consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[oracle] Price loop failed (${consecutiveFailures} consecutive): ${msg}`);
    } finally {
      loopRunning = false;
    }
  }

  // --- Health Status ---

  function getHealthStatus(): 'healthy' | 'degraded' | 'unhealthy' {
    if (priceCache.size === 0 && Date.now() - startTime > 60_000) return 'unhealthy';
    if (consecutiveFailures >= 3) return 'unhealthy';
    if (consecutiveFailures >= 1) return 'degraded';
    if (oracle.lastSuccess > 0 && Date.now() - oracle.lastSuccess > config.priceIntervalMs * 3) return 'degraded';
    return 'healthy';
  }

  // --- Fastify Server ---
  const server = Fastify({
    logger: true,
    bodyLimit: MAX_BODY_SIZE,
  });

  await server.register(cors, { origin: true });

  // Dashboard
  server.get('/', async (_request, reply) => {
    reply.type('text/html').send(getDashboardHtml());
  });

  // Health check with depth
  server.get('/health', async () => {
    const bal = await attestor.getBalance().catch(() => 'unknown');
    const status = getHealthStatus();
    return {
      status,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      wallet: attestor.address,
      balance: `${bal} ETH`,
      chain: config.chainId === 84532 ? 'Base Sepolia' : 'Base Mainnet',
      schemaUid: (config.easSchemaUid && config.easSchemaUid.length > 2) ? config.easSchemaUid : 'not registered',
      onchainAttestation: config.enableOnchainAttestation,
      assets: config.assets,
      intervalMs: config.priceIntervalMs,
      cachedAssets: Array.from(priceCache.keys()),
      totalAttestations: attestationLog.length,
      consecutiveFailures,
      lastSuccess: oracle.lastSuccess > 0 ? new Date(oracle.lastSuccess).toISOString() : null,
      lastError: oracle.lastError,
    };
  });

  // All prices
  server.get('/prices', async () => {
    const prices: Record<string, AttestedPrice> = {};
    for (const [key, val] of priceCache) {
      prices[key] = val;
    }
    return { prices, count: priceCache.size };
  });

  // Single asset price — validated
  server.get<{ Params: { asset: string } }>('/prices/:asset', async (request, reply) => {
    const { asset } = request.params;
    const result = priceCache.get(asset);
    if (!result) {
      reply.code(404);
      return { error: `No price data for ${asset}` };
    }
    const history = priceHistory
      .filter(h => h.asset === asset)
      .slice(-20);
    return { ...result, history };
  });

  // Attestation log
  server.get('/attestations', async () => ({
    attestations: attestationLog.slice(-50),
    total: attestationLog.length,
  }));

  // Verification info
  server.get('/verify', async () => ({
    description: 'All prices are signed by the TEE wallet. Use POST /verify to verify a specific attestation.',
    teeWallet: attestor.address,
    schema: 'string asset, uint256 priceUsd, uint8 sourceCount, uint64 timestamp, string sources',
    priceDecimals: 8,
    note: 'priceUsd uses 8 decimal places (Chainlink convention). Divide by 1e8 to get USD value.',
    endpoints: {
      'POST /verify': 'Submit { message, signature } to verify TEE origin',
      'GET /attestations': 'View recent signed + on-chain attestations',
    },
  }));

  // Signature verification endpoint — validated input
  server.post<{
    Body: { message: string; signature: string };
  }>('/verify', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return { error: 'Invalid JSON body' };
    }

    const { message, signature } = body;
    if (typeof message !== 'string' || typeof signature !== 'string') {
      reply.code(400);
      return { error: 'Required fields: message (string), signature (string)' };
    }

    if (!signature.startsWith('0x') || signature.length !== 132) {
      reply.code(400);
      return { error: 'Signature must be a 0x-prefixed 65-byte hex string (132 chars)' };
    }

    try {
      const valid = await verifyMessage({
        address: attestor.address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });

      return {
        valid,
        recoveredSigner: valid ? attestor.address : 'signature mismatch',
        teeWallet: attestor.address,
        message: valid
          ? 'Signature verified — this attestation was signed by the TEE wallet'
          : 'Signature does NOT match the TEE wallet',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { error: `Verification failed: ${msg}` };
    }
  });

  // Start server
  await server.listen({ port: config.port, host: '0.0.0.0' });

  // Initial fetch + schedule
  await priceLoop();
  const interval = setInterval(priceLoop, config.priceIntervalMs);

  // --- Graceful shutdown ---
  async function shutdown(signal: string) {
    console.log(`[server] Received ${signal}, shutting down gracefully...`);
    clearInterval(interval);
    await server.close();
    console.log('[server] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
