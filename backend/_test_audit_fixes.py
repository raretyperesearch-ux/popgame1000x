"""
Standalone audit-fix tests. Mocks the Avantis SDK so we can exercise
the changed code paths in isolation:

  #3  /trade/active populates current_price + pnl_usdc + pnl_pct +
      opened_at from real sources (price feed + on-chain timestamp)
      instead of stub values.

  #5  /trade/close populates exit_price by back-computing from the
      realized PnL, instead of returning 0.0.

Run from backend/ with:
    .venv/bin/python -m _test_audit_fixes
"""

import asyncio
import os
import sys
from unittest.mock import AsyncMock, patch

# Match the env the route module reads at import time.
os.environ.setdefault("PRIVATE_KEY", "0x" + "11" * 32)
os.environ.setdefault("TREASURY_ADDRESS", "0x" + "22" * 20)
os.environ.setdefault("AUTH_DISABLE", "1")
os.environ.setdefault("PRICE_FEED_DISABLE", "1")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost:3000")


def _ok(name: str) -> None:
    print(f"  ✓ {name}")


def _fail(name: str, why: str) -> None:
    print(f"  ✗ {name}: {why}")
    sys.exit(1)


def _close(a: float, b: float, tol: float = 1e-3) -> bool:
    return abs(a - b) <= tol


class FakeTradeInner:
    """Mirrors the avantis-trader-sdk Trade shape we touch."""
    def __init__(self, *, idx, pair_index, lev, collateral, open_price, ts):
        self.trade_index = idx
        self.pair_index = pair_index
        self.leverage = lev
        self.open_collateral = collateral
        self.open_price = open_price
        self.timestamp = ts


class FakeTrade:
    def __init__(self, inner, liq):
        self.trade = inner
        self.liquidation_price = liq


async def test_active_pnl_uses_live_price() -> None:
    """When price feed is hot, /trade/active mark-to-markets at the
    feed price; pnl uses leverage * collateral; opened_at parses the
    on-chain timestamp."""
    from routes import trade as trade_mod
    from routes import price as price_mod

    inner = FakeTradeInner(
        idx=42,
        pair_index=0,
        lev=100,
        collateral=10.0,
        open_price=3500.0,
        ts=1714400000,  # arbitrary recent UTC second
    )
    trade_obj = FakeTrade(inner, liq=3465.0)

    fake_client = AsyncMock()
    fake_client.trade = AsyncMock()
    fake_client.trade.get_trades = AsyncMock(return_value=([trade_obj], None))

    with patch.object(trade_mod, "_trader_client", fake_client):
        # Simulate a live feed price — 0.5% above entry → +50% pnl_pct at 100x
        price_mod._latest_price = 3517.5
        from auth import AuthedUser
        user = AuthedUser(did="u", wallet_id="w", address="0xabc")
        out = await trade_mod.get_active_trade(user)

    if out is None:
        _fail("active.not_none", "expected ActiveTrade, got None")
    if out.trade_index != 42:
        _fail("active.trade_index", f"expected 42, got {out.trade_index}")
    if not _close(out.entry_price, 3500.0):
        _fail("active.entry_price", f"expected ~3500, got {out.entry_price}")
    if not _close(out.current_price, 3517.5):
        _fail("active.current_price", f"expected 3517.5, got {out.current_price}")
    # 0.5% move * 100x lev = 0.5 = 50% on the collateral.
    if not _close(out.pnl_pct, 0.5, tol=1e-4):
        _fail("active.pnl_pct", f"expected 0.5, got {out.pnl_pct}")
    if not _close(out.pnl_usdc, 5.0, tol=1e-3):
        _fail("active.pnl_usdc", f"expected 5.0 USDC, got {out.pnl_usdc}")
    if int(out.opened_at.timestamp()) != 1714400000:
        _fail("active.opened_at", f"expected 1714400000, got {int(out.opened_at.timestamp())}")
    _ok("active.populates real PnL + opened_at")


