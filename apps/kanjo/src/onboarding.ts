/**
 * Alta de comerciantes por chat (Telegram o WhatsApp), paso a paso y sin IA:
 *   /vender → nombre → giro → entrega → dirección/zona → horario → tiempo → wallet (y confirmación) → productos
 *   → borrador → /probar → /enviar → revisión → /aprobar (administrador) → publicada.
 * Cada respuesta se valida con las mismas reglas que las herramientas de consola, así que nada inválido se guarda.
 * Un borrador no lo ven los clientes ni los agentes de IA; solo su dueño, para probarlo.
 */
import { db } from "./db.js";
import { clearHistory } from "./memory.js";
import { enqueueNotification } from "./outbox.js";
import {
  createStore,
  deleteUnpublishedStore,
  getStore,
  getStoreByOwner,
  listProducts,
  listStoresByStatus,
  setCustomerStore,
  setStoreProfile,
  setStoreStatus,
  RESERVED_IDS,
  STORE_ID_RE,
  walletProblem,
  type Store,
} from "./store.js";
import { BUSINESS_TYPES, fulfillmentLine, validateProfile, type BusinessType, type StoreProfile } from "./store-profile.js";
import { TEMPLATES } from "./templates.js";
import { linesFromTemplate, parseCatalogLines } from "./catalog-lines.js";
import { applyCatalog, savePreview } from "./catalog-import.js";
import { normalizeName, type CatalogItem } from "./catalog-normalize.js";
import { formatQuantity, priceLabel } from "./units.js";
import { storeLink, telegramUsername } from "./telegram.js";
import {
  applyWalletChange,
  createWalletLink,
  markWalletLink,
  pendingWalletChange,
  setWalletVerified,
  walletLinkUrl,
  walletVerifiedAt,
  WALLET_LINK_MINUTES,
  type WalletLink,
} from "./wallet-link.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS onboarding (
    owner      TEXT PRIMARY KEY,
    step       TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

type Step =
  | "name"
  | "type"
  | "fulfillment"
  | "address"
  | "deliveryArea"
  | "hours"
  | "prep"
  | "wallet"
  | "walletConfirm"
  | "catalog"
  | "catalogConfirm"
  | "panel";

interface Draft {
  name?: string;
  businessType?: BusinessType;
  fulfillment?: StoreProfile["fulfillment"];
  address?: string;
  deliveryArea?: string;
  hours?: string;
  prepMinutes?: number;
  wallet?: string;
  /** La wallet se confirmó con una firma (no copiando la dirección). */
  walletVerified?: boolean;
  /** Productos ya validados, esperando el "sí". */
  catalog?: CatalogItem[];
}

const TYPE_ORDER: BusinessType[] = ["cafeteria", "abarrotes", "tlapaleria", "carniceria", "otro"];
const SKIP = /^(saltar|omitir|no|-)$/i;
const YES = /^(s[ií]|si|ok|listo|va|dale|confirmo|correcto)\.?$/i;

export function onboardingEnabled(): boolean {
  return process.env.MERCHANT_ONBOARDING === "on";
}

/** Administrador que aprueba tiendas (tg-… o número de WhatsApp). */
export function adminId(): string {
  return process.env.KANJO_ADMIN_ID?.trim() ?? "";
}

/** El canal web y los agentes de IA no dan de alta tiendas: no hay a quién avisarle después. */
export function canOnboard(customerId: string): boolean {
  return !customerId.startsWith("web-") && !customerId.startsWith("mcp-");
}

function maxDrafts(): number {
  return Number(process.env.ONBOARDING_MAX_DRAFTS ?? 50);
}

function draftDays(): number {
  return Number(process.env.ONBOARDING_DRAFT_DAYS ?? 14);
}

/**
 * Libera el cupo de altas (ONBOARDING_MAX_DRAFTS): borra los borradores sin actividad en
 * ONBOARDING_DRAFT_DAYS días y las altas a medias igual de viejas. Nunca toca tiendas en
 * revisión o publicadas, ni un borrador con algún pedido pagado. Avisa al dueño.
 */
export function expireStaleDrafts(days = draftDays()): string[] {
  const age = `-${Math.max(1, Math.floor(days))} days`;
  const stale = db
    .prepare(
      `SELECT s.id, s.name, s.owner FROM stores s
       LEFT JOIN onboarding o ON o.owner = s.owner
       WHERE s.status = 'draft' AND s.created_at < datetime('now', ?)
         AND (o.updated_at IS NULL OR o.updated_at < datetime('now', ?))`
    )
    .all(age, age) as { id: string; name: string; owner: string | null }[];

  const removed: string[] = [];
  for (const s of stale) {
    if (!deleteUnpublishedStore(s.id)) continue;
    removed.push(s.id);
    if (s.owner) {
      end(s.owner);
      enqueueNotification(
        `store-expired:${s.id}`,
        s.owner,
        `Borré el borrador de *${s.name}* porque no tuvo movimiento en ${Math.floor(days)} días. Cuando quieras, empieza de nuevo con /vender 🙂`
      );
    }
  }
  // Altas que nunca llegaron a crear la tienda (sin aviso: no hay nada que perder)
  db.prepare(
    "DELETE FROM onboarding WHERE updated_at < datetime('now', ?) AND owner NOT IN (SELECT owner FROM stores WHERE owner IS NOT NULL)"
  ).run(age);
  return removed;
}

