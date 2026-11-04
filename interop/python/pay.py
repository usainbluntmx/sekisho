"""Paga un endpoint de Sekisho con el cliente x402 oficial de Python (sin nada de Sekisho).

    TARGET_URL=http://127.0.0.1:4402/v1/avalanche/snapshot python pay.py        # servidor local, llave desechable
    TARGET_URL=https://... PAYER_PRIVATE_KEY=0x... NETWORK=avalanche python pay.py

Si el servidor pide más de MAX_USDC (0.01 por defecto), no firma.
"""

import asyncio
import base64
import json
import os
import sys
from decimal import Decimal

import httpx
from eth_account import Account
from x402 import x402Client
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm.exact import register_exact_evm_client
from x402.mechanisms.evm.signers import EthAccountSigner

USDC = {
    "avalancheFuji": ("eip155:43113", "0x5425890298aed601595a70AB815c96711a31Bc65"),
    "avalanche": ("eip155:43114", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
}


def decode(header):
    return json.loads(base64.b64decode(header)) if header else None


async def main() -> None:
    url = os.environ.get("TARGET_URL", "http://127.0.0.1:4402/v1/avalanche/snapshot")
    network = os.environ.get("NETWORK", "avalancheFuji")
    if network not in USDC:
        sys.exit(f'NETWORK debe ser avalancheFuji o avalanche (es "{network}")')
    caip2, asset = USDC[network]
    max_atomic = int(Decimal(os.environ.get("MAX_USDC", "0.01")) * 10**6)

    key = os.environ.get("PAYER_PRIVATE_KEY")
    if not key:
        if "127.0.0.1" not in url:
            sys.exit("Falta PAYER_PRIVATE_KEY (solo el servidor local de interop acepta una llave desechable)")
        key = "0x" + os.urandom(32).hex()
    account = Account.from_key(key)

    # 1) Sin pagar: el 402 debe cumplir x402 v2
    async with httpx.AsyncClient() as plain:
        first = await plain.get(url)
    required = decode(first.headers.get("payment-required"))
    if first.status_code != 402 or not required:
        sys.exit(f"Se esperaba 402 con PAYMENT-REQUIRED; llegó {first.status_code}")
    option = (required.get("accepts") or [{}])[0]
    print("402 recibido:", json.dumps({k: option.get(k) for k in ("network", "amount", "asset", "payTo", "extra")}))
    if int(option.get("amount", "0")) > max_atomic:
        sys.exit("El servidor pide más que MAX_USDC")

    # 2) Pagar con el cliente oficial. Por defecto solo paga "activos por defecto" (el USDC de
    #    Avalanche mainnet lo es); el USDC de Fuji hay que permitirlo explícitamente.
    client = x402Client()
    register_exact_evm_client(client, EthAccountSigner(account), networks=caip2)
    client.set_spend_controls(
        {"allowed_assets": [{"network": caip2, "asset": asset, "max_amount_per_payment": str(max_atomic)}]}
    )
    async with x402HttpxClient(client) as http:
        res = await http.get(url)
    settled = decode(res.headers.get("payment-response"))
    print(f"Pagador: {account.address}")
    print(f"Status:  {res.status_code}")
    print("Pago:   ", json.dumps(settled))
    if res.status_code != 200 or not (settled or {}).get("success"):
        sys.exit("El pago con el cliente de Python no se completó")
    print("✅ x402 (Python) pagó correctamente")


asyncio.run(main())
