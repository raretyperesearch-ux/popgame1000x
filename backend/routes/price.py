"""
/price/stream WebSocket — broadcasts live ETH/USD prices from the
Avantis SDK FeedClient (Lazer / Pyth) to every connected client.

Architecture:
    Avantis FeedClient ──▶ _handle_price_update ──▶ fan-out to _subscribers

A single FeedClient is started in main.py's lifespan via start_feed_client().
Each /price/stream WS connection registers itself in _subscribers and
receives each Lazer tick from the same callback. Fan-out lets us scale
to many connected players without opening one SDK feed per client.

Payload shape matches the frontend `PriceMessage` interface in
frontend/lib/ws.ts: { eth_price, timestamp, active_trade }. active_trade
is null here — overlaying the open trade is a separate concern wired in
routes/trade.py.

Lazer feed IDs map 1:1 to Avantis pair indexes (1 = BTC/USD, 2 = ETH/USD)
per the SDK example at examples/05_example_get_realtime_prices.py.
Override with ETH_LAZER_FEED_ID if Avantis re-numbers.
"""

import asyncio
import os
from datetime import datetime, timezone
from typing import Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from avantis_trader_sdk import FeedClient

router = APIRouter()

_ETH_LAZER_FEED_ID = int(os.getenv("ETH_LAZER_FEED_ID", "2"))
_DISABLE_FEED = os.getenv("PRICE_FEED_DISABLE", "").lower() in ("1", "true", "yes")

_subscribers: Set[WebSocket] = set()
_latest_price: Optional[float] = None
_latest_ts_ms: Optional[int] = None
_feed_client: Optional[FeedClient] = None
_stream_task: Optional[asyncio.Task] = None


def _on_feed_error(e):
    print(f"⚠️  FeedClient error/close: {e}")


def _build_payload() -> dict:
    return {
        "eth_price": round(_latest_price, 2) if _latest_price is not None else 0.0,
        "timestamp": datetime.fromtimestamp(
            (_latest_ts_ms or 0) / 1000, tz=timezone.utc
        ).isoformat(),
        "active_trade": None,
    }


async def _broadcast(payload: dict) -> None:
    """Send payload to every subscriber, drop ones whose send raises."""
    if not _subscribers:
        return
    dead: list[WebSocket] = []
    for ws in list(_subscribers):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _subscribers.discard(ws)


async def _handle_price_update(data):
    """FeedClient callback. Async per the SDK example so we can await sends."""
    global _latest_price, _latest_ts_ms
    for feed in data.price_feeds:
        if feed.price_feed_id != _ETH_LAZER_FEED_ID:
            continue
        _latest_price = float(feed.converted_price)
        _latest_ts_ms = data.timestamp_ms
        await _broadcast(_build_payload())
        return


async def start_feed_client() -> None:
    """Initialize the Avantis FeedClient and kick off the stream task.
    Called once from main.py's lifespan after init_trader."""
    global _feed_client, _stream_task
    if _DISABLE_FEED:
        print("• PRICE_FEED_DISABLE set — Avantis FeedClient skipped")
        return
    try:
        _feed_client = FeedClient(on_error=_on_feed_error, on_close=_on_feed_error)
        _stream_task = asyncio.create_task(
            _feed_client.listen_for_lazer_price_updates(
                lazer_feed_ids=[_ETH_LAZER_FEED_ID],
                callback=_handle_price_update,
            )
        )
        print(f"✓ Avantis FeedClient started (lazer feed id={_ETH_LAZER_FEED_ID})")
    except Exception as e:
        print(f"⚠️  Failed to start FeedClient: {e}")


async def stop_feed_client() -> None:
    """Cancel the stream task on app shutdown."""
    if _stream_task and not _stream_task.done():
        _stream_task.cancel()
        try:
            await _stream_task
        except (asyncio.CancelledError, Exception):
            pass


@router.websocket("/stream")
async def price_stream(ws: WebSocket):
    await ws.accept()
    _subscribers.add(ws)
    try:
        # Hand the new client the most recent cached price right away so it
        # doesn't wait up to one Lazer tick to see a value.
        if _latest_price is not None:
            await ws.send_json(_build_payload())
        # Block until the client disconnects. Price updates fan out from
        # _handle_price_update via _broadcast — nothing to push from here.
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        return
    finally:
        _subscribers.discard(ws)
