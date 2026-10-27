import { formatUnits } from "viem";
import { createSekishoClient } from "../src/index.js";
import { MERCHANT, network } from "./env.js";

// SEKISHO_NETWORK=avalanche para leer mainnet (por defecto, Fuji)
const sekisho = createSekishoClient({ network });

const config = await sekisho.getConfig();
console.log("Config:", {
  ...config,
  fee: `${config.feeBps / 100}%`,
});

const payTo = await sekisho.getPayTo(MERCHANT);
console.log("payTo del vendedor:", payTo);
console.log("¿Vault desplegado?:", await sekisho.isVaultDeployed(MERCHANT));

const p = await sekisho.pending(MERCHANT);
console.log("Pendiente por repartir:", formatUnits(p.total, 6), "USDC");