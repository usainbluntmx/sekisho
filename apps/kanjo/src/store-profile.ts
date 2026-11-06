/**
 * Perfil de negocio: lo que el agente sabe de la tienda además del catálogo.
 * Con esto Kanjō sirve a cualquier giro sin tocar código, y el agente no inventa
 * horarios, entregas ni tiempos: si un dato no está aquí, dice que lo confirma con la tienda.
 */
import { z } from "zod";

export const BUSINESS_TYPES = {
  cafeteria: "cafetería",
  abarrotes: "tienda de abarrotes",
  tlapaleria: "tlapalería",
  carniceria: "carnicería",
  otro: "negocio",
} as const;
export type BusinessType = keyof typeof BUSINESS_TYPES;

export const FULFILLMENT = {
  pickup: "solo recoger en la tienda",
  delivery: "solo entrega a domicilio",
  both: "recoger en la tienda o entrega a domicilio",
} as const;

const text = (max: number) => z.string().trim().max(max, `máximo ${max} caracteres`);

const baseSchema = z
  .object({
    businessType: z.enum(Object.keys(BUSINESS_TYPES) as [BusinessType, ...BusinessType[]]).default("otro"),
    description: text(400).default(""),
    address: text(200).default(""),
    hours: text(200).default(""),
    fulfillment: z.enum(["pickup", "delivery", "both"]).default("pickup"),
    deliveryArea: text(200).default(""),
    prepMinutes: z.number().int("debe ser un número entero").min(1).max(1440).optional(),
    policies: text(600).default(""),
    tone: text(200).default(""),
  })
  .strict();

export const storeProfileSchema = baseSchema.superRefine((p, ctx) => {
    if (p.fulfillment !== "pickup" && !p.deliveryArea) {
      ctx.addIssue({ code: "custom", path: ["deliveryArea"], message: "con entrega a domicilio, di en qué zona entregas" });
    }
    if (p.fulfillment !== "delivery" && !p.address) {
      ctx.addIssue({ code: "custom", path: ["address"], message: "para recoger en tienda, el cliente necesita la dirección" });
    }
  });

export type StoreProfile = z.infer<typeof storeProfileSchema>;

/** Perfil vacío: válido para guardar en la base, aunque todavía no esté completo. */
export const EMPTY_PROFILE: StoreProfile = {
  businessType: "otro",
  description: "",
  address: "",
  hours: "",
  fulfillment: "pickup",
  deliveryArea: "",
  policies: "",
  tone: "",
};

const FIELD_NAMES: Record<string, string> = {
  businessType: "giro",
  description: "descripción",
  address: "dirección",
  hours: "horario",
  fulfillment: "entrega",
  deliveryArea: "zona de entrega",
  prepMinutes: "tiempo de preparación (minutos)",
  policies: "políticas",
  tone: "tono",
};

/** Valida un perfil y devuelve problemas en palabras simples (en español, por campo). */
export function validateProfile(input: unknown): { ok: true; profile: StoreProfile } | { ok: false; problems: string[] } {
  const result = storeProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  const problems = result.error.issues.map((issue) => {
    if (issue.code === "unrecognized_keys") return `campos que no existen: ${issue.keys.join(", ")}`;
    const field = FIELD_NAMES[String(issue.path[0])] ?? String(issue.path[0] ?? "perfil");
    if (issue.code === "invalid_value" && "values" in issue) return `${field}: debe ser uno de ${(issue.values as string[]).join(", ")}`;
    return `${field}: ${issue.message}`;
  });
  return { ok: false, problems };
}

/** Lee el perfil guardado. Si está dañado, usa el vacío y lo avisa (nunca tumba al agente). */
export function parseStoredProfile(raw: string | null | undefined, storeId: string): StoreProfile {
  if (!raw || raw === "{}") return { ...EMPTY_PROFILE };
  try {
    const parsed = storeProfileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    // Guardado antes de una validación más estricta: se toman los campos sueltos que sí sirvan
    const loose = baseSchema.partial().strip().safeParse(JSON.parse(raw));
    if (loose.success) return { ...EMPTY_PROFILE, ...loose.data };
  } catch {
    // JSON ilegible
  }
  console.warn(`[kanjo] El perfil de la tienda ${storeId} no es válido; se usa uno vacío`);
  return { ...EMPTY_PROFILE };
}

/** Cómo recibe el cliente su pedido, en una frase (para avisos y para el agente). */
export function fulfillmentLine(p: StoreProfile): string {
  const ready = p.prepMinutes ? ` Estará listo en unos ${p.prepMinutes} min.` : "";
  if (p.fulfillment === "pickup") {
    return p.address
      ? `Recógelo en ${p.address}.${ready}`
      : "La tienda te confirmará dónde recogerlo.";
  }
  if (p.fulfillment === "delivery") {
    return `La tienda coordina la entrega a domicilio${p.deliveryArea ? ` (${p.deliveryArea})` : ""}.${ready}`;
  }
  return `Puedes recogerlo${p.address ? ` en ${p.address}` : ""} o pedir entrega a domicilio${p.deliveryArea ? ` (${p.deliveryArea})` : ""}.${ready}`;
}

/** Bloque del perfil para las instrucciones del agente. Solo incluye lo que la tienda llenó. */
export function profileForPrompt(p: StoreProfile): string {
  const lines = [
    `Giro: ${BUSINESS_TYPES[p.businessType]}`,
    p.description && `Descripción: ${p.description}`,
    p.hours ? `Horario: ${p.hours}` : "Horario: no registrado",
    `Cómo recibe el cliente su pedido: ${FULFILLMENT[p.fulfillment]}`,
    p.address && `Dirección para recoger: ${p.address}`,
    p.fulfillment !== "pickup" && p.deliveryArea && `Zona de entrega: ${p.deliveryArea}`,
    p.prepMinutes ? `Tiempo de preparación: unos ${p.prepMinutes} min` : "Tiempo de preparación: no registrado",
    p.policies && `Políticas: ${p.policies}`,
    p.tone && `Tono al hablar: ${p.tone}`,
  ].filter(Boolean);
  return lines.join("\n");
}
