/**
 * Plantillas por giro: un perfil y un catálogo de ejemplo para empezar sin escribir JSON desde cero.
 * Son un punto de partida para EDITAR: la dirección y el horario vienen vacíos a propósito
 * (la validación pide la dirección antes de guardar), y los precios y existencias son de ejemplo.
 */
import type { CatalogFile } from "./catalog-file.js";
import type { BusinessType } from "./store-profile.js";

export interface StoreTemplate {
  label: string;
  /** Perfil de ejemplo (mismo formato que npm run store:profile). */
  profile: Record<string, unknown>;
  /** Catálogo de ejemplo (mismo formato que npm run catalog:load). Precios en MXN. */
  catalog: CatalogFile;
}

const pending = { address: "", hours: "" };

export const TEMPLATES: Partial<Record<BusinessType, StoreTemplate>> = {
  cafeteria: {
    label: "Cafetería",
    profile: {
      businessType: "cafeteria",
      description: "Cafetería de barrio: café, bebidas y pan del día.",
      ...pending,
      fulfillment: "pickup",
      prepMinutes: 10,
      policies: "",
      tone: "cercano y breve, de tú",
    },
    catalog: {
      currency: "MXN",
      items: [
        { name: "Americano 12 oz", price: 45, stock: 50, category: "Bebidas calientes" },
        { name: "Latte 12 oz", price: 60, stock: 50, category: "Bebidas calientes" },
        { name: "Capuchino 12 oz", price: 60, stock: 50, category: "Bebidas calientes" },
        { name: "Chocolate caliente 12 oz", price: 55, stock: 30, category: "Bebidas calientes" },
        { name: "Croissant", price: 38, stock: 20, category: "Pan" },
        { name: "Concha", price: 22, stock: 20, category: "Pan" },
        { name: "Café en grano 250 g", price: 180, stock: 10, category: "Para llevar", description: "Tueste medio" },
      ],
    },
  },

  abarrotes: {
    label: "Tienda de abarrotes",
    profile: {
      businessType: "abarrotes",
      description: "Tienda de abarrotes: despensa, lácteos, bebidas y limpieza.",
      ...pending,
      fulfillment: "both",
      deliveryArea: "",
      prepMinutes: 15,
      policies: "",
      tone: "amable, de tú",
    },
    catalog: {
      currency: "MXN",
      items: [
        { name: "Huevo blanco", price: 48, unit: "kg", stock: 15, category: "Despensa" },
        { name: "Tortilla de maíz", price: 24, unit: "kg", stock: 20, category: "Despensa" },
        { name: "Frijol negro 1 kg", price: 38, stock: 20, category: "Despensa" },
        { name: "Arroz 1 kg", price: 32, stock: 20, category: "Despensa" },
        { name: "Aceite vegetal 1 L", price: 52, stock: 12, category: "Despensa" },
        { name: "Leche entera 1 L", price: 28, stock: 24, category: "Lácteos" },
        { name: "Refresco 600 ml", price: 20, stock: 48, category: "Bebidas" },
        { name: "Jabón de barra", price: 18, stock: 20, category: "Limpieza" },
        { name: "Papel higiénico 4 rollos", price: 35, stock: 15, category: "Limpieza" },
      ],
    },
  },

  tlapaleria: {
    label: "Tlapalería",
    profile: {
      businessType: "tlapaleria",
      description: "Tlapalería: herramienta, tornillería, eléctrico y pintura.",
      ...pending,
      fulfillment: "pickup",
      prepMinutes: 10,
      policies: "Cambios con ticket dentro de 7 días, en producto sin usar.",
      tone: "amable y práctico, de usted",
    },
    catalog: {
      currency: "MXN",
      items: [
        { name: "Martillo de uña 16 oz", price: 185, stock: 6, category: "Herramienta" },
        { name: "Desarmador plano 1/4", price: 65, stock: 10, category: "Herramienta" },
        { name: "Clavo de 2 pulgadas", price: 60, unit: "kg", stock: 10, category: "Tornillería" },
        { name: "Tornillo para madera 1 1/2 (100 pzas)", price: 70, stock: 15, category: "Tornillería" },
        { name: "Cinta de aislar negra", price: 22, stock: 30, category: "Eléctrico" },
        { name: "Foco LED 9 W", price: 45, stock: 25, category: "Eléctrico" },
        { name: "Silicón transparente 280 ml", price: 85, stock: 10, category: "Pintura y sellado" },
        { name: "Pintura vinílica blanca 4 L", price: 420, stock: 5, category: "Pintura y sellado" },
      ],
    },
  },

  carniceria: {
    label: "Carnicería",
    profile: {
      businessType: "carniceria",
      description: "Carnicería de barrio: res, cerdo y pollo frescos.",
      ...pending,
      fulfillment: "both",
      deliveryArea: "",
      prepMinutes: 20,
      policies: "Cortes al gusto. No hay cambios en producto ya cortado.",
      tone: "amable y directo, de usted",
    },
    catalog: {
      currency: "MXN",
      items: [
        { name: "Arrachera", price: 380, unit: "kg", stock: 10, category: "Res" },
        { name: "Bistec de res", price: 220, unit: "kg", stock: 15, category: "Res" },
        { name: "Molida de res", price: 180, unit: "kg", stock: 15, category: "Res" },
        { name: "Chuleta de cerdo", price: 150, unit: "kg", stock: 12, category: "Cerdo" },
        { name: "Costilla de cerdo", price: 170, unit: "kg", stock: 10, category: "Cerdo" },
        { name: "Chorizo", price: 160, unit: "kg", stock: 8, category: "Cerdo" },
        { name: "Pechuga de pollo", price: 140, unit: "kg", stock: 15, category: "Pollo" },
      ],
    },
  },
};

export const TEMPLATE_TYPES = Object.keys(TEMPLATES) as BusinessType[];
