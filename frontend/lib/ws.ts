import type { ActiveTrade } from "./api";

export interface PriceMessage {
  eth_price: number;
  timestamp: string;
  active_trade: ActiveTrade | null;
}

type OnMessage = (msg: PriceMessage) => void;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export function connectPriceStream(onMessage: OnMessage): () => void {
  if (!API_URL) {
    return startMockStream(onMessage);
  }

  const wsUrl = API_URL.replace(/^https:\/\//, "wss://").replace(
    /^http:\/\//,
    "ws://",
  );

  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(`${wsUrl}/price/stream`);

    ws.onopen = () => {
      attempt = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as PriceMessage;
        onMessage(data);
      } catch {
        /* ignore malformed messages */
      }
    };

    // A drop mid-trade silently freezes PnL because `a.price` never
    // ticks again. Reconnect with capped exponential backoff so the
    // feed self-heals without a page refresh.
    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const delay = Math.min(5000, 250 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, delay);
    };
    ws.onerror = scheduleReconnect;
    ws.onclose = scheduleReconnect;
  };

  open();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

function startMockStream(onMessage: OnMessage): () => void {
  let price = 3500;
  const interval = setInterval(() => {
    price += (Math.random() - 0.485) * 3.5;
    onMessage({
      eth_price: price,
      timestamp: new Date().toISOString(),
      active_trade: null,
    });
  }, 500);
  return () => clearInterval(interval);
}
