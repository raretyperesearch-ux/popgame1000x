"""
Build a USDC `approve(spender, amount)` ERC-20 calldata for routing
through Privy's eth_sendTransaction.

The Avantis SDK exposes `approve_usdc_for_trading` only as a mutating
method that uses the SDK's local signer — there's no public
`build_*_approval_tx` we can pass to Privy. So for multi-user (Privy)
mode we construct the calldata ourselves and send it via the same
relay as the trade itself.

USDC on Base mainnet (chain id 8453) is the canonical 6-decimal token
at 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
"""

import os
from typing import Any

import httpx
from eth_abi import encode
from eth_utils import function_signature_to_4byte_selector


USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_DECIMALS = 6
BASE_CHAIN_ID = 8453
# Conservative floor for "can probably cover an approval + an open + a
# close on Base". An Avantis open is ~250-400k gas at ~0.01-0.05 gwei
# on Base (very cheap), so 0.0005 ETH is plenty of cushion. Tune up if
# users start hitting the gate.
MIN_GAS_ETH_WEI = int(0.0005 * 10**18)


def _to_checksum(addr: str) -> str:
    """eth_utils.to_checksum_address without importing it directly to keep
    deps slim — Privy/web3 accept lowercase too, so we just normalize."""
    return addr if addr.startswith("0x") else f"0x{addr}"


async def get_eth_balance_wei(address: str) -> int:
    """Read native ETH balance for an address on Base via direct JSON-RPC.

    Bypasses the Avantis SDK because its web3 attribute path varies across
    versions and we'd rather fail loud than fail-open on a critical
    pre-flight check. BASE_RPC_URL is the same env the SDK reads."""
    rpc_url = os.getenv("BASE_RPC_URL", "https://mainnet.base.org")
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getBalance",
        "params": [_to_checksum(address), "latest"],
    }
    async with httpx.AsyncClient(timeout=5.0) as ax:
        r = await ax.post(rpc_url, json=payload)
        r.raise_for_status()
        body = r.json()
    result = body.get("result")
    if not isinstance(result, str) or not result.startswith("0x"):
        raise RuntimeError(f"unexpected eth_getBalance response: {body}")
    return int(result, 16)


def get_avantis_trading_address(client: Any) -> str:
    """Find the Avantis Trading contract address from a TraderClient.
    Tries a handful of plausible attribute paths the SDK might expose,
    falling back to the well-known Base mainnet address."""
    # Try the snapshot-style API first (newer SDK versions).
    for path in (
        ("snapshot", "contracts", "trading", "address"),
        ("contracts", "trading", "address"),
        ("snapshot", "trading", "address"),
        ("trading", "contract", "address"),
    ):
        node: Any = client
        ok = True
        for attr in path:
            node = getattr(node, attr, None)
            if node is None:
                ok = False
                break
        if ok and isinstance(node, str) and node.startswith("0x"):
            return _to_checksum(node)
    # Avantis Trading proxy on Base mainnet (verified via avantisfi.com).
    return "0x5FF292d70bA9cD9e7CCb313782811b3D7120535f"


def build_usdc_approval_tx(spender: str, amount_usdc: float) -> dict:
    """Build a transaction dict for `USDC.approve(spender, amount)` on
    Base. Caller routes it through send_via_privy.

    `amount_usdc` is in human units (e.g., 1000.0 = 1000 USDC). USDC
    has 6 decimals on Base. We don't include chainId — Privy's
    wallets.rpc takes the chain via `caip2`, and passing chainId in
    params.transaction is rejected with `Unrecognized key(s) in
    object: 'chainId'`."""
    amount_raw = int(round(amount_usdc * (10**USDC_DECIMALS)))
    selector = function_signature_to_4byte_selector("approve(address,uint256)")
    args = encode(["address", "uint256"], [_to_checksum(spender), amount_raw])
    data = "0x" + (selector + args).hex()
    return {
        "to": USDC_BASE_ADDRESS,
        "data": data,
        "value": 0,
    }
