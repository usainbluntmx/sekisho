import type Anthropic from "@anthropic-ai/sdk";
import { createOrder, getOrder, listProducts, type Order } from "./store.js";
import { formatUsdc } from "./money.js";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

export interface ToolContext {
  storeId: string;
  customerWaId: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Link de pago con su token secreto. */
function paymentUrl(order: Order): string | undefined {
  if (!order.pay_token) return undefined;
  return `${PUBLIC_BASE_URL}/pay/${order.id}?t=${order.pay_token}`;
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "catalog_list",
    description:
      "Devuelve el catálogo actual de la tienda: id de producto, nombre, descripción, precio en USDC y disponibilidad. " +
      "Úsala siempre antes de mencionar productos o precios, y cuando el cliente pregunte qué hay, cuánto cuesta algo o si hay existencias. " +
      "Nunca inventes productos ni precios: usa únicamente lo que devuelve esta herramienta.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "order_create",
    description:
      "Crea un pedido pendiente de pago para el cliente actual y devuelve el id del pedido, el detalle, el total en USDC y el link de pago. " +
      "Úsala solo cuando el cliente ya confirmó explícitamente los productos y cantidades (por ejemplo, 'sí', 'confirmo', 'así está bien'). " +
      "Los product_id deben venir de catalog_list. Si devuelve un error (por ejemplo, falta de stock), explícaselo al cliente y propón una alternativa.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Productos del pedido.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              product_id: { type: "integer", description: "Id del producto según catalog_list." },
              quantity: { type: "integer", minimum: 1, description: "Cantidad de unidades." },
            },
            required: ["product_id", "quantity"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "order_status",
    description:
      "Consulta el estado de un pedido del cliente actual por su id (por ejemplo, '09D37429'). " +
      "Devuelve el estado (pending_payment, paid o cancelled), el detalle y el total. " +
      "Úsala cuando el cliente pregunte por su pedido o su pago. Solo funciona con pedidos de este mismo cliente.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Id del pedido, 8 caracteres hexadecimales." },
      },
      required: ["order_id"],
    },
  },
];

export function executeTool(name: string, input: unknown, ctx: ToolContext): ToolResult {
  try {
    switch (name) {
      case "catalog_list": {
        const products = listProducts(ctx.storeId).map((p) => ({
          product_id: p.id,
          name: p.name,
          description: p.description,
          price_usdc: formatUsdc(p.price_atomic),
          available: p.stock > 0,
          stock: p.stock,
        }));
        return { content: JSON.stringify(products) };
      }

      case "order_create": {
        const { items } = input as { items: { product_id: number; quantity: number }[] };
        const { order, items: lines } = createOrder(
          ctx.storeId,
          ctx.customerWaId,
          items.map((i) => ({ productId: i.product_id, quantity: i.quantity }))
        );
        return {
          content: JSON.stringify({
            order_id: order.id,
            status: order.status,
            items: lines.map((l) => ({
              name: l.name,
              quantity: l.quantity,
              unit_price_usdc: formatUsdc(l.unit_price_atomic),
            })),
            total_usdc: formatUsdc(order.total_atomic),
            payment_url: paymentUrl(order),
          }),
        };
      }

      case "order_status": {
        const { order_id } = input as { order_id: string };
        const found = getOrder(order_id.trim().toUpperCase());
        if (!found || found.order.customer_wa_id !== ctx.customerWaId) {
          return { content: "No encontré un pedido con ese id para este cliente.", isError: true };
        }
        return {
          content: JSON.stringify({
            order_id: found.order.id,
            status: found.order.status,
            total_usdc: formatUsdc(found.order.total_atomic),
            items: found.items.map((l) => ({ name: l.name, quantity: l.quantity })),
            paid_at: found.order.paid_at,
            payment_url: found.order.status === "pending_payment" ? paymentUrl(found.order) : undefined,
          }),
        };
      }

      default:
        return { content: `Herramienta desconocida: ${name}`, isError: true };
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}