// ─────────────── Sesión ───────────────

function load(owner: string): { step: Step; draft: Draft } | undefined {
  const row = db.prepare("SELECT step, data FROM onboarding WHERE owner = ?").get(owner) as { step: Step; data: string } | undefined;
  if (!row) return undefined;
  try {
    return { step: row.step, draft: JSON.parse(row.data) as Draft };
  } catch {
    return { step: row.step, draft: {} };
  }
}

function save(owner: string, step: Step, draft: Draft): void {
  db.prepare(
    `INSERT INTO onboarding (owner, step, data, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(owner) DO UPDATE SET step = excluded.step, data = excluded.data, updated_at = excluded.updated_at`
  ).run(owner, step, JSON.stringify(draft));
}

function end(owner: string): void {
  db.prepare("DELETE FROM onboarding WHERE owner = ?").run(owner);
}

/**
 * Mensajes que no gastan llamadas al agente y no deben contar para el límite por persona:
 * el administrador, quien está en medio del alta, y /vender.
 */
export function skipsChatLimit(from: string, text?: string): boolean {
  if (!onboardingEnabled()) return false;
  if (from === adminId()) return true;
  if (text?.trim().toLowerCase() === "/vender" || text?.trim().toLowerCase() === "/start vender") return true;
  return load(from) !== undefined;
}

// ─────────────── Textos ───────────────

/** Lo que el comerciante acepta antes de mandar su tienda a revisión (cambia la versión si cambia el texto). */
export const TERMS_VERSION = "2026-11";
export const TERMS_TEXT = [
  "Antes de mandarla a revisión, confirma que estás de acuerdo:",
  "",
  "• Tus clientes te pagan en *USDC en Avalanche*, directo a un contrato (vault) a tu nombre. Kanjō nunca guarda tu dinero.",
  "• De cada venta, el contrato te reparte el *98.5 %* a tu wallet y el *1.5 %* es la comisión de Sekisho. Los repartos se hacen por lotes.",
  "• Convertir tu USDC a pesos (o a tu moneda) y tus impuestos *te corresponden a ti*, con el exchange o servicio que prefieras.",
  "• Tú atiendes a tus clientes: entregas, cambios y reembolsos (un reembolso lo mandas tú desde tu wallet).",
  "• Cuida el acceso a tu wallet y a esta cuenta de chat: con ellos se administra tu tienda.",
  "",
  "Si estás de acuerdo, escribe: */enviar acepto*",
].join("\n");

const STATUS_LABEL: Record<Store["status"], string> = {
  draft: "📝 Borrador (solo tú la ves)",
  pending: "⏳ En revisión",
  published: "✅ Publicada",
};

async function linkFor(store: Store): Promise<string> {
  try {
    return storeLink(await telegramUsername(), store.id);
  } catch {
    return `escribe /tienda ${store.id} en el chat`;
  }
}

/** Link para firmar con la wallet (se crea uno nuevo cada vez: el anterior deja de servir). */
function walletPrompt(owner: string, draft: Draft): string {
  const link = createWalletLink(owner, draft.name ?? "tu tienda");
  return (
    "Ahora tu wallet en Avalanche: ahí te llegan tus ventas en USDC.\n\n" +
    "Para comprobar que es tuya, abre este link *desde el navegador de tu wallet* (MetaMask, Core…) y firma el mensaje. " +
    "Firmar no es una transacción: no mueve fondos ni cuesta gas.\n\n" +
    `${walletLinkUrl(link)}\n\n` +
    `El link dura ${WALLET_LINK_MINUTES} min. Si vence, escribe /wallet y te mando otro.\n` +
    "⚠️ Usa una wallet que controles tú, no la dirección de depósito de un exchange (no puede firmar)."
  );
}

