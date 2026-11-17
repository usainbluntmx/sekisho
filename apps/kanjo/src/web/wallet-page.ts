import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { escapeHtml, layout } from "./checkout-page.js";

/** Huella del bundle: cambia en cada build, así el navegador no usa una versión vieja. */
const WALLET_JS_VERSION = (() => {
  try {
    return createHash("sha256").update(readFileSync("public/wallet.js")).digest("hex").slice(0, 12);
  } catch {
    return String(Date.now());
  }
})();

export interface WalletPageData {
  token: string;
  storeName: string;
  /** true = cambiar la wallet de una tienda existente. */
  change: boolean;
  message: string;
}

/** Página para firmar el mensaje con la wallet del comerciante (EIP-191, sin gas). */
export function renderWalletPage({ token, storeName, change, message }: WalletPageData): string {
  return layout(
    "Firmar con tu wallet",
    `<div class="card" id="wallet" data-token="${escapeHtml(token)}" data-message="${encodeURIComponent(message)}">
      <h1>${escapeHtml(storeName)}</h1>
      <div class="muted">${change ? "Cambiar la wallet donde recibes tus cobros" : "Confirmar la wallet donde recibirás tus cobros"}</div>
      <p style="font-size:14px;line-height:1.5">Vas a firmar este mensaje. <b>No es una transacción:</b> no mueve fondos ni cuesta gas.</p>
      <pre style="white-space:pre-wrap;background:#f6f6f4;border-radius:12px;padding:12px;font-size:13px">${escapeHtml(message)}</pre>
      <button id="sign-button">Firmar con mi wallet</button>
      <div id="no-wallet" class="no-wallet" hidden>
        <p>Esta página necesita una wallet. Ábrela en el navegador de tu wallet:</p>
        <a id="open-metamask" class="btn-link" href="#">Abrir en MetaMask</a>
        <button id="copy-link" class="btn-outline">Copiar el link</button>
        <p class="muted" style="margin-top:12px">¿Usas Core? Copia el link y pégalo en su navegador (botón <b>Browser</b>).</p>
      </div>
      <div id="status"></div>
    </div>
    <script type="module" src="/public/wallet.js?v=${WALLET_JS_VERSION}"></script>`
  );
}

/** Link vencido, usado o inexistente. */
export function renderWalletNotice(title: string, text: string): string {
  return layout(title, `<div class="card"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(text)}</p></div>`);
}
