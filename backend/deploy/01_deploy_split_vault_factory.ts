import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const FEE_BPS = 150; // 1.5%

/** USDC (Circle) por red. En redes locales se despliega un MockUSDC. */
const USDC: Record<string, string> = {
  avalancheFuji: "0x5425890298aed601595a70AB815c96711a31Bc65",
  avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // En redes reales, owner y tesorería son wallets frías distintas del deployer
  const owner = process.env.OWNER_ADDRESS || (network.live ? "" : deployer);
  const treasury = process.env.TREASURY_ADDRESS || (network.live ? "" : deployer);
  if (!ethers.isAddress(owner) || !ethers.isAddress(treasury)) {
    throw new Error("Define OWNER_ADDRESS y TREASURY_ADDRESS (direcciones públicas) para desplegar en una red real");
  }

  let usdc = USDC[network.name];
  if (!usdc) {
    const mock = await deploy("MockUSDC", { from: deployer, log: true });
    usdc = mock.address;
  }

  log("─────────────────────────────────────────────");
  log(`Red:       ${network.name} (chainId ${network.config.chainId})`);
  log(`Deployer:  ${deployer}`);
  log(`Owner:     ${owner}`);
  log(`Tesorería: ${treasury}`);
  log(`Fee:       ${FEE_BPS} bps (${FEE_BPS / 100}%)`);
  log(`USDC:      ${usdc}`);
  log("─────────────────────────────────────────────");

  const result = await deploy("SplitVaultFactory", {
    from: deployer,
    args: [owner, treasury, FEE_BPS, usdc],
    log: true,
    waitConfirmations: network.live ? 2 : 1,
  });

  const factory = await ethers.getContractAt("SplitVaultFactory", result.address);
  const implementation = await factory.implementation();

  log("─────────────────────────────────────────────");
  log(`SplitVaultFactory (v2):  ${result.address}`);
  log(`SplitVault (impl base):  ${implementation}`);

  if (network.name === "avalancheFuji") {
    log("");
    log("Snowtrace:");
    log(`  https://testnet.snowtrace.io/address/${result.address}`);
    log(`  https://testnet.snowtrace.io/address/${implementation}`);
    log("");
    log("Comandos de verificación:");
    log(
      `  npx hardhat verify --network avalancheFuji ${result.address} ${owner} ${treasury} ${FEE_BPS} ${usdc}`
    );
    log(`  npx hardhat verify --network avalancheFuji ${implementation}`);
  }
  log("─────────────────────────────────────────────");
};

func.tags = ["SplitVaultFactory"];
export default func;