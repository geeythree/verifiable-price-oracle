import Fastify from 'fastify';
import cors from '@fastify/cors';
import { verifyMessage } from 'viem';
import { config } from './config.js';
import { fetchPrices, type PriceResult } from './oracle.js';
import { Attestor, type AttestedPrice, type AttestationRecord } from './attestation.js';

async function main() {
  if (!config.mnemonic) {
    console.error('MNEMONIC environment variable is not set');
    process.exit(1);
  }

  // --- Initialize Attestor ---
  const attestor = new Attestor();
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
  if (config.enableOnchainAttestation && !config.easSchemaUid && parseFloat(balance) > 0) {
    try {
      await attestor.registerSchema();
    } catch (err: any) {
      console.error(`[attestor] Schema registration failed: ${err.message}`);
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

  // --- Price Loop ---
  let loopRunning = false;

  async function priceLoop() {
    if (loopRunning) return; // prevent overlap
    loopRunning = true;

    console.log(`[oracle] Fetching prices for: ${config.assets.join(', ')}`);
    for (const asset of config.assets) {
      try {
        const result = await fetchPrices(asset);
        console.log(
          `[oracle] ${asset} = $${result.median.toFixed(2)} ` +
          `(${result.sourceCount}/3 sources` +
          `${result.lowConfidence ? ', LOW CONFIDENCE' : ''}` +
          `${result.outlierDetected ? `, OUTLIER ±${result.maxDeviation}%` : ''})`
        );

        if (result.lowConfidence || result.median <= 0) continue;

        // Always sign off-chain
        const attested = await attestor.signAttestation(result);

        // Attempt on-chain EAS attestation
        if (config.enableOnchainAttestation && config.easSchemaUid) {
          try {
            const { uid, txHash } = await attestor.attestOnchain(result);
            attested.onchainUid = uid;
            attested.txHash = txHash;
          } catch (err: any) {
            console.error(`[attestor] On-chain attestation failed for ${asset}: ${err.message}`);
          }
        }

        priceCache.set(asset, attested);

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

        priceHistory.push({ asset, price: result.median, timestamp: result.timestamp });
        if (priceHistory.length > MAX_HISTORY) {
          priceHistory.splice(0, priceHistory.length - MAX_HISTORY);
        }
      } catch (err: any) {
        console.error(`[oracle] Error for ${asset}: ${err.message}`);
      }
    }

    loopRunning = false;
  }

  // --- Fastify Server ---
  const server = Fastify({ logger: true });

  // CORS
  await server.register(cors, { origin: true });

  // Health check
  server.get('/health', async () => {
    const bal = await attestor.getBalance().catch(() => 'unknown');
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      wallet: attestor.address,
      balance: `${bal} ETH`,
      chain: config.chainId === 84532 ? 'Base Sepolia' : 'Base Mainnet',
      schemaUid: config.easSchemaUid || 'not registered',
      onchainAttestation: config.enableOnchainAttestation,
      assets: config.assets,
      intervalMs: config.priceIntervalMs,
      cachedAssets: Array.from(priceCache.keys()),
      totalAttestations: attestationLog.length,
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

  // Single asset price
  server.get<{ Params: { asset: string } }>('/prices/:asset', async (request, reply) => {
    const result = priceCache.get(request.params.asset);
    if (!result) {
      reply.code(404);
      return { error: `No price data for ${request.params.asset}` };
    }
    const history = priceHistory
      .filter(h => h.asset === request.params.asset)
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

  // Signature verification endpoint
  server.post<{
    Body: { message: string; signature: string };
  }>('/verify', async (request, reply) => {
    const { message, signature } = request.body || {};
    if (!message || !signature) {
      reply.code(400);
      return { error: 'Required fields: message, signature' };
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
    } catch (err: any) {
      reply.code(400);
      return { error: `Verification failed: ${err.message}` };
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