async def test_active_no_feed_yet_falls_back_to_entry() -> None:
    """Cold-start: feed hasn't ticked. We surface entry as the current
    price so PnL is 0 instead of 503ing or returning negative junk."""
    from routes import trade as trade_mod
    from routes import price as price_mod

    inner = FakeTradeInner(
        idx=1, pair_index=0, lev=200, collateral=5.0,
        open_price=3300.0, ts=1714400000,
    )
    trade_obj = FakeTrade(inner, liq=3283.5)
    fake_client = AsyncMock()
    fake_client.trade = AsyncMock()
    fake_client.trade.get_trades = AsyncMock(return_value=([trade_obj], None))

    with patch.object(trade_mod, "_trader_client", fake_client):
        price_mod._latest_price = None
        from auth import AuthedUser
        out = await trade_mod.get_active_trade(
            AuthedUser(did="u", wallet_id="w", address="0xabc")
        )

    if not _close(out.current_price, 3300.0):
        _fail("active.cold.current_price", f"expected entry fallback 3300, got {out.current_price}")
    if not _close(out.pnl_usdc, 0.0):
        _fail("active.cold.pnl_usdc", f"expected 0 PnL when cold, got {out.pnl_usdc}")
    _ok("active.cold-feed falls back to entry")


async def test_active_no_open_trade_returns_none() -> None:
    """Empty get_trades → None response."""
    from routes import trade as trade_mod
    fake_client = AsyncMock()
    fake_client.trade = AsyncMock()
    fake_client.trade.get_trades = AsyncMock(return_value=([], None))
    with patch.object(trade_mod, "_trader_client", fake_client):
        from auth import AuthedUser
        out = await trade_mod.get_active_trade(
            AuthedUser(did="u", wallet_id="w", address="0xabc")
        )
    if out is not None:
        _fail("active.empty", f"expected None, got {out}")
    _ok("active.empty trades → None")


def test_exit_price_back_compute_winning_trade() -> None:
    """A 0.4% up move at 100x on $10 = +$4 gross. Back-computed exit
    must reverse the formula exactly."""
    from routes.trade import _exit_price_from_pnl
    entry = 3500.0
    leverage = 100.0
    collateral = 10.0
    gross_pnl = 4.0  # implies move = gross/(lev*coll) = 0.004
    exit_price = _exit_price_from_pnl(entry, leverage, collateral, gross_pnl)
    expected = 3500.0 * (1 + 0.004)  # 3514.0
    if not _close(exit_price, expected):
        _fail("exit_price.win", f"expected {expected}, got {exit_price}")
    _ok("exit_price.win → 3514.00")


def test_exit_price_back_compute_losing_trade() -> None:
    from routes.trade import _exit_price_from_pnl
    entry = 3500.0
    exit_price = _exit_price_from_pnl(entry, 200.0, 5.0, gross_pnl=-3.0)
    # move = -3 / (200 * 5) = -0.003
    expected = 3500.0 * (1 - 0.003)  # 3489.50
    if not _close(exit_price, expected):
        _fail("exit_price.loss", f"expected {expected}, got {exit_price}")
    _ok("exit_price.loss → 3489.50")


def test_exit_price_back_compute_full_liquidation() -> None:
    """gross_pnl = -collateral happens at 1/leverage move (full wipe).
    The back-computed exit must equal the liquidation price."""
    from routes.trade import _exit_price_from_pnl
    entry = 3500.0
    leverage = 100.0
    collateral = 5.0
    # full liq = -collateral = -5.0
    exit_price = _exit_price_from_pnl(entry, leverage, collateral, -collateral)
    # move = -5 / (100*5) = -0.01 = exactly -1/leverage
    expected = entry * (1 - 1 / leverage)  # 3465.00
    if not _close(exit_price, expected):
        _fail("exit_price.liq", f"expected {expected}, got {exit_price}")
    _ok("exit_price.liq → 3465.00 (matches 1/lev move)")


def test_exit_price_degenerate_inputs_return_none() -> None:
    from routes.trade import _exit_price_from_pnl
    if _exit_price_from_pnl(0.0, 100.0, 10.0, 5.0) is not None:
        _fail("exit_price.entry0", "expected None for entry=0")
    if _exit_price_from_pnl(3500.0, 0.0, 10.0, 5.0) is not None:
        _fail("exit_price.lev0", "expected None for leverage=0")
    if _exit_price_from_pnl(3500.0, 100.0, 0.0, 5.0) is not None:
        _fail("exit_price.coll0", "expected None for collateral=0")
    _ok("exit_price.degenerate inputs → None (caller can fall back)")


