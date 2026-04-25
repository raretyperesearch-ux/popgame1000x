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
  const ws = new WebSocket(`${wsUrl}/price/stream`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as PriceMessage;
      onMessage(data);
    } catch {
      /* ignore malformed messages */
    }
  };

  ws.onerror = () => {
    /* silent — reconnect logic can be added later */
  };

  return () => ws.close();
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
