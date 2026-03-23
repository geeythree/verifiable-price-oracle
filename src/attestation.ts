import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  hashMessage,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { config, PRICE_SCHEMA } from './config.js';
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

// --- Attestor ---

export class Attestor {
  private account: HDAccount;
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private chain: Chain;
  private schemaUid: `0x${string}`;

  constructor() {
    if (!config.mnemonic) throw new Error('MNEMONIC not set');

    this.account = mnemonicToAccount(config.mnemonic);
    this.chain = config.chainId === 84532 ? baseSepolia : base;
    this.schemaUid = config.easSchemaUid;

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
    return (Number(bal) / 1e18).toFixed(6);
  }

  async registerSchema(): Promise<`0x${string}`> {
    if (this.schemaUid && this.schemaUid !== '0x') {
      console.log(`[attestor] Schema already set: ${this.schemaUid}`);
      return this.schemaUid;
    }

    console.log(`[attestor] Registering EAS schema: "${PRICE_SCHEMA}"`);

    const { request } = await this.publicClient.simulateContract({
      address: config.schemaRegistry,
      abi: SCHEMA_REGISTRY_ABI,
      functionName: 'register',
      args: [PRICE_SCHEMA, '0x0000000000000000000000000000000000000000', true],
      account: this.account,
    });

    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    // Extract schema UID from Registered event (first indexed topic after event sig)
    const registeredLog = receipt.logs.find(l => l.topics.length >= 2);
    if (!registeredLog?.topics[1]) throw new Error('No Registered event in receipt');

    this.schemaUid = registeredLog.topics[1] as `0x${string}`;
    console.log(`[attestor] Schema registered: ${this.schemaUid}`);
    console.log(`[attestor] Set EAS_SCHEMA_UID=${this.schemaUid} in .env for future runs`);
    return this.schemaUid;
  }

  // Off-chain signed attestation (always works, no gas needed)
  async signAttestation(result: PriceResult): Promise<AttestedPrice> {
    const priceUsd = BigInt(Math.round(result.median * 1e8));
    const timestamp = BigInt(Math.floor(result.timestamp / 1000));
    const sourceNames = JSON.stringify(result.sources.map(s => s.name));

    const encodedData = encodeAbiParameters(
      parseAbiParameters('string asset, uint256 priceUsd, uint8 sourceCount, uint64 timestamp, string sources'),
      [result.asset, priceUsd, result.sourceCount, timestamp, sourceNames]
    );

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
    if (!this.schemaUid || this.schemaUid === '0x') {
      throw new Error('Schema UID not set — call registerSchema() first');
    }

    const priceUsd = BigInt(Math.round(result.median * 1e8));
    const timestamp = BigInt(Math.floor(result.timestamp / 1000));
    const sourceNames = JSON.stringify(result.sources.map(s => s.name));

    const encodedData = encodeAbiParameters(
      parseAbiParameters('string asset, uint256 priceUsd, uint8 sourceCount, uint64 timestamp, string sources'),
      [result.asset, priceUsd, result.sourceCount, timestamp, sourceNames]
    );

    console.log(`[attestor] On-chain attesting ${result.asset} = $${result.median.toFixed(2)} (${result.sourceCount} sources)`);

    const { request } = await this.publicClient.simulateContract({
      address: config.easContract,
      abi: EAS_ABI,
      functionName: 'attest',
      args: [{
        schema: this.schemaUid,
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
    const attestedLog = receipt.logs.find(l => l.topics.length >= 3);
    let uid = '0x';
    if (attestedLog && attestedLog.data) {
      uid = attestedLog.data;
    }

    console.log(`[attestor] Attestation UID: ${uid} (tx: ${txHash})`);
    return { uid, txHash };
  }
}
