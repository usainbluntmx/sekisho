import hre from "hardhat";

/** Lee la configuración on-chain de la factory desplegada en la red actual. */
async function main() {
  const { ethers, deployments, network } = hre;
  const address = (await deployments.get("SplitVaultFactory")).address;
  const factory = await ethers.getContractAt("SplitVaultFactory", address);

  console.log(`Red:             ${network.name}`);
  console.log(`Factory:         ${address}`);
  console.log(`Implementación:  ${await factory.implementation()}`);
  console.log(`Owner:           ${await factory.owner()}`);
  console.log(`Tesorería:       ${await factory.treasury()}`);
  console.log(`Fee:             ${await factory.feeBps()} bps (máx. ${await factory.MAX_FEE_BPS()})`);
  console.log(`Retraso de fee:  ${Number(await factory.FEE_CHANGE_DELAY()) / 86_400} días`);
  const [pendingFee, effectiveAt] = await factory.pendingFeeChange();
  console.log(
    effectiveAt === 0n
      ? "Cambio de fee:   ninguno programado"
      : `Cambio de fee:   ${pendingFee} bps desde ${new Date(Number(effectiveAt) * 1000).toISOString()}`
  );
  console.log(`Token (USDC):    ${await factory.settlementToken()}`);

  const merchant = process.env.MERCHANT_ADDRESS;
  if (merchant) {
    console.log(`\npayTo de ${merchant}: ${await factory.resolvePayTo(merchant)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});