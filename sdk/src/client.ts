import {
    createPublicClient,
    createWalletClient,
    zeroAddress,
    type Account,
    type Address,
    type Hash,
    type PublicClient,
  } from "viem";
  import { splitVaultAbi, splitVaultFactoryAbi } from "./abi.js";
  import { NETWORKS, type NetworkConfig, type SekishoNetwork } from "./chains.js";
  import { createSekishoTransport } from "./transport.js";
  
  export interface SekishoClientOptions {
    network?: SekishoNetwork;
    /** RPC propia (o lista). Las públicas de la red quedan como respaldo. */
    rpcUrl?: string | readonly string[];
    /** Necesaria solo para escribir (createVault, distribute). */
    account?: Account;
  }
  
  export interface SekishoConfig {
    network: SekishoNetwork;
    chainId: number;
    factory: Address;
    usdc: Address;
    treasury: Address;
    feeBps: number;
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
    /** Tesorería y fee actuales de la plataforma. */
    getConfig(): Promise<SekishoConfig>;
    /** Dirección payTo del vendedor (su vault), exista o no todavía. */
    getPayTo(merchant: Address): Promise<Address>;
    isVaultDeployed(merchant: Address): Promise<boolean>;
    /** Crea el vault del vendedor. Requiere `account`. */
    createVault(merchant: Address): Promise<{ hash: Hash; vault: Address }>;
    /** Lo que se repartiría ahora mismo para el vendedor. */
    pending(merchant: Address, token?: Address): Promise<PendingSplit>;
    /** Reparte el saldo del vault (lo crea primero si hace falta). Requiere `account`. */
    distribute(merchant: Address, token?: Address): Promise<Hash>;
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
  
    async function getConfig(): Promise<SekishoConfig> {
      const [treasury, feeBps] = await Promise.all([
        publicClient.readContract({ address: factory, abi: splitVaultFactoryAbi, functionName: "treasury" }),
        publicClient.readContract({ address: factory, abi: splitVaultFactoryAbi, functionName: "feeBps" }),
      ]);
      return { network, chainId: config.chain.id, factory, usdc: config.usdc, treasury, feeBps };
    }
  
    async function getPayTo(merchant: Address): Promise<Address> {
      return publicClient.readContract({
        address: factory,
        abi: splitVaultFactoryAbi,
        functionName: "predictVault",
        args: [merchant],
      });
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
      const wallet = requireWallet();
      const hash = await wallet.writeContract({
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
        return { vault, deployed: false, total: 0n, fee: 0n, merchantAmount: 0n };
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
      const wallet = requireWallet();
      if (!(await isVaultDeployed(merchant))) {
        await createVault(merchant);
      }
      const vault = await getPayTo(merchant);
      const hash = await wallet.writeContract({
        address: vault,
        abi: splitVaultAbi,
        functionName: "distribute",
        args: [token],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    }
  
    return {
      network,
      config,
      publicClient,
      getConfig,
      getPayTo,
      isVaultDeployed,
      createVault,
      pending,
      distribute,
    };
  }