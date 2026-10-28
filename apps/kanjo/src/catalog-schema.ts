/**
 * Esquema de extracción para Firecrawl (/v2/scrape, formato json).
 * Deliberadamente plano: los modelos de extracción fallan menos con objetos simples.
 */
export const CATALOG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["currency", "items"],
  properties: {
    store_name: { type: "string", description: "Nombre comercial del negocio" },
    currency: { type: "string", description: "Código ISO 4217 de los precios, por ejemplo MXN o USD" },
    items: {
      type: "array",
      description: "Todos los productos o platillos con precio visible",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "price"],
        properties: {
          name: { type: "string", description: "Nombre del producto, sin precio" },
          description: { type: "string", description: "Descripción breve o ingredientes" },
          price: { type: "number", description: "Precio numérico, sin símbolo ni separador de miles" },
          category: { type: "string", description: "Sección del menú: bebidas, postres, etc." },
          image_url: { type: "string", description: "URL de la foto del producto, si la página muestra una" },
          available: { type: "boolean", description: "false solo si la página dice agotado" },
        },
      },
    },
  },
} as const;

export const CATALOG_PROMPT =
  "Extrae el catálogo completo de productos con su precio. " +
  "No inventes productos ni precios: si un producto no tiene precio visible, omítelo. " +
  "Convierte precios como '$45' o '45.00' al número 45. " +
  "Si hay varios tamaños del mismo producto, crea un item por tamaño (ej. 'Latte 12 oz'). " +
  "Usa como categoría el título de la sección donde aparece el producto.";
