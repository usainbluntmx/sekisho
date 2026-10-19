import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const FEE_BPS = 150; // 1.5%

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const owner = deployer;
  const treasury = deployer;

  log("─────────────────────────────────────────────");
  log(`Red:       ${network.name} (chainId ${network.config.chainId})`);
  log(`Deployer:  ${deployer}`);
  log(`Tesorería: ${treasury}`);
  log(`Fee:       ${FEE_BPS} bps (${FEE_BPS / 100}%)`);
  log("─────────────────────────────────────────────");

  const result = await deploy("SplitVaultFactory", {
    from: deployer,
    args: [owner, treasury, FEE_BPS],
    log: true,
    waitConfirmations: network.live ? 2 : 1,
  });

  const factory = await ethers.getContractAt("SplitVaultFactory", result.address);
  const implementation = await factory.implementation();

  log("─────────────────────────────────────────────");
  log(`SplitVaultFactory:      ${result.address}`);
  log(`SplitVault (impl base): ${implementation}`);

  if (network.name === "avalancheFuji") {
    log("");
    log("Snowtrace:");
    log(`  https://testnet.snowtrace.io/address/${result.address}`);
    log(`  https://testnet.snowtrace.io/address/${implementation}`);
    log("");
    log("Comandos de verificación:");
    log(
      `  npx hardhat verify --network avalancheFuji ${result.address} ${owner} ${treasury} ${FEE_BPS}`
    );
    log(`  npx hardhat verify --network avalancheFuji ${implementation}`);
  }
  log("─────────────────────────────────────────────");
};

func.tags = ["SplitVaultFactory"];
export default func;