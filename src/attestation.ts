import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  hashMessage,
  formatEther,
  decodeEventLog,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { type Config, PRICE_SCHEMA } from './config.js';
import type { PriceResult } from './oracle.js';

// --- EAS ABIs (minimal) ---

const EAS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
            name: 'data',
            type: 'tuple',
          },
        ],
        name: 'request',
        type: 'tuple',
      },
    ],
    name: 'attest',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: true, name: 'attester', type: 'address' },
      { indexed: false, name: 'uid', type: 'bytes32' },
      { indexed: true, name: 'schemaUID', type: 'bytes32' },
    ],
    name: 'Attested',
    type: 'event',
  },
] as const;

const SCHEMA_REGISTRY_ABI = [
  {
    inputs: [
      { name: 'schema', type: 'string' },
      { name: 'resolver', type: 'address' },
      { name: 'revocable', type: 'bool' },
    ],
    name: 'register',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'uid', type: 'bytes32' },
      { indexed: true, name: 'registerer', type: 'address' },
    ],
    name: 'Registered',
    type: 'event',
  },
] as const;

// --- Types ---

export interface AttestationRecord {
  asset: string;
  price: number;
  sourceCount: number;
  timestamp: number;
  signature: string;
  signer: string;
  messageHash: string;
  onchainUid?: string;
  txHash?: string;
}

export interface AttestedPrice extends PriceResult {
  signature: string;
  signer: string;
  message: string;
  messageHash: string;
  encodedData: string;
  onchainUid?: string;
  txHash?: string;
}

// --- Helpers ---

function encodePriceData(result: PriceResult) {
  const priceUsd = BigInt(Math.round(result.median * 1e8));
  const timestamp = BigInt(Math.floor(result.timestamp / 1000));
  const sourceNames = JSON.stringify(result.sources.map(s => s.name));

  const encodedData = encodeAbiParameters(
    parseAbiParameters('string asset, uint256 priceUsd, uint8 sourceCount, uint64 timestamp, string sources'),
    [result.asset, priceUsd, result.sourceCount, timestamp, sourceNames]
  );

  return { priceUsd, timestamp, sourceNames, encodedData };
}

// --- Attestor ---

export class Attestor {
  private readonly account: HDAccount;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly chain: Chain;
  private readonly config: Config;

  constructor(config: Config) {
    if (!config.mnemonic) throw new Error('MNEMONIC not set');

    this.config = config;
    this.account = mnemonicToAccount(config.mnemonic);
    this.chain = config.chainId === 84532 ? baseSepolia : base;

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.baseRpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(config.baseRpcUrl),
    });
  }

  get address(): string {
    return this.account.address;
  }

  async getBalance(): Promise<string> {
    const bal = await this.publicClient.getBalance({ address: this.account.address });
    return formatEther(bal);
  }

  async registerSchema(): Promise<`0x${string}`> {
    if (this.config.easSchemaUid && this.config.easSchemaUid.length > 2) {
      console.log(`[attestor] Schema already set: ${this.config.easSchemaUid}`);
      return this.config.easSchemaUid;
    }

    console.log(`[attestor] Registering EAS schema: "${PRICE_SCHEMA}"`);

    const { request } = await this.publicClient.simulateContract({
      address: this.config.schemaRegistry,
      abi: SCHEMA_REGISTRY_ABI,
      functionName: 'register',
      args: [PRICE_SCHEMA, '0x0000000000000000000000000000000000000000', true],
      account: this.account,
    });

    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    // Extract schema UID from Registered event
    // The UID is the first indexed topic (topics[1]) in the Registered(bytes32 indexed uid, address indexed registerer, ...) event
    let schemaUid: `0x${string}` | undefined;
    for (const log of receipt.logs) {
      // Try decodeEventLog first
      try {
        const decoded = decodeEventLog({
          abi: SCHEMA_REGISTRY_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'Registered') {
          schemaUid = (decoded.args as { uid: `0x${string}` }).uid;
          break;
        }
      } catch {
        // Fallback: raw topic extraction — UID is topics[1] for Registered event
        if (log.address.toLowerCase() === this.config.schemaRegistry.toLowerCase() && log.topics.length >= 2) {
          schemaUid = log.topics[1] as `0x${string}`;
          break;
        }
      }
    }

    if (!schemaUid) {
      // Last resort: check all logs for any with 2+ topics from the schema registry
      console.error(`[attestor] Receipt logs:`, JSON.stringify(receipt.logs.map(l => ({ address: l.address, topics: l.topics }))));
      throw new Error('No Registered event found in receipt');
    }

    this.config.easSchemaUid = schemaUid;
    console.log(`[attestor] Schema registered: ${schemaUid}`);
    console.log(`[attestor] Set EAS_SCHEMA_UID=${schemaUid} in .env for future runs`);
    return schemaUid;
  }

  // Off-chain signed attestation (always works, no gas needed)
  async signAttestation(result: PriceResult): Promise<AttestedPrice> {
    const { priceUsd, timestamp, sourceNames, encodedData } = encodePriceData(result);

    const message = `PriceOracle|${result.asset}|${priceUsd.toString()}|${result.sourceCount}|${timestamp}|${sourceNames}`;
    const messageHash = hashMessage(message);
    const signature = await this.account.signMessage({ message });

    return {
      ...result,
      signature,
      signer: this.account.address,
      message,
      messageHash,
      encodedData,
    };
  }

  // On-chain EAS attestation (requires gas)
  async attestOnchain(result: PriceResult): Promise<{ uid: string; txHash: string }> {
    if (!this.config.easSchemaUid || this.config.easSchemaUid.length <= 2) {
      throw new Error('Schema UID not set — call registerSchema() first');
    }

    const { encodedData } = encodePriceData(result);

    console.log(`[attestor] On-chain attesting ${result.asset} = $${result.median.toFixed(2)} (${result.sourceCount} sources)`);

    const { request } = await this.publicClient.simulateContract({
      address: this.config.easContract,
      abi: EAS_ABI,
      functionName: 'attest',
      args: [{
        schema: this.config.easSchemaUid,
        data: {
          recipient: '0x0000000000000000000000000000000000000000',
          expirationTime: 0n,
          revocable: true,
          refUID: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
          data: encodedData,
          value: 0n,
        },
      }],
      account: this.account,
    });

    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    // Extract attestation UID from Attested event
    // Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)
    // uid is in the data field (non-indexed)
    let uid = '0x';
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: EAS_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'Attested') {
          uid = (decoded.args as { uid: `0x${string}` }).uid;
          break;
        }
      } catch {
        // Fallback: uid is the first 32 bytes of log.data for Attested events from EAS contract
        if (log.address.toLowerCase() === this.config.easContract.toLowerCase() && log.data && log.data.length >= 66) {
          uid = `0x${log.data.slice(2, 66)}`;
          break;
        }
      }
    }

    console.log(`[attestor] Attestation UID: ${uid} (tx: ${txHash})`);
    return { uid, txHash };
  }
}
