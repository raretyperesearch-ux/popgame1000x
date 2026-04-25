"""
/price/stream WebSocket — synthetic random walk for now.
P4: replace with avantis_trader_sdk FeedClient connected to wss://hermes.pyth.network/ws
"""

import asyncio
import random
from datetime import datetime, timezone
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

_mock_price = 3500.0


@router.websocket("/stream")
async def price_stream(ws: WebSocket):
    await ws.accept()
    global _mock_price
    try:
        while True:
            _mock_price += (random.random() - 0.495) * 5
            _mock_price = max(100, _mock_price)

            from routes import trade as trade_module
            active = trade_module._trader_client  # placeholder hook for active trade
            # P3: pull active trade from Supabase + overlay live PnL

            await ws.send_json({
                "eth_price": round(_mock_price, 2),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "active_trade": None,
            })
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        return
