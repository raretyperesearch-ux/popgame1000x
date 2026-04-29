"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { getEmbeddedEthereumAddress } from "@/lib/embedded-wallet";
import Topbar from "./components/Topbar";
import HistoryStrip, { type HistoryEntry } from "./components/HistoryStrip";
import GameScene, { type GameSceneHandle } from "./components/GameScene";
import PnLReadout from "./components/PnLReadout";
import Controls from "./components/Controls";
import HelpOverlay from "./components/HelpOverlay";
import { getBalance, openTrade } from "@/lib/api";
import { sounds } from "@/lib/sounds";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";

export default function Home() {
  const { authenticated, getAccessToken, user } = usePrivy();
  // Always the embedded wallet — see Topbar.tsx for rationale.
  const walletAddress = getEmbeddedEthereumAddress(user);
  const [balance, setBalance] = useState(100);
  const [ethBalance, setEthBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [leverage, setLeverage] = useState(100);
  const [wager, setWager] = useState(5);
  const [gameState, setGameState] = useState<GameState>("IDLE");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pnl, setPnl] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [openInFlight, setOpenInFlight] = useState(false);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const tradeErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTradeError = useCallback((msg: string) => {
    setTradeError(msg);
    if (tradeErrorTimerRef.current) clearTimeout(tradeErrorTimerRef.current);
    tradeErrorTimerRef.current = setTimeout(() => setTradeError(null), 6000);
  }, []);
  /* Auth is required when we're talking to a real backend, not for mock or
     localhost. Without this the auth gate fires login() on every jump in
     local dev and the character never flies. */
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
  const isLocalApi =
    apiUrl.includes("localhost") || apiUrl.includes("127.0.0.1");
  const needsAuthForTrades = Boolean(apiUrl) && !isLocalApi;
  const paperMode = needsAuthForTrades && !authenticated;

  const gameRef = useRef<GameSceneHandle>(null);

  /* Balance refresh: pulls the real wallet USDC from /balance whenever
     the game returns to IDLE (mount + after each trade settles via
     reset()). On-chain balance becomes source of truth at idle; the
     in-flight optimistic local balance still drives wager-deduct/PnL-add
     during a round. Backend unreachable → keep local balance. */
  useEffect(() => {
    if (gameState !== "IDLE") return;
    let cancelled = false;
    if (paperMode) {
      setEthBalance(0.01);
      setBalanceLoading(false);
      return;
    }
    setBalanceLoading(true);
    getBalance(getAccessToken, walletAddress)
      .then((res) => {
        if (cancelled) return;
        setBalance(res.usdc_balance);
        setEthBalance(res.eth_balance ?? 0);
      })
      .catch((e) => {
        console.warn("[balance] getBalance failed — keeping local balance:", e);
        if (!cancelled) setEthBalance(null);
      })
      .finally(() => {
        if (!cancelled) setBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gameState, getAccessToken, walletAddress, paperMode]);

  /* first-launch help overlay */
  useEffect(() => {
    try {
      const seen = localStorage.getItem("handdrawn_help_seen");
      if (!seen) {
        setTimeout(() => setShowHelp(true), 600);
      }
    } catch {
      /* SSR safety */
    }
  }, []);

  /* Background music starts on the first user interaction (browser autoplay
     policy needs it). One-shot listener — removes itself after firing. */
  useEffect(() => {
    const start = () => {
      sounds.startMusic();
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
    window.addEventListener("pointerdown", start);
    window.addEventListener("keydown", start);
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, []);

  const handleCloseHelp = useCallback(() => {
    setShowHelp(false);
    try {
      localStorage.setItem("handdrawn_help_seen", "1");
    } catch {
      /* SSR safety */
    }
  }, []);

  const handleHistoryPush = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = [...prev, entry];
      return next.length > 5 ? next.slice(-5) : next;
    });
  }, []);

  const handleAction = useCallback(async () => {
    if (gameState === "IDLE" && balance >= wager && !openInFlight) {
      setOpenInFlight(true);
      try {
        let entryPrice = 0;
        let liquidationPrice = 0;
        let tradeOk = true;
        if (!paperMode) {
          try {
            const trade = await openTrade(leverage, wager, getAccessToken, walletAddress);
            entryPrice = trade.entry_price;
            liquidationPrice = trade.liquidation_price;
          } catch (e) {
            tradeOk = false;
          // apiFetch's "API <status>: <body>" format — pull the JSON
          // detail out so we can show something readable.
          const raw = e instanceof Error ? e.message : String(e);
          const statusMatch = raw.match(/^API (\d+):/);
          const status = statusMatch ? Number(statusMatch[1]) : 0;
          let detail = raw;
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]) as { detail?: string };
              if (parsed.detail) detail = parsed.detail;
            } catch { /* fall through */ }
          }
          if (status === 402 || status === 409 || status === 504 || status === 502) {
            // 402: needs ETH for gas. 409: already has open trade.
            // 504: Privy signer timeout (delegation usually). 502: Privy
            // returned an error (insufficient funds, bad signature, etc).
            // All four backend messages are user-readable; surface
            // verbatim. Truncate just to keep the banner from blowing up.
            showTradeError(detail.slice(0, 240));
          } else if (status === 0) {
            // No HTTP status — fetch itself failed (CORS, server reset,
            // browser closed connection). Tell the user to retry rather
            // than the unhelpful raw "Failed to fetch".
            showTradeError(
              "Lost connection to the trade server. Try again in a moment.",
            );
          } else {
            showTradeError(`Trade didn't land (${status}): ${detail.slice(0, 200)}`);
          }
            console.warn("[trade] openTrade failed:", e);
          }
        }
        if (tradeOk) {
          setBalance((prev) => prev - wager);
          gameRef.current?.startJump(leverage, wager, entryPrice, liquidationPrice);
        }
      } finally {
        setOpenInFlight(false);
      }
    } else if (gameState === "LIVE") {
      gameRef.current?.stopTrade();
    }
  }, [gameState, balance, wager, leverage, openInFlight, paperMode, getAccessToken, walletAddress, showTradeError]);

  const handleLeverageChange = useCallback(
    (v: number) => {
      if (gameState !== "IDLE") return;
      setLeverage(Math.max(75, Math.min(250, v)));
    },
    [gameState],
  );

  const handleWagerChange = useCallback(
    (v: number) => {
      if (gameState !== "IDLE") return;
      setWager(Math.max(1, Math.min(balance, v)));
    },
    [gameState, balance],
  );

  return (
    <div className="cabinet">
      <Topbar
        balance={balance}
        ethBalance={ethBalance}
        balanceLoading={balanceLoading}
        onHelpClick={() => setShowHelp(true)}
        onError={showTradeError}
      />
      <GameScene
        ref={gameRef}
        balance={balance}
        setBalance={setBalance}
        leverage={leverage}
        wager={wager}
        gameState={gameState}
        setGameState={setGameState}
        onHistoryPush={handleHistoryPush}
        onPnlChange={setPnl}
        paperMode={paperMode}
        pnlReadout={<PnLReadout pnlDollars={(gameState === "LIVE" || gameState === "STOPPED") ? pnl : null} />}
      />
      <HistoryStrip history={history} />
      <Controls
        leverage={leverage}
        wager={wager}
        balance={balance}
        busy={openInFlight}
        state={gameState}
        onLeverageChange={handleLeverageChange}
        onWagerChange={handleWagerChange}
        onAction={handleAction}
      />
      <HelpOverlay show={showHelp} onClose={handleCloseHelp} />
      {tradeError && (
        <div className="trade-error-banner" role="alert" onClick={() => setTradeError(null)}>
          {tradeError}
        </div>
      )}
      {paperMode && (
        <div className="trade-error-banner" role="status">
          PAPER MODE: not logged in — using test balance + simulated trades.
        </div>
      )}
    </div>
  );
}
