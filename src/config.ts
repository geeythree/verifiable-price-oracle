import dotenv from 'dotenv';
dotenv.config();

export interface Config {
  readonly mnemonic: string;
  readonly port: number;
  readonly assets: readonly string[];
  readonly priceIntervalMs: number;
  readonly baseRpcUrl: string;
  readonly chainId: number;
  readonly easContract: `0x${string}`;
  readonly schemaRegistry: `0x${string}`;
  readonly enableOnchainAttestation: boolean;
  // Mutable: set after schema registration
  easSchemaUid: `0x${string}`;
}

export function createConfig(): Config {
  return {
    mnemonic: process.env.MNEMONIC || '',
    port: Number(process.env.PORT ?? 8080),
    assets: Object.freeze(
      (process.env.ASSETS || 'ethereum,bitcoin,solana,chainlink,uniswap,aave').split(',').map(a => a.trim())
    ),
    priceIntervalMs: parseInt(process.env.PRICE_INTERVAL_MS || '300000', 10),
    baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    chainId: parseInt(process.env.CHAIN_ID || '8453', 10),
    easContract: '0x4200000000000000000000000000000000000021',
    schemaRegistry: '0x4200000000000000000000000000000000000020',
    easSchemaUid: (process.env.EAS_SCHEMA_UID || '') as `0x${string}`,
    enableOnchainAttestation: process.env.ENABLE_ONCHAIN !== 'false',
  };
}

// Allowed asset IDs (CoinGecko identifiers) — whitelist for URL safety
const VALID_ASSETS = new Set([
  'ethereum', 'bitcoin', 'solana', 'chainlink', 'uniswap', 'aave',
  'matic-network', 'arbitrum', 'optimism', 'avalanche-2', 'polkadot',
  'cosmos', 'near', 'fantom', 'tron',
]);

export function isValidAsset(asset: string): boolean {
  return VALID_ASSETS.has(asset) || /^[a-z0-9-]+$/.test(asset);
}

// Token addresses on Base for DexScreener lookups
// Assets without an entry here still get 2/3 sources (CoinGecko + DeFiLlama)
export const BASE_TOKEN_ADDRESSES: Record<string, string> = {
  ethereum: '0x4200000000000000000000000000000000000006',
  bitcoin: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
};

export const PRICE_SCHEMA = 'string asset,uint256 priceUsd,uint8 sourceCount,uint64 timestamp,string sources';
