import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Versión del SDK, leída de su package.json (funciona en src/ y en dist/). */
export const SDK_VERSION: string = (require("../package.json") as { version: string }).version;