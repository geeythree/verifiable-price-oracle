import dotenv from 'dotenv';
dotenv.config();

export const config = {
  mnemonic: process.env.MNEMONIC || '',
  port: Number(process.env.PORT ?? 8080),
  assets: (process.env.ASSETS || 'ethereum,bitcoin').split(',').map(a => a.trim()),
  priceIntervalMs: parseInt(process.env.PRICE_INTERVAL_MS || '300000', 10),

  // Base chain
  baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  chainId: parseInt(process.env.CHAIN_ID || '8453', 10),

  // EAS (Base predeploys)
  easContract: '0x4200000000000000000000000000000000000021' as `0x${string}`,
  schemaRegistry: '0x4200000000000000000000000000000000000020' as `0x${string}`,
  easSchemaUid: (process.env.EAS_SCHEMA_UID || '') as `0x${string}`,

  // Feature flags
  enableOnchainAttestation: process.env.ENABLE_ONCHAIN !== 'false',
} as const;

// Well-known token addresses on Base for DexScreener lookups
export const BASE_TOKEN_ADDRESSES: Record<string, string> = {
  ethereum: '0x4200000000000000000000000000000000000006', // WETH on Base
  bitcoin: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',  // cbBTC on Base
};

export const PRICE_SCHEMA = 'string asset,uint256 priceUsd,uint8 sourceCount,uint64 timestamp,string sources';
