import { createWalletClient, custom, type Address } from "viem";
import { avalancheFuji } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

declare global {
  interface Window {
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

const NETWORK = `eip155:${avalancheFuji.id}` as const;

const root = document.getElementById("checkout")!;
const orderId = root.dataset.orderId!;
const payToken = root.dataset.payToken!;
const amount = root.dataset.amount!;
const asset = root.dataset.asset as Address;
const explorer = root.dataset.explorer!;

const button = document.getElementById("pay-button") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const setStatus = (html: string) => {
  statusEl.innerHTML = html;
};

// ───── Sin wallet (p. ej. el navegador de WhatsApp): abrir el pedido en el navegador de una wallet ─────
const noWallet = document.getElementById("no-wallet");
const openMetaMask = document.getElementById("open-metamask") as HTMLAnchorElement | null;
const copyLink = document.getElementById("copy-link") as HTMLButtonElement | null;

function showNoWallet(): void {
  if (!noWallet || !openMetaMask) return;
  // Deeplink oficial de MetaMask: abre la URL (sin protocolo) en su navegador interno
  const target = window.location.href.replace(/^https?:\/\//, "");
  openMetaMask.href = `https://link.metamask.io/dapp/${target}`;
  noWallet.hidden = false;
  button.hidden = true;
  setStatus("");
}

copyLink?.addEventListener("click", async () => {
  const link = window.location.href;
  try {
    await navigator.clipboard.writeText(link);
    copyLink.textContent = "✓ Link copiado";
  } catch {
    // Sin permiso de portapapeles: mostrar el link para copiarlo a mano
    setStatus(`Copia este link: <br/><code style="word-break:break-all">${link.replaceAll("<", "&lt;")}</code>`);
  }
});

// Las wallets inyectan window.ethereum al cargar; se revisa poco después de la carga
function checkWallet(): void {
  setTimeout(() => {
    if (!window.ethereum) showNoWallet();
  }, 400);
}
if (document.readyState === "complete") checkWallet();
else window.addEventListener("load", checkWallet);

button.addEventListener("click", async () => {
  if (!window.ethereum) {
    showNoWallet();
    return;
  }

  button.disabled = true;

  try {
    const wallet = createWalletClient({ chain: avalancheFuji, transport: custom(window.ethereum) });

    setStatus("Conectando tu wallet…");
    const [address] = await wallet.requestAddresses();

    // La firma EIP-712 exige estar en la misma red del dominio (Fuji)
    try {
      await wallet.switchChain({ id: avalancheFuji.id });
    } catch {
      await wallet.addChain({ chain: avalancheFuji });
      await wallet.switchChain({ id: avalancheFuji.id });
    }

    const signer = {
      address,
      signTypedData: (args: any) => wallet.signTypedData({ account: address, ...args }),
    };

    // Solo autoriza USDC de Fuji y nunca más que el total del pedido
    const client = x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new ExactEvmScheme(signer) }],
      spendControls: {
        allowedAssets: [{ network: NETWORK, asset, maxAmountPerPayment: amount }],
      },
    });

    const payFetch = wrapFetchWithPayment(fetch, client);

    setStatus("Preparando el pago…");
    const response = await payFetch(
      `/api/pay?order=${encodeURIComponent(orderId)}&t=${encodeURIComponent(payToken)}`
    );

    // El servidor rechazó el cobro antes de liquidar (ya pagado, sin stock, pago en proceso)
    if ([404, 409, 429, 503].includes(response.status)) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setStatus(`⚠️ ${body.error ?? "Este pedido ya no se puede pagar."}`);
      button.disabled = false;
      return;
    }

    const result = await new x402HTTPClient(client).processResponse(response);

    if (response.ok && result.paymentStatus === "settled") {
      const tx = (result.header as { transaction?: string } | undefined)?.transaction;
      setStatus(
        `✅ <b>¡Pago confirmado!</b> Ya avisamos a la tienda.` +
          (tx ? `<br/><a href="${explorer}/tx/${tx}" target="_blank">Ver transacción</a>` : "")
      );
      button.remove();
    } else {
      setStatus(
        `No se pudo confirmar el pago (código ${response.status}). ` +
          `Si ves un cargo en tu wallet, escríbenos por WhatsApp con el pedido ${orderId}.`
      );
      button.disabled = false;
    }
  } catch (error) {
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    button.disabled = false;
  }
});