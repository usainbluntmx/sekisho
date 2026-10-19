import { ethers, deployments, network } from "hardhat";

const USDC_FUJI = "0x5425890298aed601595a70AB815c96711a31Bc65";
const AMOUNT = ethers.parseUnits("1", 6); // 1 USDC
const EXPLORER = "https://testnet.snowtrace.io";

const USDC_ABI = [
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
];

const fmt = (amount: bigint) => ethers.formatUnits(amount, 6);

async function main() {
  if (network.name !== "avalancheFuji") {
    throw new Error("Ejecuta este script con --network avalancheFuji");
  }

  const [payer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  const usdc = new ethers.Contract(USDC_FUJI, USDC_ABI, payer);
  const { address: factoryAddress } = await deployments.get("SplitVaultFactory");
  const factory = await ethers.getContractAt("SplitVaultFactory", factoryAddress, payer);

  const merchant = process.env.MERCHANT_ADDRESS || ethers.Wallet.createRandom().address;
  const treasury = await factory.treasury();

  console.log("─────────────────────────────────────────────");
  console.log("Factory:   ", factoryAddress);
  console.log("Agente:    ", payer.address);
  console.log("Vendedor:  ", merchant);
  console.log("Tesorería: ", treasury);
  console.log("─────────────────────────────────────────────");

  // 1) payTo = vault predicho del vendedor (puede no existir todavía)
  const payTo = await factory.predictVault(merchant);
  console.log("[1] payTo (vault predicho):", payTo);

  // 2) El agente firma la autorización EIP-3009 (lo que viaja en x402)
  const name: string = await usdc.name();
  let version = "2";
  try {
    version = await usdc.version();
  } catch {
    // USDC de Circle usa "2" como versión del dominio EIP-712
  }

  const domain = { name, version, chainId, verifyingContract: USDC_FUJI };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from: payer.address,
    to: payTo,
    value: AMOUNT,
    validAfter: 0,
    validBefore: now + 600, // válida 10 minutos
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };

  const signature = await payer.signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(signature);
  console.log(`[2] Firma EIP-3009 creada (dominio: "${name}" v${version})`);

  // 3) El facilitator liquida el pago on-chain
  const settleTx = await usdc.transferWithAuthorization(
    message.from,
    message.to,
    message.value,
    message.validAfter,
    message.validBefore,
    message.nonce,
    v,
    r,
    s
  );
  await settleTx.wait();
  console.log(`[3] Pago liquidado: ${EXPLORER}/tx/${settleTx.hash}`);
  console.log("    Saldo en el vault:", fmt(await usdc.balanceOf(payTo)), "USDC");

  // 4) Crear el vault (si no existe) y repartir
  if ((await factory.vaultOf(merchant)) === ethers.ZeroAddress) {
    const createTx = await factory.createVault(merchant);
    await createTx.wait();
    console.log(`[4] Vault creado: ${EXPLORER}/tx/${createTx.hash}`);
  } else {
    console.log("[4] El vault ya existía");
  }

  const vault = await ethers.getContractAt("SplitVault", payTo, payer);
  const [total, fee, merchantAmount] = await vault.pending(USDC_FUJI);
  console.log(`    Reparto previsto: total ${fmt(total)} | fee ${fmt(fee)} | vendedor ${fmt(merchantAmount)}`);

  const treasuryBefore: bigint = await usdc.balanceOf(treasury);
  const distributeTx = await vault.distribute(USDC_FUJI);
  await distributeTx.wait();
  console.log(`[5] Reparto ejecutado: ${EXPLORER}/tx/${distributeTx.hash}`);

  // 5) Resultado final
  const treasuryAfter: bigint = await usdc.balanceOf(treasury);
  console.log("─────────────────────────────────────────────");
  console.log("Vendedor recibió: ", fmt(await usdc.balanceOf(merchant)), "USDC");
  console.log("Tesorería recibió:", fmt(treasuryAfter - treasuryBefore), "USDC");
  console.log("Saldo del vault:  ", fmt(await usdc.balanceOf(payTo)), "USDC");
  console.log("Vault en Snowtrace:", `${EXPLORER}/address/${payTo}`);
  console.log("─────────────────────────────────────────────");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});