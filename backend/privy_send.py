"""
Privy transaction relay helper.

The Avantis SDK's BaseSigner contract is `sign_transaction` -> raw signed
bytes, but Privy's REST API only documents `eth_sendTransaction`
(sign + broadcast in one shot, returns a tx hash). To avoid double-broadcasting
or fighting the SDK's signer abstraction, we bypass `sign_and_get_receipt`
entirely:

  1. Use Avantis SDK to BUILD the transaction (build_trade_open_tx,
     build_trade_close_tx) — these return populated tx dicts with the
     correct `to`, `data`, gas estimates, etc.
  2. Strip fields Privy doesn't accept (Privy auto-fills nonce, gas).
  3. Convert int values to hex strings (Privy expects hex).
  4. POST to Privy's wallets.rpc with method=eth_sendTransaction.
  5. Return the tx hash; caller polls a web3 client for the receipt.

This keeps Avantis SDK usage to read-only + tx-building (no signer needed).
"""

from typing import Any, Optional


BASE_CAIP2 = "eip155:8453"


def _to_hex(v: Any) -> Any:
    """Convert numeric tx fields to 0x-prefixed hex (Privy's requirement)."""
    if isinstance(v, int):
        return hex(v) if v >= 0 else hex(v & ((1 << 256) - 1))
    if isinstance(v, bytes):
        return "0x" + v.hex()
    return v


def _normalize_tx(raw: Any) -> dict:
    """Turn an Avantis SDK transaction object into the dict shape Privy
    expects under params.transaction.

    Avantis SDK returns either a populated dict or an object with .tx /
    similar attribute — handle both. We strip nonce/gas/gasPrice so
    Privy can repopulate from the user's wallet state."""
    src: dict
    if isinstance(raw, dict):
        src = raw
    elif hasattr(raw, "to_dict"):
        src = raw.to_dict()
    elif hasattr(raw, "tx") and isinstance(getattr(raw, "tx"), dict):
        src = raw.tx
    else:
        # last-resort: try to grab common fields directly
        src = {
            k: getattr(raw, k)
            for k in ("to", "data", "value", "from", "chainId")
            if hasattr(raw, k)
        }

    out: dict = {}
    if "to" in src:
        out["to"] = src["to"]
    if "data" in src:
        out["data"] = _to_hex(src["data"])
    if "value" in src:
        out["value"] = _to_hex(src["value"])
    if "chainId" in src:
        out["chainId"] = _to_hex(src["chainId"])
    return out


async def send_via_privy(
    privy_client: Any,
    wallet_id: str,
    raw_tx: Any,
    sponsor: bool = False,
) -> str:
    """Send a built Avantis transaction via Privy. Returns the tx hash."""
    transaction = _normalize_tx(raw_tx)
    response = await privy_client.wallets.rpc(
        wallet_id=wallet_id,
        method="eth_sendTransaction",
        caip2=BASE_CAIP2,
        params={"transaction": transaction},
        sponsor=sponsor,
    )
    # Response shape per docs:
    #   { "method": "eth_sendTransaction", "data": { "hash": "0x...", "caip2": "..." } }
    data = getattr(response, "data", None)
    if data is None and isinstance(response, dict):
        data = response.get("data")
    tx_hash: Optional[str]
    if isinstance(data, dict):
        tx_hash = data.get("hash")
    else:
        tx_hash = getattr(data, "hash", None)
    if not tx_hash:
        raise RuntimeError(f"Privy returned no tx hash: {response}")
    return tx_hash
