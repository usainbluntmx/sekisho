import hre from "hardhat";

/**
 * Vacía la wallet de PRIVATE_KEY (p. ej. la llave de despliegue, de un solo uso):
 * manda todo su USDC y su AVAX (menos el gas) a SWEEP_TO.
 * Uso: SWEEP_TO=0x… npx hardhat run scripts/sweep.ts --network avalanche
 */
async function main() {
  const { ethers, deployments, network } = hre;
  const to = process.env.SWEEP_TO ?? "";
  if (!ethers.isAddress(to)) throw new Error("Define SWEEP_TO con la dirección que recibe los fondos");

  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("SplitVaultFactory", (await deployments.get("SplitVaultFactory")).address);
  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"],
    await factory.settlementToken()
  );

  console.log(`Red:     ${network.name}`);
  console.log(`Desde:   ${signer.address}`);
  console.log(`Hacia:   ${to}\n`);

  const usdcBalance: bigint = await usdc.balanceOf(signer.address);
  if (usdcBalance > 0n) {
    const tx = await usdc.transfer(to, usdcBalance);
    await tx.wait();
    console.log(`✔ USDC: ${ethers.formatUnits(usdcBalance, 6)} · tx ${tx.hash}`);
  } else {
    console.log("· USDC: sin saldo");
  }

  // AVAX: todo menos el gas de una transferencia simple (21 000) al precio máximo actual
  const fee = await ethers.provider.getFeeData();
  const maxFeePerGas = fee.maxFeePerGas!;
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n;
  const gasCost = 21_000n * maxFeePerGas;
  const balance = await ethers.provider.getBalance(signer.address);
  if (balance > gasCost) {
    const tx = await signer.sendTransaction({
      to,
      value: balance - gasCost,
      gasLimit: 21_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    await tx.wait();
    console.log(`✔ AVAX: ${ethers.formatEther(balance - gasCost)} · tx ${tx.hash}`);
  } else {
    console.log("· AVAX: el saldo no cubre el gas");
  }

  const left = await ethers.provider.getBalance(signer.address);
  console.log(`\nQueda en la wallet: ${ethers.formatEther(left)} AVAX (polvo del margen de gas)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});