function prompt(step: Step, draft: Draft, owner?: string): string {
  switch (step) {
    case "name":
      return "¿Cómo se llama tu negocio? (así lo verán tus clientes)";
    case "type":
      return `¿Qué tipo de negocio es? Responde con el número:\n${TYPE_ORDER.map((t, i) => `${i + 1}. ${t === "otro" ? "otro giro" : BUSINESS_TYPES[t]}`).join("\n")}`;
    case "fulfillment":
      return "¿Cómo reciben tus clientes su pedido?\n1. Pasan a recogerlo\n2. Se los llevas a domicilio\n3. Las dos";
    case "address":
      return "¿Cuál es la dirección donde recogen? (calle, número y colonia)";
    case "deliveryArea":
      return "¿En qué zona entregas a domicilio? (colonias, y si hay pedido mínimo dilo aquí)";
    case "hours":
      return 'Tu horario, como se lo dirías a un cliente (por ejemplo "Lunes a sábado, 9:00 a 19:00"). Si no quieres ponerlo, escribe *saltar*.';
    case "prep":
      return "¿En cuántos minutos queda listo un pedido normalmente? (solo el número, o *saltar*)";
    case "wallet":
    case "walletConfirm": // sesiones de antes de la firma: se les manda el link
      return owner ? walletPrompt(owner, draft) : "Escribe /wallet para recibir el link y firmar con tu wallet.";
    case "catalog": {
      const template = draft.businessType ? TEMPLATES[draft.businessType] : undefined;
      const example = template ? linesFromTemplate(template.catalog.items.slice(0, 4)) : "Producto de ejemplo, 50\nOtro producto, 120, kg, 5";
      return (
        "Ahora tus productos. Mándamelos en un solo mensaje, *uno por renglón*:\n\n" +
        "Nombre, precio en pesos, kg (si es por kilo), existencias\n\n" +
        `Por ejemplo:\n${example}\n\n` +
        "Sin «kg» se vende por pieza. Las existencias son opcionales. No uses comas en los precios (1200, no 1,200)."
      );
    }
    default:
      return "";
  }
}

/** Cerca del tope de Telegram (4096): una lista más larga llega partida en dos mensajes. */
const NEAR_TELEGRAM_LIMIT = 3800;
const SPLIT_HINT =
  "⚠️ Tu mensaje llegó casi al límite de Telegram (4096 caracteres). Si tu lista era más larga, Telegram la partió en otro mensaje y aquí falta el resto: revisa que estén todos tus productos, o mándame una lista más corta (nombres breves).";

function catalogPreview(items: CatalogItem[], message = ""): string {
  // El precio en pesos de vuelta (≈) para que se note si algo se leyó mal, por ejemplo "1,200" como 1 peso
  const fx = Number(process.env.FX_MXN_PER_USDC);
  const mxn = (atomic: number) => (fx > 0 ? ` (≈${Math.round((atomic / 1_000_000) * fx)} MXN)` : "");
  const lines = items.map(
    (i) =>
      `• ${i.name} — ${priceLabel(i.price_atomic, i.unit)}${mxn(i.price_atomic)}${i.stock !== undefined ? ` · hay ${formatQuantity(i.stock, i.unit)}` : ""}`
  );
  const hint = message.length >= NEAR_TELEGRAM_LIMIT ? `\n\n${SPLIT_HINT}` : "";
  return `${items.length} ${items.length === 1 ? "producto" : "productos"} (precios convertidos a USDC):\n${lines.join("\n")}${hint}\n\n¿Así está bien? Responde *sí* para guardarlos, o mándame la lista corregida.`;
}

async function panel(store: Store): Promise<string> {
  const products = listProducts(store.id).length;
  const lines = [
    `🏪 *${store.name}* (${store.id})`,
    `Estado: ${STATUS_LABEL[store.status]}`,
    `Productos: ${products}`,
    `Wallet: ${shortAddress(store.merchant_address)} ${walletVerifiedAt(store.id) ? "✅ firmada" : "⚠️ sin firmar (fírmala con /wallet)"}`,
    `Al pagar, tu cliente lee: "${fulfillmentLine(store.profile)}"`,
  ];
  if (store.status === "published") lines.push(`\nTu link para compartir:\n${await linkFor(store)}`);
  lines.push(
    "",
    "/probar — habla con tu tienda como cliente",
    "/productos — cambiar tus productos",
    "/perfil — cambiar entrega, dirección y horario",
    "/wallet — firmar tu wallet o cambiarla por otra"
  );
  if (store.status === "draft") lines.push("/enviar — mandarla a revisión para publicarla");
  if (store.status !== "published") lines.push("/cancelar — borrar el borrador");
  lines.push("/salir — volver al chat normal");
  return lines.join("\n");
}

