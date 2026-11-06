import { rmSync } from "node:fs";

// Base de datos temporal, aislada de data/kanjo.db
const TEST_DB = "data/test-templates.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;
process.env.CATALOG_DEFAULT_STOCK = "20";

const { db } = await import("../db.js");
const store = await import("../store.js");
const { TEMPLATES, TEMPLATE_TYPES } = await import("../templates.js");
const { parseCatalogFile } = await import("../catalog-file.js");
const { validateProfile } = await import("../store-profile.js");
const { applyCatalog, savePreview } = await import("../catalog-import.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}
const FX = 18.5;
const problems = (input: unknown) => {
  const r = parseCatalogFile(input, FX);
  return r.ok ? "" : r.problems.join(" | ");
};

console.log("─── Plantillas ───");
check("Hay plantilla de cafetería, abarrotes, tlapalería y carnicería", TEMPLATE_TYPES.join(",") === "cafeteria,abarrotes,tlapaleria,carniceria");
for (const type of TEMPLATE_TYPES) {
  const t = TEMPLATES[type]!;
  const catalog = parseCatalogFile(t.catalog, FX);
  check(`${t.label}: el catálogo de ejemplo es válido (${t.catalog.items.length} productos)`, catalog.ok);
  const asIs = validateProfile(t.profile);
  check(`${t.label}: el perfil sin editar NO se puede guardar (pide la dirección)`, !asIs.ok && asIs.problems.some((p) => /dirección/.test(p)));
  const filled = validateProfile({ ...t.profile, address: "Av. Juárez 123", hours: "Lun a sáb 9:00–19:00", ...("deliveryArea" in t.profile ? { deliveryArea: "Centro" } : {}) });
  check(`${t.label}: con dirección, horario y zona, el perfil es válido`, filled.ok && filled.profile.businessType === type);
}
const butcher = parseCatalogFile(TEMPLATES.carniceria!.catalog, FX);
check("La carnicería vende por kilo: 380 MXN/kg → 20.54 USDC/kg y 10 kg → 10000 g", butcher.ok && butcher.items[0].unit === "kg" && butcher.items[0].price_atomic === 20_540_000 && butcher.items[0].stock === 10_000);

console.log("─── Validación del archivo ───");
const item = { name: "Martillo", price: 185 };
check("Lo mínimo (nombre y precio) es válido y va por pieza", (() => { const r = parseCatalogFile({ items: [item] }, FX); return r.ok && r.items[0].unit === "pieza" && r.currency === "MXN"; })());
check("Precio en 0 → error con el producto", /producto 1 \(Martillo\) · precio: debe ser mayor a 0/.test(problems({ items: [{ ...item, price: 0 }] })));
check("Precio con texto ('$185') → error claro", /precio: debe ser un número/.test(problems({ items: [{ ...item, price: "$185" }] })));
check("Un campo mal escrito → error (no se pierde en silencio)", /campos que no existen: precio/.test(problems({ items: [{ ...item, precio: 10 }] })));
check("Unidad inexistente → dice cuáles valen", /unidad: debe ser uno de pieza, kg/.test(problems({ items: [{ ...item, unit: "litro" }] })));
check("Piezas con decimales en existencias → error", /piezas van en números enteros/.test(problems({ items: [{ ...item, stock: 2.5 }] })));
check("Kilos con más de 3 decimales en existencias → error", /hasta 3 decimales/.test(problems({ items: [{ ...item, unit: "kg", stock: 1.2345 }] })));
check("Existencias negativas → error", /no puede ser negativo/.test(problems({ items: [{ ...item, stock: -1 }] })));
check("Nombre repetido → error (aunque cambien acentos o mayúsculas)", /nombre repetido/.test(problems({ items: [{ name: "Café", price: 1 }, { name: "CAFE", price: 2 }] })));
check("Catálogo vacío → error", /no tiene productos/.test(problems({ items: [] })));
check("Moneda que no existe → error", /moneda: debe ser uno de MXN, USD, USDC/.test(problems({ currency: "EUR", items: [item] })));
check("MXN sin tipo de cambio → error que dice qué falta", /FX_MXN_PER_USDC/.test((() => { const r = parseCatalogFile({ items: [item] }, NaN); return r.ok ? "" : r.problems.join(); })()));
check("En USD no necesita tipo de cambio", parseCatalogFile({ currency: "USD", items: [{ ...item, price: 10 }] }, NaN).ok);

console.log("─── Cargar en una tienda ───");
db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('don-pepe', 'Carnicería Don Pepe', '0x0000000000000000000000000000000000000001')").run();
const first = savePreview({ storeId: "don-pepe", source: "archivo:catalogo.json", currency: "MXN", items: (butcher as any).items });
check("Vista previa: 7 nuevos y la tienda todavía vacía", first.diff.added === 7 && store.listProducts("don-pepe").length === 0);
applyCatalog(first.id);
const arrachera = store.listProducts("don-pepe").find((p) => p.name === "Arrachera");
check("Al aplicar: 7 productos, por kilo, con sus existencias (10 kg = 10000 g)", store.listProducts("don-pepe").length === 7 && arrachera?.unit === "kg" && arrachera.stock === 10_000);

const edited = structuredClone(TEMPLATES.carniceria!.catalog);
edited.items[0].stock = 4.5; // la tienda contó lo que le queda
edited.items[1].price = 230;
edited.items.pop(); // ya no vende pechuga
const second = parseCatalogFile(edited, FX);
const preview2 = savePreview({ storeId: "don-pepe", source: "archivo:catalogo.json", currency: "MXN", items: (second as any).items });
check("Editar existencias y precio cuenta como cambio (2 actualizados, 1 fuera)", preview2.diff.updated === 2 && preview2.diff.removed === 1 && preview2.diff.added === 0);
const result = applyCatalog(preview2.id, "replace");
check("Con --replace: se actualizan 6 y se desactiva 1", result.updated === 6 && result.deactivated === 1);
check("Las existencias quedan como dice el archivo (4.5 kg = 4500 g)", store.getProduct("don-pepe", arrachera!.id)?.stock === 4_500);
check("El producto quitado ya no se vende", !store.listProducts("don-pepe").some((p) => p.name === "Pechuga de pollo"));
const again = savePreview({ storeId: "don-pepe", source: "archivo:catalogo.json", currency: "MXN", items: (second as any).items });
check("Cargar el mismo archivo otra vez no cambia nada", again.diff.updated === 0 && again.diff.added === 0 && again.diff.unchanged === 6);

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
