import { ethers } from "hardhat";

const USDC_FUJI = "0x5425890298aed601595a70AB815c96711a31Bc65";

async function main() {
  const [signer] = await ethers.getSigners();
  const address = await signer.getAddress();

  const network = await ethers.provider.getNetwork();
  const avax = await ethers.provider.getBalance(address);

  const usdc = new ethers.Contract(
    USDC_FUJI,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider
  );
  const usdcBalance: bigint = await usdc.balanceOf(address);

  console.log("Chain ID:", network.chainId.toString());
  console.log("Address: ", address);
  console.log("AVAX:    ", ethers.formatEther(avax));
  console.log("USDC:    ", ethers.formatUnits(usdcBalance, 6));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});