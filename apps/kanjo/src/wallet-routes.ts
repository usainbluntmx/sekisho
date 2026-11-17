import type { Hono, MiddlewareHandler } from "hono";
import { getWalletLink, isLinkExpired, verifyWalletLink, walletMessage } from "./wallet-link.js";
import { onWalletVerified } from "./onboarding.js";
import { renderWalletNotice, renderWalletPage } from "./web/wallet-page.js";

/** Página para firmar (/wallet/<token>) y su API (/api/wallet/<token>). */
export function registerWalletRoutes(app: Hono, limit?: MiddlewareHandler): void {
  if (limit) {
    app.use("/wallet/*", limit);
    app.use("/api/wallet/*", limit);
  }

  app.get("/wallet/:token", (c) => {
    const link = getWalletLink(c.req.param("token"));
    if (!link) return c.html(renderWalletNotice("Link no encontrado", "Pide uno nuevo en el chat con /wallet."), 404);
    if (link.status !== "open") return c.html(renderWalletNotice("Link ya usado", "Esta firma ya se recibió. Revisa el chat."), 410);
    if (isLinkExpired(link)) return c.html(renderWalletNotice("Link vencido", "Pide uno nuevo en el chat con /wallet."), 410);
    return c.html(renderWalletPage({ token: link.token, storeName: link.store_name, change: Boolean(link.store_id), message: walletMessage(link) }));
  });

  app.post("/api/wallet/:token", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { address?: unknown; signature?: unknown };
    if (typeof body.address !== "string" || typeof body.signature !== "string") {
      return c.json({ error: "Faltan la dirección y la firma." }, 400);
    }
    const verified = await verifyWalletLink(c.req.param("token"), body.address, body.signature);
    if (!verified.ok) return c.json({ error: verified.error }, verified.status);
    const result = await onWalletVerified(verified.link);
    return c.json(result.ok ? { ok: true, message: result.message } : { error: result.message }, result.ok ? 200 : 409);
  });
}
