/** Pruebas de la revisión previa a mainnet (sin red: los datos se arman a mano). */
import { parseEther } from "viem";
import { EXPECTED_TREASURY, evaluateMainnet, formatReport, type MainnetFacts } from "../mainnet-check.js";
import { oneLine } from "../errors.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "✔" : "✘"} ${name}`);
  if (!ok) failures++;
}

const VAULT = "0x449d38883418c750DFF8D1a4DF183d6A276789a0";
const healthy = (): MainnetFacts => ({
  chainId: 43114,
  config: { factory: "0xeB43A8b678E0b4ee7f11bd2867bC8B5EaC9444A6", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", treasury: EXPECTED_TREASURY, feeBps: 150, feeChange: null },
  usdc: { symbol: "USDC", decimals: 6 },
  operator: "0x0aD57dB2feC0ab359d821Ff1083c6747deD89A61",
  operatorWei: parseEther("0.5"),
  stores: [{ id: "cafe-kanjo", name: "Café Kanjō", merchant: "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae", verified: true, owner: "tg-1", payTo: { ok: true, vault: VAULT } }],
  env: { PUBLIC_BASE_URL: "https://kanjo.zerotwolabs.xyz", FX_MXN_PER_USDC: "18.6", KANJO_ADMIN_ID: "tg-1", AVALANCHE_RPC_URL: "https://rpc.example", NETWORK: "avalancheFuji" },
});
const levels = (f: MainnetFacts) => evaluateMainnet(f);
const fails = (f: MainnetFacts) => levels(f).filter((l) => l.level === "fail").map((l) => l.text);
const warns = (f: MainnetFacts) => levels(f).filter((l) => l.level === "warn").map((l) => l.text);

console.log("─── Revisión previa a mainnet ───");
check("Todo en orden → sin pendientes ni avisos, y 'Lista para mainnet'", fails(healthy()).length === 0 && warns(healthy()).length === 0 && /✅ Lista para mainnet/.test(formatReport(levels(healthy()))));
check("RPC de Fuji (43113) → falla: no es mainnet", fails({ ...healthy(), chainId: 43113 }).some((t) => /se esperaba 43114/.test(t)));
check("Tesorería distinta de la Safe → falla", fails({ ...healthy(), config: { ...healthy().config, treasury: "0x386De00589C783F454D237705b06F7C0d9D18f2c" } }).some((t) => /Tesorería/.test(t)));
check("Token que no es USDC de 6 decimales → falla", fails({ ...healthy(), usdc: { symbol: "USDC.e", decimals: 6 } }).some((t) => /se esperaba USDC/.test(t)));
check("Operador con 0.048 AVAX → falla y dice cuánto necesita", fails({ ...healthy(), operatorWei: parseEther("0.048") }).some((t) => /0\.0480 AVAX — necesita al menos 0\.2/.test(t)));
check("Sin tiendas publicadas → falla", fails({ ...healthy(), stores: [] }).some((t) => /No hay tiendas publicadas/.test(t)));
check("Una tienda con el vault rotado (getPayTo lanza) → falla con el motivo", fails({ ...healthy(), stores: [{ ...healthy().stores[0], payTo: { ok: false, error: "VaultRotated" } }] }).some((t) => /VaultRotated/.test(t)));
check("PUBLIC_BASE_URL sin https → falla", fails({ ...healthy(), env: { ...healthy().env, PUBLIC_BASE_URL: "http://localhost:3000" } }).some((t) => /debe ser https/.test(t)));
const soft: MainnetFacts = {
  ...healthy(),
  config: { ...healthy().config, feeChange: { feeBps: 200, effectiveAt: new Date("2026-12-01T00:00:00Z") } },
  stores: [{ ...healthy().stores[0], verified: false, owner: null }],
  env: { ...healthy().env, AVALANCHE_RPC_URL: undefined, FX_MXN_PER_USDC: undefined, KANJO_ADMIN_ID: undefined },
};
check("Avisos (no bloquean): sin RPC propia, cambio de comisión, wallet sin firmar, sin dueño ni MERCHANT_WA_ID, sin FX ni admin", fails(soft).length === 0 && warns(soft).length === 6);
check("Con MERCHANT_WA_ID, una tienda sin dueño ya no avisa", !warns({ ...soft, env: { ...soft.env, MERCHANT_WA_ID: "tg-1" } }).some((t) => /no tiene dueño/.test(t)));
check("El reporte cuenta los pendientes", /❌ 1 pendiente\(s\) que impiden ir a mainnet/.test(formatReport(levels({ ...healthy(), chainId: 1 }))));

console.log("─── Errores del repartidor en una línea ───");
const viemLike = Object.assign(new Error("The request took too long to respond.\n\nURL: https://rpc\nRequest body: {...}\n\nDetails: The request timed out.\nVersion: viem@2"), {
  shortMessage: "The request took too long to respond.",
  details: "The request timed out.",
});
check("Un error de viem se resume en una línea con su causa", oneLine(viemLike) === "The request took too long to respond. (The request timed out.)");
check("Un error común queda en su primera línea", oneLine(new Error("falló\nstack")) === "falló");

console.log(failures ? `\n❌ ${failures} prueba(s) fallaron` : "\n✅ Todas las pruebas pasaron");
process.exit(failures ? 1 : 0);
