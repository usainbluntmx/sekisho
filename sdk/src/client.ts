import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  zeroAddress,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { erc20Abi, splitVaultAbi, splitVaultFactoryAbi } from "./abi.js";
import { NETWORKS, type NetworkConfig, type SekishoNetwork } from "./chains.js";
import { createSekishoTransport } from "./transport.js";
import { settlementGasLimit } from "./gas.js";

export interface SekishoClientOptions {
  network?: SekishoNetwork;
  /** RPC propia (o lista). Las públicas de la red quedan como respaldo. */
  rpcUrl?: string | readonly string[];
  /** Necesaria solo para escribir (createVault, distribute, rotación). */
  account?: Account;
}

export interface FeeChange {
  /** Fee que aplicará (en bps). */
  feeBps: number;
  /** Desde cuándo aplica. */
  effectiveAt: Date;
}

export interface SekishoConfig {
  network: SekishoNetwork;
  chainId: number;
  factory: Address;
  usdc: Address;
  treasury: Address;
  /** Fee vigente en este momento (bps). */
  feeBps: number;
  /** Cambio de fee programado que todavía no aplica, o null. */
  feeChange: FeeChange | null;
}

export interface PendingSplit {
  vault: Address;
  deployed: boolean;
  total: bigint;
  fee: bigint;
  merchantAmount: bigint;
}

export interface SekishoClient {
  network: SekishoNetwork;
  config: NetworkConfig;
  publicClient: PublicClient;
  /** Tesorería, fee vigente y cambio de fee programado (si hay). */
  getConfig(): Promise<SekishoConfig>;
  /** Cambio de fee programado que todavía no aplica (los cambios tardan 7 días), o null. */
  getFeeChange(): Promise<FeeChange | null>;
  /**
   * Dirección payTo del vendedor (su vault), exista o no todavía.
   * Si el vendedor rotó su vault a otra dirección, lanza un error: cobrarle ahí le pagaría a otro.
   */
  getPayTo(merchant: Address): Promise<Address>;
  isVaultDeployed(merchant: Address): Promise<boolean>;
  /** Crea el vault del vendedor. Requiere `account`. */
  createVault(merchant: Address): Promise<{ hash: Hash; vault: Address }>;
  /** Lo que se repartiría ahora mismo para el vendedor. */
  pending(merchant: Address, token?: Address): Promise<PendingSplit>;
  /** Reparte el saldo del vault (lo crea primero si hace falta). Requiere `account`. */
  distribute(merchant: Address, token?: Address): Promise<Hash>;
  /** Rotación, paso 1: el vendedor actual (`account`) propone su nueva dirección. address(0) cancela. */
  proposeMerchant(newMerchant: Address): Promise<Hash>;
  /** Rotación, paso 2: la nueva dirección (`account`) acepta el vault. Lo pendiente se reparte antes al vendedor anterior. */
  acceptMerchant(vault: Address): Promise<Hash>;
  /** Dirección propuesta que aún no acepta (zeroAddress si no hay). */
  pendingMerchant(vault: Address): Promise<Address>;
}

/** true si el error es el revert MerchantRetired() de la factory. */
function isMerchantRetired(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (e) => e instanceof ContractFunctionRevertedError && e.data?.errorName === "MerchantRetired"
    ) !== null
  );
}