function summaryForAdmin(store: Store): string {
  const products = listProducts(store.id);
  const p = store.profile;
  return [
    `🆕 *Tienda para revisar:* ${store.name} (${store.id})`,
    `Giro: ${BUSINESS_TYPES[p.businessType]}`,
    `Dueño: ${store.owner}`,
    `Wallet: ${store.merchant_address} ${walletVerifiedAt(store.id) ? "(✅ firmada)" : "(⚠️ sin firma)"}`,
    `Términos: ${termsAccepted(store.id) ? `✅ aceptados (${termsAccepted(store.id)})` : "⚠️ sin aceptar"}`,
    `Dirección: ${p.address || "—"} · Zona: ${p.deliveryArea || "—"}`,
    `Horario: ${p.hours || "—"} · Tiempo: ${p.prepMinutes ? `${p.prepMinutes} min` : "—"}`,
    `Productos (${products.length}):`,
    ...products.slice(0, 30).map((x) => `• ${x.name} — ${priceLabel(x.price_atomic, x.unit)}`),
    products.length > 30 ? `… y ${products.length - 30} más` : "",
    "",
    `/aprobar ${store.id}`,
    `/rechazar ${store.id} <motivo>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Id para el link: "Carnicería Don Pepe" → "carniceria-don-pepe" (con -2, -3… si ya existe). */
export function slugFor(name: string): string {
  const base =
    normalizeName(name)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34)
      .replace(/-+$/g, "") || "tienda";
  const padded = base.length < 3 ? `tienda-${base}` : base;
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? padded : `${padded}-${n}`;
    if (STORE_ID_RE.test(id) && !getStore(id) && !RESERVED_IDS.has(id)) return id;
  }
  return `${padded}-${Date.now().toString(36)}`;
}

function profileFrom(draft: Draft): unknown {
  return {
    businessType: draft.businessType ?? "otro",
    address: draft.address ?? "",
    hours: draft.hours ?? "",
    fulfillment: draft.fulfillment ?? "pickup",
    deliveryArea: draft.deliveryArea ?? "",
    ...(draft.prepMinutes ? { prepMinutes: draft.prepMinutes } : {}),
    ...(draft.businessType && TEMPLATES[draft.businessType]
      ? {
          description: String(TEMPLATES[draft.businessType]!.profile.description ?? ""),
          tone: String(TEMPLATES[draft.businessType]!.profile.tone ?? ""),
        }
      : {}),
  };
}

/** Siguiente paso del perfil según la forma de entrega. */
function afterFulfillment(draft: Draft): Step {
  return draft.fulfillment === "delivery" ? "deliveryArea" : "address";
}

/** Al editar algo de una tienda en revisión, vuelve a borrador (lo revisado ya no es lo que hay). */
function backToDraftIfPending(store: Store): string {
  if (store.status !== "pending") return "";
  setStoreStatus(store.id, "draft");
  return "\n\nComo cambiaste algo, tu tienda volvió a borrador: mándala otra vez con /enviar.";
}

// ─────────────── Administrador ───────────────

async function handleAdmin(text: string): Promise<string[] | null> {
  const [command, id, ...rest] = text.trim().split(/\s+/);
  const needsId = ["/ver", "/aprobar", "/rechazar", "/aprobarwallet", "/rechazarwallet"].includes(command.toLowerCase());
  if (needsId && !id) {
    const pending = listStoresByStatus("pending");
    const hint = pending.length ? `\nEn revisión: ${pending.map((s) => s.id).join(", ")}` : "\nNo hay tiendas en revisión.";
    return [`Falta el id de la tienda: ${command.toLowerCase()} <id>${["/rechazar", "/rechazarwallet"].includes(command.toLowerCase()) ? " <motivo>" : ""}${hint}`];
  }
  switch (command.toLowerCase()) {
    case "/pendientes": {
      const pending = listStoresByStatus("pending");
      const wallets = listStoresByStatus("published").filter((s) => pendingWalletChange(s.id));
      return [
        (pending.length ? `Tiendas en revisión:\n${pending.map((s) => `• ${s.name} — /ver ${s.id}`).join("\n")}` : "No hay tiendas en revisión.") +
          (wallets.length ? `\n\nCambios de wallet por aprobar:\n${wallets.map((s) => `• ${s.name} — /aprobarwallet ${s.id}`).join("\n")}` : ""),
      ];
    }
    case "/aprobarwallet": {
      const store = id ? getStore(id) : undefined;
      const change = store ? pendingWalletChange(store.id) : undefined;
      if (!store || !change) return ["Esa tienda no tiene un cambio de wallet por aprobar. Usa /pendientes."];
      const result = await applyWalletChange(change.token);
      if (!result.ok) return [`No se aplicó: ${result.error}`];
      notifyWalletChanged(result.store, result.oldAddress, result.splitTx);
      return [`✅ Wallet de ${store.name} cambiada: ${result.oldAddress} → ${result.store.merchant_address}${result.splitTx ? `\nReparto previo del vault anterior: ${result.splitTx}` : ""}`];
    }
    case "/rechazarwallet": {
      const store = id ? getStore(id) : undefined;
      const change = store ? pendingWalletChange(store.id) : undefined;
      if (!store || !change) return ["Esa tienda no tiene un cambio de wallet por aprobar. Usa /pendientes."];
      const reason = rest.join(" ").trim();
      if (!reason) return [`Escribe el motivo: /rechazarwallet ${store.id} <motivo>`];
      markWalletLink(change.token, "rejected");
      if (store.owner) {
        enqueueNotification(`wallet-rejected:${change.token}`, store.owner, `No cambiamos la wallet de *${store.name}*: ${reason}\n\nTus cobros siguen llegando a ${shortAddress(store.merchant_address)}.`);
      }
      return [`↩️ Cambio de wallet de ${store.name} rechazado. Se le avisó al comerciante.`];
    }
    case "/ver": {
      const store = id ? getStore(id) : undefined;
      return [store ? `${summaryForAdmin(store)}\nEstado: ${STATUS_LABEL[store.status]}` : "No encontré esa tienda. Usa /pendientes."];
    }
    case "/aprobar": {
      const store = id ? getStore(id) : undefined;
      if (!store || store.status !== "pending") return ["Solo se aprueban tiendas en revisión. Usa /pendientes."];
      setStoreStatus(store.id, "published");
      const link = await linkFor(store);
      if (store.owner) {
        enqueueNotification(
          `store-approved:${store.id}:${Date.now()}`,
          store.owner,
          `🎉 ¡Tu tienda *${store.name}* ya está publicada!\n\nComparte este link con tus clientes:\n${link}\n\nTe aviso aquí cada vez que alguien pague un pedido. Para administrarla: /vender`
        );
      }
      return [`✅ ${store.name} publicada. Link: ${link}`];
    }
    case "/rechazar": {
      const store = id ? getStore(id) : undefined;
      if (!store || store.status !== "pending") return ["Solo se rechazan tiendas en revisión. Usa /pendientes."];
      const reason = rest.join(" ").trim();
      if (!reason) return [`Escribe el motivo para que el comerciante sepa qué corregir: /rechazar ${store.id} <motivo>`];
      setStoreStatus(store.id, "draft");
      if (store.owner) {
        enqueueNotification(
          `store-rejected:${store.id}:${Date.now()}`,
          store.owner,
          `Revisamos tu tienda *${store.name}* y falta algo antes de publicarla:\n\n${reason}\n\nCorrígelo con /vender y mándala otra vez con /enviar.`
        );
      }
      return [`↩️ ${store.name} regresó a borrador. Se le avisó al comerciante.`];
    }
    default:
      return null;
  }
}

// ─────────────── Comerciante ───────────────

/**
 * Atiende el mensaje si es del alta de comerciantes (o del administrador). Devuelve las respuestas,
 * o null si el mensaje es de un cliente normal y debe ir al agente.
 */
export async function handleMerchant(from: string, text: string): Promise<string[] | null> {
  if (!onboardingEnabled()) return null;
  const message = text.trim();
  const lower = message.toLowerCase();

  if (from === adminId()) {
    const admin = await handleAdmin(message);
    if (admin) return admin;
  }

  const session = load(from);
  const isStart = lower === "/vender" || lower === "/start vender";
  if (!session && !isStart) return null;
  if (!canOnboard(from)) return null;

  const store = getStoreByOwner(from);

  // ── Comandos que valen en cualquier paso
  if (isStart) {
    if (store) {
      save(from, "panel", {});
      return [await panel(store)];
    }
    if (session) return ["Seguimos donde te quedaste 🙂", prompt(session.step, session.draft, from)];
    if (listStoresByStatus("draft").length + listStoresByStatus("pending").length >= maxDrafts()) {
      return ["Por ahora no estamos recibiendo tiendas nuevas. Inténtalo más tarde 🙏"];
    }
    save(from, "name", {});
    return [
      "¡Vamos a crear tu tienda! 🏪 Son unas preguntas rápidas; nada se publica hasta que lo revisemos juntos.\nEn cualquier momento: /salir para pausar, /cancelar para borrar.",
      prompt("name", {}),
    ];
  }
  if (lower === "/salir") {
    if (store) end(from);
    else if (session) save(from, session.step, session.draft); // se conserva para retomarla con /vender
    return ["Listo, volviste al chat normal. Para seguir con tu tienda escribe /vender."];
  }
  if (lower === "/cancelar") {
    if (store?.status === "published") return ["Tu tienda ya está publicada; no se puede borrar desde el chat. Escríbenos si necesitas darla de baja."];
    if (store && !deleteUnpublishedStore(store.id)) return ["No pude borrarla porque ya tiene pedidos pagados. Escríbenos para ayudarte."];
    end(from);
    return ["Borré tu borrador. Si quieres empezar de nuevo, escribe /vender."];
  }

  const { step, draft } = session!;

  // ── Comandos del panel (tienda ya creada)
  if (store && message.startsWith("/")) {
    const accepted = lower === "/enviar acepto";
    switch (accepted ? "/enviar" : lower) {
      case "/probar":
        setCustomerStore(from, store.id);
        clearHistory(from);
        end(from);
        return [`Ahora estás hablando con *${store.name}* como si fueras un cliente 🛒 Pide algo para probar.\n\nPara volver a tu panel: /vender`];
      case "/productos":
        save(from, "catalog", { businessType: store.profile.businessType });
        return [prompt("catalog", { businessType: store.profile.businessType })];
      case "/perfil":
        save(from, "fulfillment", { businessType: store.profile.businessType });
        return [prompt("fulfillment", {})];
      case "/wallet": {
        const link = createWalletLink(from, store.name, store.id);
        return [
          "Abre este link *desde el navegador de la wallet* que quieres usar y firma el mensaje (no cuesta gas):\n\n" +
            `${walletLinkUrl(link)}\n\n` +
            "• Si firmas con la misma wallet que ya tienes, solo queda marcada como firmada.\n" +
            "• Si firmas con otra, primero reparto lo pendiente a tu wallet actual y luego tus cobros van a la nueva." +
            (store.status === "published" ? " Como tu tienda está publicada, el cambio lo revisamos antes de aplicarlo." : "") +
            `\n\nEl link dura ${WALLET_LINK_MINUTES} min.`,
        ];
      }
      case "/enviar": {
        if (store.status !== "draft") return [`Tu tienda está ${STATUS_LABEL[store.status].toLowerCase()}.`];
        if (listProducts(store.id).length === 0) return ["Tu tienda no tiene productos. Agrégalos con /productos."];
        if (!accepted) return [TERMS_TEXT];
        const admin = adminId();
        if (!admin) return ["Ahora mismo no hay quién revise tiendas. Inténtalo más tarde 🙏"];
        acceptTerms(store.id);
        setStoreStatus(store.id, "pending");
        enqueueNotification(`store-review:${store.id}:${Date.now()}`, admin, summaryForAdmin(getStore(store.id)!));
        end(from);
        return ["📨 ¡Enviada! La revisamos y te aviso por aquí en cuanto esté publicada. Mientras, puedes probarla con /vender → /probar."];
      }
      default:
        return [await panel(store)];
    }
  }

  // /wallet en el paso de la wallet: link nuevo (el anterior venció o se perdió)
  if (lower === "/wallet" && (step === "wallet" || step === "walletConfirm")) return [prompt("wallet", draft, from)];

  // Un comando a mitad del alta no se toma como respuesta (por ejemplo "/probar" como horario)
  if (message.startsWith("/") && step !== "panel") {
    return ["Ese comando no aplica en este paso. Termina de responder, o usa /salir para pausar o /cancelar para borrar.", prompt(step, draft, from)];
  }

  // ── Respuestas a cada paso
  switch (step) {
    case "panel":
      return store ? [await panel(store)] : (end(from), ["Escribe /vender para crear tu tienda."]);

    case "name": {
      if (message.length < 2 || message.length > 80 || message.startsWith("/")) return ["El nombre va de 2 a 80 caracteres. ¿Cómo se llama tu negocio?"];
      save(from, "type", { ...draft, name: message });
      return [prompt("type", draft)];
    }

    case "type": {
      const index = Number(message) - 1;
      const type = TYPE_ORDER[index] ?? TYPE_ORDER.find((t) => normalizeName(BUSINESS_TYPES[t]) === normalizeName(message));
      if (!type) return ["Responde con un número del 1 al 5.", prompt("type", draft)];
      save(from, "fulfillment", { ...draft, businessType: type });
      return [prompt("fulfillment", draft)];
    }

    case "fulfillment": {
      const fulfillment = ({ "1": "pickup", "2": "delivery", "3": "both" } as const)[message as "1" | "2" | "3"];
      if (!fulfillment) return ["Responde 1, 2 o 3.", prompt("fulfillment", draft)];
      const next = { ...draft, fulfillment, address: undefined, deliveryArea: undefined };
      save(from, afterFulfillment(next), next);
      return [prompt(afterFulfillment(next), next)];
    }

    case "address": {
      if (message.length < 5 || message.length > 200) return ["La dirección va de 5 a 200 caracteres.", prompt("address", draft)];
      const next = { ...draft, address: message };
      const after: Step = draft.fulfillment === "both" ? "deliveryArea" : "hours";
      save(from, after, next);
      return [prompt(after, next)];
    }

    case "deliveryArea": {
      if (message.length < 3 || message.length > 200) return ["La zona va de 3 a 200 caracteres.", prompt("deliveryArea", draft)];
      save(from, "hours", { ...draft, deliveryArea: message });
      return [prompt("hours", draft)];
    }

    case "hours": {
      if (!SKIP.test(message) && message.length > 120) return ["El horario va en máximo 120 caracteres.", prompt("hours", draft)];
      save(from, "prep", { ...draft, hours: SKIP.test(message) ? "" : message });
      return [prompt("prep", draft)];
    }

    case "prep": {
      let prepMinutes: number | undefined;
      if (!SKIP.test(message)) {
        prepMinutes = Number(message.replace(/min(utos)?/i, "").trim());
        if (!Number.isInteger(prepMinutes) || prepMinutes < 1 || prepMinutes > 1440) return ["Escribe solo los minutos (por ejemplo 20), o *saltar*."];
      }
      const next = { ...draft, prepMinutes };
      const check = validateProfile(profileFrom(next));
      if (!check.ok) return [`Algo no cuadra: ${check.problems.join("; ")}`, prompt("fulfillment", next)];

      // Editando el perfil de una tienda que ya existe: se guarda y vuelve al panel
      if (store) {
        const saved = setStoreProfile(store.id, { ...store.profile, ...(profileFrom(next) as object), description: store.profile.description, tone: store.profile.tone });
        if (!saved.ok) return [`No se guardó: ${saved.problems.join("; ")}`];
        const note = backToDraftIfPending(store);
        save(from, "panel", {});
        return [`✅ Perfil actualizado.${note}`, await panel(getStore(store.id)!)];
      }
      save(from, "wallet", next);
      return [prompt("wallet", next, from)];
    }

    case "wallet":
    case "walletConfirm": {
      // La wallet ya no se pega: se confirma firmando desde el link (así se prueba que es suya)
      const pasted = !walletProblem(message);
      return [
        (pasted ? "Ya no hace falta pegar la dirección: " : "") +
          "para seguir, abre el link que te mandé desde el navegador de tu wallet y firma. ¿Venció o lo perdiste? Escribe /wallet y te mando otro.",
      ];
    }

    case "catalog": {
      const parsed = parseCatalogLines(message);
      if (!parsed.ok) {
        const hint = message.length >= NEAR_TELEGRAM_LIMIT ? `\n\n${SPLIT_HINT}` : "";
        return [`Hay algo que corregir (no guardé nada):\n• ${parsed.problems.join("\n• ")}${hint}\n\nMándame la lista otra vez.`];
      }
      save(from, "catalogConfirm", { ...draft, catalog: parsed.items });
      return [catalogPreview(parsed.items, message)];
    }

    case "catalogConfirm": {
      if (!YES.test(message)) {
        // Lo que no sea un "sí" se toma como la lista corregida
        const parsed = parseCatalogLines(message);
        if (!parsed.ok) return [`Hay algo que corregir (no guardé nada):\n• ${parsed.problems.join("\n• ")}\n\nO responde *sí* para guardar la lista anterior.`];
        save(from, "catalogConfirm", { ...draft, catalog: parsed.items });
        return [catalogPreview(parsed.items, message)];
      }
      const items = draft.catalog ?? [];

      // Tienda existente: reemplaza su catálogo (lo que no venga se desactiva)
      if (store) {
        const preview = savePreview({ storeId: store.id, source: "chat", currency: "MXN", items });
        const result = applyCatalog(preview.id, "replace");
        const note = backToDraftIfPending(store);
        save(from, "panel", {});
        return [`✅ Productos guardados: ${result.added} nuevos, ${result.updated} actualizados, ${result.deactivated} quitados.${note}`, await panel(getStore(store.id)!)];
      }

      // Tienda nueva: se crea como borrador con su perfil y productos
      const created = createStore({
        id: slugFor(draft.name ?? ""),
        name: draft.name ?? "",
        merchant: draft.wallet ?? "",
        profile: profileFrom(draft),
        status: "draft",
        owner: from,
      });
      if (!created.ok) {
        save(from, "name", {});
        return [`No pude crear la tienda: ${created.problems.join("; ")}. Empecemos de nuevo.`, prompt("name", {})];
      }
      if (draft.walletVerified) setWalletVerified(created.store.id);
      applyCatalog(savePreview({ storeId: created.store.id, source: "chat", currency: "MXN", items }).id, "merge");
      save(from, "panel", {});
      return [
        `🎉 ¡Tu tienda quedó como borrador! Solo tú la ves por ahora.\n\nPruébala con /probar (pide algo como si fueras cliente) y cuando te guste, mándala a revisión con /enviar.`,
        await panel(getStore(created.store.id)!),
      ];
    }
  }
  return null;
}

// ─────────────── Wallet firmada (llega desde la página /wallet/<token>) ───────────────

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function notifyWalletChanged(store: Store, oldAddress: string, splitTx?: string): void {
  if (!store.owner) return;
  enqueueNotification(
    `wallet-changed:${store.id}:${Date.now()}`,
    store.owner,
    `✅ Listo: los cobros de *${store.name}* ahora llegan a ${shortAddress(store.merchant_address)}.` +
      (splitTx ? `\n\nAntes repartí lo pendiente a tu wallet anterior (${shortAddress(oldAddress)}).` : "")
  );
}

/**
 * Sigue el flujo después de una firma válida y devuelve lo que la página le muestra al comerciante.
 * Alta: guarda la wallet y pasa a los productos. Cambio: lo aplica (o lo manda a revisión si la
 * tienda está publicada). Misma wallet: solo la marca como firmada.
 */
export async function onWalletVerified(link: WalletLink): Promise<{ ok: boolean; message: string }> {
  const address = link.address!;

  // Alta de una tienda nueva
  if (!link.store_id) {
    const session = load(link.owner);
    if (!session || (session.step !== "wallet" && session.step !== "walletConfirm") || getStoreByOwner(link.owner)) {
      markWalletLink(link.token, "rejected");
      return { ok: false, message: "Tu alta ya no está esperando la wallet. Escribe /vender en el chat para ver dónde vas." };
    }
    const next: Draft = { ...session.draft, wallet: address, walletVerified: true };
    save(link.owner, "catalog", next);
    markWalletLink(link.token, "applied");
    enqueueNotification(`wallet-ok:${link.token}`, link.owner, `✅ Wallet verificada: ${shortAddress(address)}\n\n${prompt("catalog", next)}`);
    return { ok: true, message: "✅ Wallet verificada. Regresa al chat para seguir con tus productos." };
  }

  const store = getStore(link.store_id);
  if (!store || store.owner !== link.owner) {
    markWalletLink(link.token, "rejected");
    return { ok: false, message: "Esta tienda ya no está a tu nombre." };
  }

  // Misma wallet: solo queda firmada
  if (store.merchant_address.toLowerCase() === address.toLowerCase()) {
    setWalletVerified(store.id);
    markWalletLink(link.token, "applied");
    enqueueNotification(`wallet-ok:${link.token}`, link.owner, `✅ Tu wallet ${shortAddress(address)} quedó firmada.`);
    return { ok: true, message: "✅ Tu wallet quedó firmada. Puedes regresar al chat." };
  }

  // Tienda publicada: el cambio lo revisa el administrador antes de aplicarlo
  if (store.status === "published") {
    const admin = adminId();
    if (!admin) {
      markWalletLink(link.token, "rejected");
      return { ok: false, message: "Ahora mismo no hay quién revise el cambio. Intenta más tarde." };
    }
    enqueueNotification(
      `wallet-review:${link.token}`,
      admin,
      [
        `🔑 *Cambio de wallet por revisar:* ${store.name} (${store.id})`,
        `Dueño: ${store.owner}`,
        `Actual: ${store.merchant_address}`,
        `Nueva (firmada): ${address}`,
        "",
        `/aprobarwallet ${store.id}`,
        `/rechazarwallet ${store.id} <motivo>`,
      ].join("\n")
    );
    enqueueNotification(`wallet-sent:${link.token}`, link.owner, `📨 Recibí la firma de ${shortAddress(address)}. Como tu tienda está publicada, revisamos el cambio y te aviso por aquí.`);
    return { ok: true, message: "📨 Firma recibida. Revisamos el cambio y te avisamos en el chat." };
  }

  // Borrador o en revisión: se aplica ya
  const result = await applyWalletChange(link.token);
  if (!result.ok) {
    markWalletLink(link.token, "rejected");
    return { ok: false, message: `${result.error} Pide otro link con /wallet.` };
  }
  const note = backToDraftIfPending(store);
  notifyWalletChanged(result.store, result.oldAddress, result.splitTx);
  if (note) enqueueNotification(`wallet-draft:${link.token}`, link.owner, note.trim());
  return { ok: true, message: "✅ Wallet cambiada. Regresa al chat." };
}

// ─────────────── Términos aceptados ───────────────

{
  const cols = db.prepare("PRAGMA table_info(stores)").all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === "terms_version")) db.exec("ALTER TABLE stores ADD COLUMN terms_version TEXT");
  if (!cols.some((c) => c.name === "terms_accepted_at")) db.exec("ALTER TABLE stores ADD COLUMN terms_accepted_at TEXT");
}

function acceptTerms(storeId: string): void {
  db.prepare("UPDATE stores SET terms_version = ?, terms_accepted_at = datetime('now') WHERE id = ?").run(TERMS_VERSION, storeId);
}

/** Versión aceptada, o null si nunca los aceptó. */
export function termsAccepted(storeId: string): string | null {
  const row = db.prepare("SELECT terms_version AS v FROM stores WHERE id = ?").get(storeId) as { v: string | null } | undefined;
  return row?.v ?? null;
}
