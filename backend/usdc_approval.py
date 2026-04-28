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

from typing import Any

from eth_abi import encode
from eth_utils import function_signature_to_4byte_selector


USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_DECIMALS = 6
BASE_CHAIN_ID = 8453


def _to_checksum(addr: str) -> str:
    """eth_utils.to_checksum_address without importing it directly to keep
    deps slim — Privy/web3 accept lowercase too, so we just normalize."""
    return addr if addr.startswith("0x") else f"0x{addr}"


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
    has 6 decimals on Base."""
    amount_raw = int(round(amount_usdc * (10**USDC_DECIMALS)))
    selector = function_signature_to_4byte_selector("approve(address,uint256)")
    args = encode(["address", "uint256"], [_to_checksum(spender), amount_raw])
    data = "0x" + (selector + args).hex()
    return {
        "to": USDC_BASE_ADDRESS,
        "data": data,
        "value": 0,
        "chainId": BASE_CHAIN_ID,
    }