export function createSekishoClient(options: SekishoClientOptions = {}): SekishoClient {
  const network = options.network ?? "avalancheFuji";
  const config = NETWORKS[network];

  if (!config.factory) {
    throw new Error(`Sekisho: la factory aún no está desplegada en "${network}"`);
  }
  const factory = config.factory;

  const transport = createSekishoTransport(config, options.rpcUrl);
  const publicClient = createPublicClient({ chain: config.chain, transport }) as PublicClient;
  const walletClient = options.account
    ? createWalletClient({ chain: config.chain, transport, account: options.account })
    : undefined;

  function requireWallet() {
    if (!walletClient) {
      throw new Error("Sekisho: esta operación requiere `account` en createSekishoClient()");
    }
    return walletClient;
  }

  /** Escribe en un contrato con gas estimado y acotado (una RPC con una estimación absurda no tumba la tx). */
  async function write(request: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hash> {
    const wallet = requireWallet();
    const call = { ...request, account: wallet.account } as any;
    const gas = settlementGasLimit(await publicClient.estimateContractGas(call));
    return wallet.writeContract({ ...call, gas });
  }

  async function getFeeChange(): Promise<FeeChange | null> {
    const [feeBps, effectiveAt] = await publicClient.readContract({
      address: factory,
      abi: splitVaultFactoryAbi,
      functionName: "pendingFeeChange",
    });
    return effectiveAt === 0n ? null : { feeBps, effectiveAt: new Date(Number(effectiveAt) * 1000) };
  }

  async function getConfig(): Promise<SekishoConfig> {
    const [treasury, feeBps, feeChange] = await Promise.all([
      publicClient.readContract({ address: factory, abi: splitVaultFactoryAbi, functionName: "treasury" }),
      publicClient.readContract({ address: factory, abi: splitVaultFactoryAbi, functionName: "feeBps" }),
      getFeeChange(),
    ]);
    return { network, chainId: config.chain.id, factory, usdc: config.usdc, treasury, feeBps, feeChange };
  }

  async function getPayTo(merchant: Address): Promise<Address> {
    try {
      return await publicClient.readContract({
        address: factory,
        abi: splitVaultFactoryAbi,
        functionName: "resolvePayTo",
        args: [merchant],
      });
    } catch (error) {
      if (isMerchantRetired(error)) {
        throw new Error(
          `Sekisho: ${merchant} rotó su vault a otra dirección; cóbrale a su dirección nueva`
        );
      }
      throw error;
    }
  }

  async function isVaultDeployed(merchant: Address): Promise<boolean> {
    const vault = await publicClient.readContract({
      address: factory,
      abi: splitVaultFactoryAbi,
      functionName: "vaultOf",
      args: [merchant],
    });
    return vault !== zeroAddress;
  }

  async function createVault(merchant: Address): Promise<{ hash: Hash; vault: Address }> {
    const hash = await write({
      address: factory,
      abi: splitVaultFactoryAbi,
      functionName: "createVault",
      args: [merchant],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return { hash, vault: await getPayTo(merchant) };
  }

  async function pending(merchant: Address, token: Address = config.usdc): Promise<PendingSplit> {
    const vault = await getPayTo(merchant);
    if (!(await isVaultDeployed(merchant))) {
      // El vault aún no existe, pero su dirección ya puede tener pagos: se calcula el reparto
      // con el saldo y el fee actual (distribute() lo creará y repartirá)
      const [total, feeBps] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
        publicClient.readContract({ address: factory, abi: splitVaultFactoryAbi, functionName: "feeBps" }),
      ]);
      const fee = (total * BigInt(feeBps)) / 10_000n;
      return { vault, deployed: false, total, fee, merchantAmount: total - fee };
    }
    const [total, fee, merchantAmount] = await publicClient.readContract({
      address: vault,
      abi: splitVaultAbi,
      functionName: "pending",
      args: [token],
    });
    return { vault, deployed: true, total, fee, merchantAmount };
  }

  async function distribute(merchant: Address, token: Address = config.usdc): Promise<Hash> {
    requireWallet();
    if (!(await isVaultDeployed(merchant))) {
      await createVault(merchant);
    }
    const vault = await getPayTo(merchant);
    const hash = await write({
      address: vault,
      abi: splitVaultAbi,
      functionName: "distribute",
      args: [token],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async function proposeMerchant(newMerchant: Address): Promise<Hash> {
    const wallet = requireWallet();
    const vault = await publicClient.readContract({
      address: factory,
      abi: splitVaultFactoryAbi,
      functionName: "vaultOf",
      args: [wallet.account.address],
    });
    if (vault === zeroAddress) {
      throw new Error(`Sekisho: ${wallet.account.address} no tiene un vault que rotar`);
    }
    const hash = await write({
      address: vault,
      abi: splitVaultAbi,
      functionName: "proposeMerchant",
      args: [newMerchant],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async function acceptMerchant(vault: Address): Promise<Hash> {
    const hash = await write({ address: vault, abi: splitVaultAbi, functionName: "acceptMerchant", args: [] });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async function pendingMerchant(vault: Address): Promise<Address> {
    return publicClient.readContract({ address: vault, abi: splitVaultAbi, functionName: "pendingMerchant" });
  }

  return {
    network,
    config,
    publicClient,
    getConfig,
    getFeeChange,
    getPayTo,
    isVaultDeployed,
    createVault,
    pending,
    distribute,
    proposeMerchant,
    acceptMerchant,
    pendingMerchant,
  };
}