import hre from "hardhat";

/**
 * Prueba real de la rotación de merchant (v2) con dos wallets desechables:
 *   1. Crea el vault del merchant A y le deposita 0.01 USDC (un "pago").
 *   2. A propone a B; B acepta.
 *   3. Comprueba: el pago previo fue para A (98.5%) y la tesorería (1.5%),
 *      el registro apunta a B y la dirección de A quedó retirada.
 * La wallet de PRIVATE_KEY paga el gas y aporta el USDC.
 */
const PAYMENT = 10_000n; // 0.01 USDC (6 decimales)
const GAS_FUNDING = hre.ethers.parseEther("0.005");

async function main() {
  const { ethers, deployments, network } = hre;
  if (!network.live) await deployments.fixture(["SplitVaultFactory"]);

  const [funder] = await ethers.getSigners();
  const factory = await ethers.getContractAt(
    "SplitVaultFactory",
    (await deployments.get("SplitVaultFactory")).address
  );
  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function mint(address,uint256)"],
    await factory.settlementToken()
  );
  if (!network.live) await usdc.mint(funder.address, PAYMENT);

  const funderUsdc: bigint = await usdc.balanceOf(funder.address);
  if (funderUsdc < PAYMENT) throw new Error(`La wallet ${funder.address} necesita al menos 0.01 USDC`);

  // Wallets desechables (solo viven durante el script)
  const a = ethers.Wallet.createRandom().connect(ethers.provider);
  const b = ethers.Wallet.createRandom().connect(ethers.provider);
  const confirm = async (tx: Promise<{ wait: () => Promise<unknown> }>) => (await tx).wait();

  console.log(`Red:      ${network.name}`);
  console.log(`Factory:  ${await factory.getAddress()}`);
  console.log(`Merchant A (anterior): ${a.address}`);
  console.log(`Merchant B (nuevo):    ${b.address}\n`);

  await confirm(funder.sendTransaction({ to: a.address, value: GAS_FUNDING }));
  await confirm(funder.sendTransaction({ to: b.address, value: GAS_FUNDING }));

  // 1) Vault de A y un pago pendiente
  await confirm(factory.createVault(a.address));
  const vaultAddress = await factory.vaultOf(a.address);
  const vault = await ethers.getContractAt("SplitVault", vaultAddress);
  await confirm(usdc.transfer(vaultAddress, PAYMENT));
  console.log(`✔ Vault de A: ${vaultAddress} con 0.01 USDC pendiente`);

  const treasury = await factory.treasury();
  const treasuryBefore: bigint = await usdc.balanceOf(treasury);

  // 2) Rotación en dos pasos
  await confirm(vault.connect(a).proposeMerchant(b.address));
  console.log("✔ A propuso a B");
  const accept = await vault.connect(b).acceptMerchant();
  const receipt = await accept.wait();
  console.log(`✔ B aceptó · tx ${accept.hash} · gas ${receipt!.gasUsed}`);

  // 3) Comprobaciones
  const checks: [string, boolean][] = [
    ["A recibió el 98.5% del pago previo", (await usdc.balanceOf(a.address)) === (PAYMENT * 9850n) / 10000n],
    ["La tesorería recibió el 1.5%", (await usdc.balanceOf(treasury)) - treasuryBefore === (PAYMENT * 150n) / 10000n],
    ["B no recibió nada del pago previo", (await usdc.balanceOf(b.address)) === 0n],
    ["El vault ahora es de B", (await vault.merchant()) === b.address],
    ["vaultOf(B) apunta al vault", (await factory.vaultOf(b.address)) === vaultAddress],
    ["vaultOf(A) quedó vacío", (await factory.vaultOf(a.address)) === ethers.ZeroAddress],
    ["resolvePayTo(B) devuelve el vault", (await factory.resolvePayTo(b.address)) === vaultAddress],
  ];
  let retired = false;
  try {
    await factory.resolvePayTo(a.address);
  } catch (error) {
    // Decodifica el error personalizado del contrato a partir de los datos del revert
    const data = (error as { data?: string }).data;
    retired = !!data && factory.interface.parseError(data)?.name === "MerchantRetired";
  }
  checks.push(["resolvePayTo(A) revierte (MerchantRetired)", retired]);

  console.log("");
  let failures = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "✔" : "✘"} ${label}`);
    if (!ok) failures++;
  }
  const explorer = { avalancheFuji: "https://testnet.snowtrace.io", avalanche: "https://snowtrace.io" }[network.name];
  if (explorer) console.log(`\nSnowtrace: ${explorer}/tx/${accept.hash}`);

  // 4) Devolver al funder lo que quedó en las wallets desechables (sus llaves se pierden al terminar)
  for (const wallet of [a, b]) await refund(wallet, funder.address, usdc);
  if (failures > 0) {
    process.exitCode = 1;
    console.error(`\n❌ ${failures} comprobación(es) fallaron`);
  } else {
    console.log("\n✅ Rotación verificada on-chain");
  }
}

/** Regresa el USDC y el AVAX sobrante de una wallet desechable (deja solo el gas de las transferencias). */
async function refund(
  wallet: { address: string; sendTransaction: (tx: object) => Promise<{ wait: () => Promise<unknown> }> },
  to: string,
  usdc: { balanceOf: (a: string) => Promise<bigint>; connect: (w: object) => { transfer: (to: string, v: bigint) => Promise<{ wait: () => Promise<unknown> }> } }
): Promise<void> {
  const { ethers } = hre;
  const usdcLeft: bigint = await usdc.balanceOf(wallet.address);
  if (usdcLeft > 0n) await (await usdc.connect(wallet).transfer(to, usdcLeft)).wait();

  const fee = await ethers.provider.getFeeData();
  const maxFeePerGas = (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 2n;
  const balance = await ethers.provider.getBalance(wallet.address);
  const value = balance - 21_000n * maxFeePerGas;
  if (value > 0n) {
    await (
      await wallet.sendTransaction({ to, value, gasLimit: 21_000n, maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n })
    ).wait();
  }
  console.log(`↩ Devuelto de ${wallet.address}: ${ethers.formatUnits(usdcLeft, 6)} USDC y ${ethers.formatEther(value > 0n ? value : 0n)} AVAX`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});