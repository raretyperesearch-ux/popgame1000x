"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { getEmbeddedEthereumAddress } from "@/lib/embedded-wallet";
import Topbar from "./components/Topbar";
import HistoryStrip, { type HistoryEntry } from "./components/HistoryStrip";
import GameScene, { type GameSceneHandle, type TradeDirection } from "./components/GameScene";
import PnLReadout from "./components/PnLReadout";
import Controls from "./components/Controls";
import HelpOverlay from "./components/HelpOverlay";
import { getBalance, openTrade, forceCloseTrade, getHistory, getTradeStatus, type HistoryTrade } from "@/lib/api";
import { readOnchainBalances } from "@/lib/onchain-balance";
import { sounds } from "@/lib/sounds";
import { MIN_TRADE_NOTIONAL_USD, isBelowMinPosition, minPositionHint, liveNotionalFor } from "@/lib/trade-sizing";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";
type PlayMode = "live" | "demo";

const DEMO_WAGER_USDC = 100;

/* Map a persisted backend trade to the strip's entry shape. Discards
   open trades (no exit / net_pnl yet) — caller is responsible for
   filtering before mapping. */
function historyTradeToEntry(t: HistoryTrade): HistoryEntry {
  const net = t.net_pnl_usdc ?? 0;
  return {
    amt: net,
    win: net >= 0,
    entry: t.entry_price,
    exit: t.exit_price,
    leverage: t.leverage,
    wager: t.wager_usdc,
    openedAt: t.opened_at,
    closedAt: t.closed_at,
    liquidated: t.was_liquidated === true,
  };
}

