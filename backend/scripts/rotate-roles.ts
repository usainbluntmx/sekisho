import { ethers, deployments, network } from "hardhat";

const OPERATOR_AVAX = "1.0"; // gas para liquidar y repartir
const OWNER_AVAX = "0.1"; // gas para operaciones de administración
const EXPLORER = "https://testnet.snowtrace.io";

function requireAddress(name: string): string {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) throw new Error(`${name} inválida o faltante`);
  return ethers.getAddress(value);
}

async function main() {
  if (network.name !== "avalancheFuji") throw new Error("Ejecuta con --network avalancheFuji");

  const [current] = await ethers.getSigners();
  const newOwner = requireAddress("NEW_OWNER");
  const newTreasury = requireAddress("NEW_TREASURY");
  const newOperator = requireAddress("NEW_OPERATOR");

  const all = [current.address, newOwner, newTreasury, newOperator].map((a) => a.toLowerCase());
  if (new Set(all).size !== 4) throw new Error("Las 4 direcciones (actual y 3 nuevas) deben ser distintas");

  // Antes de transferir: la llave del nuevo owner DEBE corresponder a NEW_OWNER
  const ownerKey = process.env.OWNER_PRIVATE_KEY;
  if (!ownerKey) throw new Error("Falta OWNER_PRIVATE_KEY (cárgala con read -s)");
  const ownerWallet = new ethers.Wallet(ownerKey, ethers.provider);
  if (ownerWallet.address !== newOwner) {
    throw new Error(`OWNER_PRIVATE_KEY corresponde a ${ownerWallet.address}, no a NEW_OWNER (${newOwner}). Abortado.`);
  }

  const { address: factoryAddress } = await deployments.get("SplitVaultFactory");
  const factory = await ethers.getContractAt("SplitVaultFactory", factoryAddress, current);

  const currentOwner = await factory.owner();
  if (currentOwner !== current.address) {
    throw new Error(`El owner actual es ${currentOwner}; esta wallet no puede rotar roles`);
  }

  console.log("─────────────────────────────────────────────");
  console.log("Factory:       ", factoryAddress);
  console.log("Owner actual:  ", currentOwner);
  console.log("Nuevo owner:   ", newOwner, "✔ llave verificada");
  console.log("Nueva tesorería:", newTreasury);
  console.log("Nueva operadora:", newOperator);
  console.log("─────────────────────────────────────────────");

  // 1) Tesorería
  const t1 = await factory.setTreasury(newTreasury);
  await t1.wait();
  console.log(`[1] Tesorería actualizada:   ${EXPLORER}/tx/${t1.hash}`);

  // 2) Gas para la operadora y el nuevo owner
  const t2 = await current.sendTransaction({ to: newOperator, value: ethers.parseEther(OPERATOR_AVAX) });
  await t2.wait();
  console.log(`[2] ${OPERATOR_AVAX} AVAX → operadora:   ${EXPLORER}/tx/${t2.hash}`);

  const t3 = await current.sendTransaction({ to: newOwner, value: ethers.parseEther(OWNER_AVAX) });
  await t3.wait();
  console.log(`[3] ${OWNER_AVAX} AVAX → nuevo owner: ${EXPLORER}/tx/${t3.hash}`);

  // 3) Transferir ownership
  const t4 = await factory.transferOwnership(newOwner);
  await t4.wait();
  console.log(`[4] Ownership transferido:   ${EXPLORER}/tx/${t4.hash}`);

  // 4) Prueba de control: el nuevo owner firma una operación sin efecto (mismo fee)
  const feeBps = await factory.feeBps();
  const t5 = await factory.connect(ownerWallet).setFeeBps(feeBps);
  await t5.wait();
  console.log(`[5] Prueba de control OK:    ${EXPLORER}/tx/${t5.hash}`);

  // 5) Estado final
  const [owner, treasury, fee] = await Promise.all([factory.owner(), factory.treasury(), factory.feeBps()]);
  console.log("─────────────────────────────────────────────");
  console.log("owner():    ", owner, owner === newOwner ? "✔" : "✘");
  console.log("treasury(): ", treasury, treasury === newTreasury ? "✔" : "✘");
  console.log("feeBps():   ", fee.toString(), fee === feeBps ? "✔ sin cambios" : "✘");
  console.log("¿La wallet actual conserva algún rol?:", owner === current.address || treasury === current.address ? "SÍ ✘" : "No ✔");
  console.log("─────────────────────────────────────────────");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});