def test_compute_pnl_long_winning() -> None:
    from routes.trade import _compute_pnl
    pnl_usdc, pnl_pct = _compute_pnl(
        entry_price=3500.0, current_price=3517.5,
        leverage=100.0, collateral=10.0,
    )
    if not _close(pnl_usdc, 5.0):
        _fail("compute_pnl.win.usdc", f"expected 5.0, got {pnl_usdc}")
    if not _close(pnl_pct, 0.5, tol=1e-4):
        _fail("compute_pnl.win.pct", f"expected 0.5, got {pnl_pct}")
    _ok("compute_pnl.long winning → +$5.00 / +50%")


def test_compute_pnl_long_losing() -> None:
    from routes.trade import _compute_pnl
    pnl_usdc, pnl_pct = _compute_pnl(
        entry_price=3500.0, current_price=3482.5,
        leverage=100.0, collateral=10.0,
    )
    if not _close(pnl_usdc, -5.0):
        _fail("compute_pnl.loss.usdc", f"expected -5.0, got {pnl_usdc}")
    _ok("compute_pnl.long losing → -$5.00")


def test_house_fee_transfer_calldata() -> None:
    """USDC.transfer(treasury, fee) selector + args are byte-exact.
    This is the tx the open path now sends to actually collect fees."""
    from usdc_approval import build_usdc_transfer_tx, USDC_BASE_ADDRESS
    treasury = "0xAaAaaAAaaAAaaaaaaAAAAaaAAAAAAaAaAaAaAAaA"
    fee_usdc = 0.04
    tx = build_usdc_transfer_tx(treasury, fee_usdc)
    if tx["to"].lower() != USDC_BASE_ADDRESS.lower():
        _fail("fee_transfer.to", f"expected USDC contract, got {tx['to']}")
    if tx["value"] != 0:
        _fail("fee_transfer.value", f"expected 0, got {tx['value']}")
    # ERC-20 transfer(address,uint256) selector = 0xa9059cbb
    if not tx["data"].startswith("0xa9059cbb"):
        _fail("fee_transfer.selector", f"expected 0xa9059cbb, got {tx['data'][:10]}")
    from eth_abi import decode
    args = bytes.fromhex(tx["data"][10:])
    rcpt, amt = decode(["address", "uint256"], args)
    if rcpt.lower() != treasury.lower():
        _fail("fee_transfer.recipient", f"got {rcpt}")
    if amt != int(fee_usdc * 10**6):
        _fail("fee_transfer.amount", f"got {amt}, expected {int(fee_usdc * 10**6)}")
    _ok(f"USDC.transfer calldata exact match  selector=0xa9059cbb  amount={amt} ({amt/10**6} USDC)")


def test_house_fee_amount_matches_bps() -> None:
    """Sanity: $5 wager × 80 bps = $0.04 fee."""
    from models import calculate_house_fee, HOUSE_FEE_BPS
    if HOUSE_FEE_BPS != 80:
        _fail("fee.bps", f"expected 80 bps, got {HOUSE_FEE_BPS}")
    if abs(calculate_house_fee(5.0) - 0.04) > 1e-9:
        _fail("fee.5usd", f"expected 0.04, got {calculate_house_fee(5.0)}")
    if abs(calculate_house_fee(25.0) - 0.20) > 1e-9:
        _fail("fee.25usd", f"expected 0.20, got {calculate_house_fee(25.0)}")
    _ok("house_fee math: $5→$0.04, $25→$0.20  (80 bps = 0.8%)")


async def main() -> None:
    print("Running audit-fix tests…")
    print()
    print("[#3 /trade/active]")
    await test_active_pnl_uses_live_price()
    await test_active_no_feed_yet_falls_back_to_entry()
    await test_active_no_open_trade_returns_none()
    test_compute_pnl_long_winning()
    test_compute_pnl_long_losing()
    print()
    print("[#5 /trade/close exit_price]")
    test_exit_price_back_compute_winning_trade()
    test_exit_price_back_compute_losing_trade()
    test_exit_price_back_compute_full_liquidation()
    test_exit_price_degenerate_inputs_return_none()
    print()
    print("[house fee collection]")
    test_house_fee_amount_matches_bps()
    test_house_fee_transfer_calldata()
    print()
    print("All tests passed.")


if __name__ == "__main__":
    asyncio.run(main())