export default function Home() {
  const { authenticated, getAccessToken, user } = usePrivy();
  // Always the embedded wallet — see Topbar.tsx for rationale.
  const walletAddress = getEmbeddedEthereumAddress(user);
  // Initial paper-mode / mock-mode balance. Real wallets get overwritten
  // on mount by readOnchainBalances. $1000 lets the wager slider exercise
  // its full $1-$1000 range without exhausting the test bankroll.
  const [balance, setBalance] = useState(1000);
  const [ethBalance, setEthBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [leverage, setLeverage] = useState(100);
  const [wager, setWager] = useState(100);
  const [direction, setDirection] = useState<TradeDirection>("long");
  const [gameState, setGameState] = useState<GameState>("IDLE");
  const [playMode, setPlayMode] = useState<PlayMode>("live");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pnl, setPnl] = useState<number | null>(null);
  /* Bumped after every trade close so the topbar Leaderboard picks up
     fresh standings without polling. The component watches the value
     in its useEffect deps. */
  const [leaderboardRefreshKey, setLeaderboardRefreshKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [openInFlight, setOpenInFlight] = useState(false);
  const [liveTradeReady, setLiveTradeReady] = useState(true);
  const [settling, setSettling] = useState(false);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [stuckTradeRecovery, setStuckTradeRecovery] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [showPaperModeNotice, setShowPaperModeNotice] = useState(false);
  const tradeErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTradeError = useCallback((msg: string) => {
    setTradeError(msg);
    setStuckTradeRecovery(false);
    if (tradeErrorTimerRef.current) clearTimeout(tradeErrorTimerRef.current);
    tradeErrorTimerRef.current = setTimeout(() => setTradeError(null), 6000);
  }, []);
  /* When the backend reports an existing open trade, surface a recovery
     CTA instead of just an error toast. Player has no other path to
     unstick the position from the UI — the alternative is a manual
     curl. The banner sticks until the user clicks Close stuck trade
     or dismisses, so it doesn't auto-fade like other errors. */
  const showStuckTradeError = useCallback((msg: string) => {
    setTradeError(msg);
    setStuckTradeRecovery(true);
    if (tradeErrorTimerRef.current) {
      clearTimeout(tradeErrorTimerRef.current);
      tradeErrorTimerRef.current = null;
    }
  }, []);
  const dismissTradeError = useCallback(() => {
    setTradeError(null);
    setStuckTradeRecovery(false);
    if (tradeErrorTimerRef.current) {
      clearTimeout(tradeErrorTimerRef.current);
      tradeErrorTimerRef.current = null;
    }
  }, []);
  const recoverStuckTrade = useCallback(async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      // force-close on the backend resolves the open trade from
      // get_trades(user.address), so it works even though the local
      // game state never observed the orphan. Net PnL is real but we
      // don't display it — the player just wants to be unblocked.
      await forceCloseTrade(getAccessToken, walletAddress);
      dismissTradeError();
      setTradeError("Stuck trade closed. Try jumping again.");
      tradeErrorTimerRef.current = setTimeout(() => setTradeError(null), 4000);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      showTradeError(`Couldn't close stuck trade: ${raw.slice(0, 200)}`);
    } finally {
      setRecovering(false);
    }
  }, [recovering, getAccessToken, walletAddress, dismissTradeError, showTradeError]);
  /* Auth is required when we're talking to a real backend, not for mock or
     localhost. Without this the auth gate fires login() on every jump in
     local dev and the character never flies. */
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
  const isLocalApi =
    apiUrl.includes("localhost") || apiUrl.includes("127.0.0.1");
  const needsAuthForTrades = Boolean(apiUrl) && !isLocalApi;
  const paperMode = needsAuthForTrades && !authenticated;
  const isConnected = authenticated && Boolean(walletAddress);

  useEffect(() => {
    if (!paperMode) {
      setShowPaperModeNotice(false);
      return;
    }
    setShowPaperModeNotice(true);
    const t = setTimeout(() => setShowPaperModeNotice(false), 4800);
    return () => clearTimeout(t);
  }, [paperMode]);

  const gameRef = useRef<GameSceneHandle>(null);

  /* Balance refresh: at IDLE we want ground truth for the displayed
     wallet. When the user has an embedded wallet, read USDC + ETH
     directly from Base — this is independent of the backend, so a
     mock-mode build (NEXT_PUBLIC_API_URL unset) or a Railway outage
     can't make the displayed balance lie. The in-flight local balance
     still drives wager-deduct/PnL-add during a round. */
  useEffect(() => {
    if (gameState !== "IDLE") return;
    let cancelled = false;
    if (paperMode) {
      setEthBalance(0.01);
      setBalanceLoading(false);
      return;
    }
    if (walletAddress) {
      setBalanceLoading(true);
      readOnchainBalances(walletAddress as `0x${string}`)
        .then((r) => {
          if (cancelled) return;
          setBalance(r.usdcBalance);
          setEthBalance(r.ethBalance);
        })
        .catch((e) => {
          console.warn("[balance] on-chain read failed:", e);
          if (!cancelled) setEthBalance(null);
        })
        .finally(() => {
          if (!cancelled) setBalanceLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    /* No embedded wallet yet (just logged in, or running fully unauthed
       with mock backend) — fall back to the legacy /balance call so
       mock dev mode still shows its $100 sandbox. */
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

  /* Seed the LAST 5 SCALPS strip with persisted history on auth/wallet
     ready. Without this, the strip is in-memory only and resets on
     every refresh — players had no way to see prior trades. Skipped in
     paper mode (no real wallet) and mock mode (no backend / getHistory
     returns empty). The in-memory `handleHistoryPush` continues to
     update the strip during play; this just gives it an initial state.

     Order matches handleHistoryPush's append-end convention: oldest at
     index 0 (visually left), newest at index 4 (visually right). The
     backend returns newest-first, so we reverse after slicing. */
  useEffect(() => {
    if (!authenticated || paperMode || !walletAddress) return;
    let cancelled = false;
    getHistory(5, getAccessToken, walletAddress)
      .then((res) => {
        if (cancelled) return;
        const seeded = res.trades
          .filter((t) => t.closed_at !== null && t.net_pnl_usdc !== null)
          .slice(0, 5)
          .reverse()
          .map(historyTradeToEntry);
        if (seeded.length > 0) setHistory(seeded);
      })
      .catch((e) => {
        console.warn("[history] seed fetch failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, paperMode, walletAddress, getAccessToken]);

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
    /* A close just landed — nudge the Leaderboard component to refetch
       so its standings reflect the new realized PnL. Cheap: just one
       extra HTTP per closed trade, no polling. */
    setLeaderboardRefreshKey((k) => k + 1);
  }, []);

  const waitForLiveTrade = useCallback(async (sessionId: string) => {
    for (let i = 0; i < 24; i += 1) {
      const status = await getTradeStatus(sessionId, getAccessToken, walletAddress);
      if (status.status === "live" && status.entry_price && (status.liquidation_price || status.liq_price)) {
        console.info("[trade/open-ui] session live/confirmed", { sessionId, poll: i + 1 });
        return status;
      }
      if (status.status === "failed_open") {
        throw new Error(status.error || "Trade failed to open on Avantis.");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Trade is still opening on Avantis. Try again in a moment.");
  }, [getAccessToken, walletAddress]);

  const handleAction = useCallback(async (actionDirection?: TradeDirection) => {
    const activeDirection = actionDirection ?? direction;
    const clickedAt = performance.now();
    console.info("[trade/open-ui] click received", { state: gameState, direction: activeDirection });
    if (gameState === "IDLE" && !openInFlight) {
      setDirection(activeDirection);
      if (!isConnected) {
        setPlayMode("demo");
        gameRef.current?.startJump(
          leverage,
          DEMO_WAGER_USDC,
          0,
          0,
          activeDirection,
          true,
        );
        return;
      }
      setPlayMode("live");
      // No client-side live open when the selected wager is underfunded:
      // keep JUMP/DIVE visible, but route the connected user to funding
      // instead of silently starting a demo or hitting /trade/open.
      if (wager > balance) {
        const need = (wager - balance).toFixed(2);
        sounds.play("ui-click");
        window.dispatchEvent(new Event("popgame:fund-usdc"));
        showTradeError(
          `Deposit To Play Live — need $${need} for this wager. Lower wager or deposit.`,
        );
        return;
      }
      if (isBelowMinPosition(wager, leverage)) {
        sounds.play("ui-click");
        showTradeError(
          `Position Too Small — Increase Boost Or Wager. ${minPositionHint(wager, leverage)}. Current ~$${liveNotionalFor(wager, leverage).toFixed(0)} / min ~$${MIN_TRADE_NOTIONAL_USD.toFixed(0)}.`,
        );
        return;
      }
      setOpenInFlight(true);
      setLiveTradeReady(false);
      gameRef.current?.startJump(leverage, wager, 0, 0, activeDirection);
      console.info("[trade/open-ui] launch state set", { elapsedMs: Math.round(performance.now() - clickedAt) });
      try {
        console.info("[trade/open-ui] /trade/open request sent", { elapsedMs: Math.round(performance.now() - clickedAt) });
        const trade = await openTrade(leverage, wager, activeDirection, getAccessToken, walletAddress);
        console.info("[trade/open-ui] /trade/open response received", { elapsedMs: Math.round(performance.now() - clickedAt), status: trade.status ?? "live" });
        let entryPrice = trade.entry_price;
        let liquidationPrice = trade.liquidation_price;
        if ((trade.status ?? "live") === "opening") {
          console.info("[trade/open-ui] opening accepted", { elapsedMs: Math.round(performance.now() - clickedAt) });
          const live = await waitForLiveTrade(trade.session_id || trade.tx_hash);
          entryPrice = live.entry_price;
          liquidationPrice = live.liquidation_price ?? live.liq_price;
        }
        if (!entryPrice || !liquidationPrice) {
          throw new Error("Trade opened but Avantis entry/liquidation prices were not available yet.");
        }
        setBalance((prev) => prev - wager);
        gameRef.current?.confirmTrade(entryPrice, liquidationPrice);
        setLiveTradeReady(true);
      } catch (e) {
        setLiveTradeReady(true);
        gameRef.current?.cancelLaunch();
        // apiFetch's "API <status>: <body>" format — pull the JSON
        // detail out so we can show something readable.
        const raw = e instanceof Error ? e.message : String(e);
        const statusMatch = raw.match(/^API (\d+):/);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        let detail = raw;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as { detail?: string | { message?: string } };
            if (typeof parsed.detail === "string") {
              detail = parsed.detail;
            } else if (parsed.detail?.message) {
              detail = parsed.detail.message;
            }
          } catch { /* fall through */ }
        }
        if (status === 409) {
          showStuckTradeError(detail.slice(0, 240));
        } else if (status === 400 && raw.includes("below_min_position")) {
          showTradeError("Position Too Small — Increase Boost Or Wager. Avantis minimum notional not met.");
        } else if (status === 402 || status === 504 || status === 502) {
          showTradeError(detail.slice(0, 240));
        } else if (status === 0) {
          showTradeError(`TRADE FAILED TO OPEN — ${detail.slice(0, 200)}`);
        } else {
          showTradeError(`TRADE FAILED TO OPEN (${status}): ${detail.slice(0, 200)}`);
        }
        console.warn("[trade] openTrade failed:", e);
      } finally {
        setOpenInFlight(false);
      }
    } else if (gameState === "LIVE") {
      if (!liveTradeReady) {
        showTradeError("Still opening trade — confirming on Avantis before close is enabled.");
        return;
      }
      gameRef.current?.stopTrade();
    } else if (gameState === "STOPPED" && !settling) {
      gameRef.current?.stopTrade();
    }
  }, [gameState, balance, wager, leverage, direction, openInFlight, isConnected, liveTradeReady, settling, getAccessToken, walletAddress, showTradeError, showStuckTradeError, waitForLiveTrade]);

  const handleLeverageChange = useCallback(
    (v: number) => {
      if (gameState !== "IDLE") return;
      setLeverage(Math.max(75, Math.min(500, v)));
    },
    [gameState],
  );

  const handleWagerChange = useCallback(
    (v: number) => {
      if (gameState !== "IDLE") return;
      // No upper cap — the user can pick any wager. Insufficient balance
      // is surfaced at JUMP time, not by silently clamping their input.
      setWager(Math.max(1, Math.floor(v)));
    },
    [gameState],
  );

  return (
    <div className="cabinet">
      <Topbar
        balance={balance}
        ethBalance={ethBalance}
        balanceLoading={balanceLoading}
        onHelpClick={() => setShowHelp(true)}
        onError={showTradeError}
        leaderboardRefreshKey={leaderboardRefreshKey}
        paperMode={paperMode}
      />
      <GameScene
        ref={gameRef}
        balance={balance}
        setBalance={setBalance}
        leverage={leverage}
        wager={wager}
        gameState={gameState}
        direction={direction}
        setGameState={setGameState}
        onHistoryPush={handleHistoryPush}
        onPnlChange={setPnl}
        paperMode={paperMode}
        playMode={playMode}
        onDemoEnd={() => setPlayMode("live")}
        onError={showTradeError}
        onSettlingChange={setSettling}
        pnlReadout={<PnLReadout pnlDollars={(gameState === "LIVE" || gameState === "STOPPED") ? pnl : null} />}
      />
      <HistoryStrip history={history} />
      <Controls
        leverage={leverage}
        wager={wager}
        balance={balance}
        pnl={pnl}
        direction={direction}
        busy={openInFlight}
        state={gameState}
        isConnected={isConnected}
        liveTradeReady={liveTradeReady}
        settling={settling}
        onLeverageChange={handleLeverageChange}
        onWagerChange={handleWagerChange}
        onAction={handleAction}
      />
      <HelpOverlay show={showHelp} onClose={handleCloseHelp} />
      {tradeError && (
        <div className="trade-error-banner" role="alert">
          <span className="trade-error-text">{tradeError}</span>
          {stuckTradeRecovery ? (
            <span className="trade-error-actions">
              <button
                type="button"
                className="trade-error-btn primary"
                onClick={recoverStuckTrade}
                disabled={recovering}
              >
                {recovering ? "closing…" : "close stuck trade"}
              </button>
              <button
                type="button"
                className="trade-error-btn"
                onClick={dismissTradeError}
              >
                dismiss
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="trade-error-btn dismiss"
              onClick={dismissTradeError}
              aria-label="Dismiss"
            >
              ×
            </button>
          )}
        </div>
      )}
      {paperMode && showPaperModeNotice && (
        <div className="paper-mode-banner" role="status">
          paper mode: test balance + simulated trades
        </div>
      )}
    </div>
  );
}
