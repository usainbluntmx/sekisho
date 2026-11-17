/**
 * Página /wallet/<token>: pide la cuenta a la wallet inyectada y firma el mensaje con
 * personal_sign (EIP-191). No usa la red ni manda transacciones.
 */
declare global {
  interface Window {
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

const root = document.getElementById("wallet")!;
const token = root.dataset.token!;
// El mensaje viaja codificado para que llegue byte por byte igual al que verifica el servidor
const message = decodeURIComponent(root.dataset.message!);
const button = document.getElementById("sign-button") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const setStatus = (text: string) => {
  statusEl.textContent = text;
};

function toHex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Sin wallet (p. ej. el navegador de Telegram): abrir la página en el navegador de una wallet
const noWallet = document.getElementById("no-wallet")!;
const openMetaMask = document.getElementById("open-metamask") as HTMLAnchorElement;
const copyLink = document.getElementById("copy-link") as HTMLButtonElement;
function showNoWallet(): void {
  openMetaMask.href = `https://link.metamask.io/dapp/${window.location.href.replace(/^https?:\/\//, "")}`;
  noWallet.hidden = false;
  button.hidden = true;
}
copyLink.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyLink.textContent = "✓ Link copiado";
  } catch {
    setStatus(`Copia este link: ${window.location.href}`);
  }
});
window.addEventListener("load", () => setTimeout(() => !window.ethereum && showNoWallet(), 400));

button.addEventListener("click", async () => {
  if (!window.ethereum) return showNoWallet();
  button.disabled = true;
  try {
    setStatus("Conectando tu wallet…");
    const [address] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
    setStatus("Firma el mensaje en tu wallet…");
    const signature = (await window.ethereum.request({ method: "personal_sign", params: [toHex(message), address] })) as string;
    setStatus("Verificando…");
    const res = await fetch(`/api/wallet/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    setStatus(body.message ?? body.error ?? (res.ok ? "Listo." : "No se pudo verificar la firma."));
    if (!res.ok) button.disabled = false;
    else button.hidden = true;
  } catch (error) {
    const code = (error as { code?: number }).code;
    setStatus(code === 4001 ? "Cancelaste la firma. Puedes intentarlo otra vez." : `No se pudo firmar: ${(error as Error).message ?? error}`);
    button.disabled = false;
  }
});

export {};
