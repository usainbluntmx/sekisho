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
const amount = root.dataset.amount!;
const asset = root.dataset.asset as Address;
const explorer = root.dataset.explorer!;

const button = document.getElementById("pay-button") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const setStatus = (html: string) => {
  statusEl.innerHTML = html;
};

button.addEventListener("click", async () => {
  if (!window.ethereum) {
    setStatus("Necesitas una wallet en tu navegador (Core o MetaMask) para pagar.");
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

    setStatus("Firma el pago en tu wallet…");
    const response = await payFetch(`/api/pay?order=${encodeURIComponent(orderId)}`);
    const result = await new x402HTTPClient(client).processResponse(response);

    if (response.ok && result.paymentStatus === "settled") {
      const tx = (result.header as { transaction?: string } | undefined)?.transaction;
      setStatus(
        `✅ <b>¡Pago confirmado!</b> Ya avisamos a la tienda.` +
          (tx ? `<br/><a href="${explorer}/tx/${tx}" target="_blank">Ver transacción</a>` : "")
      );
      button.remove();
    } else {
      setStatus(`No se pudo completar el pago (código ${response.status}). Intenta de nuevo.`);
      button.disabled = false;
    }
  } catch (error) {
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    button.disabled = false;
  }
});