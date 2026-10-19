import { formatUnits } from "viem";
import { createSekishoClient } from "../src/index.js";

const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae";

const sekisho = createSekishoClient({ network: "avalancheFuji" });

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