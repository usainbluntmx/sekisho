# Mi API de pago con Sekisho

Cobra USDC por llamada con [x402](https://x402.org) en Avalanche. Cada pago llega a tu **SplitVault** y se reparte solo: 98.5% a tu wallet, 1.5% a la plataforma.

## Arrancar

```bash
npm install
npm run dev
```

Al arrancar verás la dirección del **operador** (la llave de `.env`): mándale un poco de AVAX para el gas de cada cobro. El operador no tiene permisos sobre los contratos; tu dinero nunca pasa por él.

## Probar un pago

```bash
curl -i http://localhost:3000/premium     # 402: pide el pago
npm run pay                               # paga como un agente (requiere PAYER_PRIVATE_KEY con USDC)
```

En Fuji consigue USDC de prueba en https://faucet.circle.com.

## Cambiar lo que vendes

Edita `src/server.ts`: la ruta `GET /premium` es tu contenido de pago. El precio está en `PRICE_USDC` de `.env`.

## Pasar a mainnet

En `.env`: `NETWORK=avalanche`. El operador necesita AVAX real y los pagos son en USDC real.

Más: [SDK de Sekisho](https://www.npmjs.com/package/@zero-two-labs/sekisho) · [repo](https://github.com/usainbluntmx/sekisho)
