"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import { usePrivy } from "@privy-io/react-auth";
import { getEmbeddedEthereumAddress } from "@/lib/embedded-wallet";
import Topbar from "./components/Topbar";
import HistoryStrip, { type HistoryEntry } from "./components/HistoryStrip";
import GameScene, { type GameSceneHandle, type TradeDirection } from "./components/GameScene";
import PnLReadout from "./components/PnLReadout";
import Controls from "./components/Controls";
import HelpOverlay from "./components/HelpOverlay";
import { getBalance, openTrade, forceCloseTrade, getHistory, getTradeStatus, getActiveTrade, type ActiveTradeResponse, type HistoryTrade } from "@/lib/api";
import { readOnchainBalances } from "@/lib/onchain-balance";
import { sounds } from "@/lib/sounds";
import { MIN_TRADE_NOTIONAL_USD, isBelowMinPosition, minPositionHint, liveNotionalFor } from "@/lib/trade-sizing";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";
type PlayMode = "live" | "demo";
const FUEL_PRESETS = [1, 25, 100, 1000];

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
  const [activeRecovery, setActiveRecovery] = useState(false);
  const [liveTradeReady, setLiveTradeReady] = useState(true);
  const [settling, setSettling] = useState(false);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [stuckTradeRecovery, setStuckTradeRecovery] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [showPaperModeNotice, setShowPaperModeNotice] = useState(false);
  const [lowFuelPrompt, setLowFuelPrompt] = useState(false);
  const [fuelTankOpen, setFuelTankOpen] = useState(false);
  const [fuelTankAmount, setFuelTankAmount] = useState(5);
  const [addFuelPulseKey, setAddFuelPulseKey] = useState(0);
  const [lowFuelBumpKey, setLowFuelBumpKey] = useState(0);
  const [fuelPreview, setFuelPreview] = useState(false);
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
  const fuelShortfall = Math.max(0, wager - balance);
  const needsFuel = isConnected && fuelShortfall > 0;
  const displayedFuelShortfall = fuelPreview && !needsFuel ? 96.95 : fuelShortfall;
  const showLowFuelPreview = fuelPreview && gameState === "IDLE";

  const flashAddFuelButton = useCallback(() => {
    setAddFuelPulseKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!needsFuel || gameState !== "IDLE" || openInFlight || activeRecovery) return;
    flashAddFuelButton();
  }, [needsFuel, wager, gameState, openInFlight, activeRecovery, flashAddFuelButton]);

  useEffect(() => {
    if (!needsFuel) setLowFuelPrompt(false);
  }, [needsFuel]);

  const openFuelTank = useCallback(() => {
    setFuelTankAmount(Math.max(5, Math.ceil(displayedFuelShortfall || 5)));
    setFuelTankOpen(true);
    setLowFuelPrompt(false);
  }, [displayedFuelShortfall]);

  const fundFromFuelTank = useCallback(() => {
    window.dispatchEvent(new CustomEvent("popgame:fund-usdc", { detail: { amount: fuelTankAmount } }));
    setFuelTankOpen(false);
  }, [fuelTankAmount]);

  const lowerFuel = useCallback(() => {
    const affordable = FUEL_PRESETS.filter((amt) => amt <= balance);
    if (affordable.length > 0) {
      setWager(Math.max(...affordable));
      setLowFuelPrompt(false);
      return;
    }
    setWager(1);
    flashAddFuelButton();
  }, [balance, flashAddFuelButton]);

  const showLowFuelPrompt = useCallback(() => {
    sounds.play("ui-click");
    setLowFuelPrompt(true);
    setLowFuelBumpKey((k) => k + 1);
    flashAddFuelButton();
  }, [flashAddFuelButton]);

  useEffect(() => {
    if (!paperMode) {
      setShowPaperModeNotice(false);
      return;
    }
    setShowPaperModeNotice(true);
    const t = setTimeout(() => setShowPaperModeNotice(false), 4800);
    return () => clearTimeout(t);
  }, [paperMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setFuelPreview(params.get("fuelPreview") === "1");
  }, []);

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



  const restoreActiveTrade = useCallback((active: ActiveTradeResponse) => {
    const entry = active.entry_price;
    const liq = active.liquidation_price ?? active.liq_price;
    if (!active.exists || !entry || !liq || !active.leverage || !active.wager_usdc) {
      return false;
    }
    const restoredDirection: TradeDirection = active.is_long === false ? "short" : "long";
    setPlayMode("live");
    setDirection(restoredDirection);
    setLeverage(active.leverage);
    setWager(Math.max(1, Math.round(active.wager_usdc)));
    setPnl(active.pnl_usdc ?? 0);
    gameRef.current?.restoreLiveTrade(
      active.leverage,
      active.wager_usdc,
      entry,
      liq,
      restoredDirection,
      active.current_price ?? entry,
    );
    setLiveTradeReady(true);
    setOpenInFlight(false);
    setActiveRecovery(false);
    setSettling(active.status === "closing");
    return true;
  }, []);

  useEffect(() => {
    if (!authenticated || paperMode || !walletAddress || gameState !== "IDLE") return;
    let cancelled = false;
    const recover = async () => {
      let detectedActive = false;
      setActiveRecovery(true);
      try {
        const active = await getActiveTrade(getAccessToken, walletAddress);
        if (cancelled) return;
        if (!active.exists) {
          console.info("[trade/active-ui] no active trade");
          return;
        }

        detectedActive = true;
        console.info("[trade/active-ui] active trade detected", { status: active.status, sessionId: active.session_id, tradeIndex: active.trade_index });
        showTradeError("Active Trade Detected — Reconnecting");
        if (active.status === "opening" || active.status === "pending_confirmation") {
          setOpenInFlight(true);
          setLiveTradeReady(false);
          const sessionId = active.session_id || active.tx_hash || active.open_tx_hash;
          if (!sessionId) throw new Error("Active opening trade is missing a session id.");
          const live = await waitForLiveTrade(sessionId);
          if (cancelled) return;
          const restored: ActiveTradeResponse = {
            ...active,
            exists: true,
            status: "live",
            entry_price: live.entry_price,
            liquidation_price: live.liquidation_price ?? live.liq_price,
            liq_price: live.liquidation_price ?? live.liq_price,
            trade_index: live.trade_index,
          };
          if (!restoreActiveTrade(restored)) throw new Error("Active trade became live but was missing prices.");
          return;
        }

        if (active.status === "live" || active.status === "open" || active.status === "closing") {
          if (!restoreActiveTrade(active)) throw new Error("Active trade was missing entry/liquidation data.");
        }
      } catch (e) {
        if (cancelled) return;
        const raw = e instanceof Error ? e.message : String(e);
        console.warn("[trade/active-ui] recovery failed:", e);
        showTradeError(`Active Trade Detected — Reconnecting. ${raw.slice(0, 160)}`);
      } finally {
        if (!cancelled && !detectedActive) setActiveRecovery(false);
      }
    };
    recover();
    const retry = window.setInterval(() => {
      if (cancelled) return;
      if (gameState === "IDLE") recover();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(retry);
    };
  }, [authenticated, paperMode, walletAddress, getAccessToken, gameState, waitForLiveTrade, restoreActiveTrade, showTradeError]);

  const handleAction = useCallback(async (actionDirection?: TradeDirection) => {
    const activeDirection = actionDirection ?? direction;
    const clickedAt = performance.now();
    console.info("[trade/open-ui] click received", { state: gameState, direction: activeDirection });
    if (activeRecovery) {
      showTradeError("Active Trade Detected — Reconnecting");
      return;
    }
    if (gameState === "IDLE" && !openInFlight) {
      setDirection(activeDirection);
      if (!isConnected) {
        setPlayMode("demo");
        // Practice mode uses the selected wager/boost for position sizing.
        // The fake balance only makes the controls feel funded; it is not
        // forced in as collateral and demo never opens a backend trade.
        gameRef.current?.startJump(
          leverage,
          wager,
          0,
          0,
          activeDirection,
        );
        return;
      }
      setPlayMode("live");
      // No client-side live open when the selected fuel is underfunded:
      // keep JUMP/DIVE visible, show the in-field prompt, and wait for
      // the player to choose ADD FUEL before opening the funding flow.
      if (needsFuel) {
        showLowFuelPrompt();
        return;
      }
      if (isBelowMinPosition(wager, leverage)) {
        sounds.play("ui-click");
        showTradeError(
          `Position Too Small — Increase Boost Or Fuel. ${minPositionHint(wager, leverage)}. Current ~$${liveNotionalFor(wager, leverage).toFixed(0)} / min ~$${MIN_TRADE_NOTIONAL_USD.toFixed(0)}.`,
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
          showTradeError("Position Too Small — Increase Boost Or Fuel. Avantis minimum notional not met.");
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
        showTradeError("Still readying — live trade is not ready to close yet.");
        return;
      }
      gameRef.current?.stopTrade();
    } else if (gameState === "STOPPED" && !settling) {
      gameRef.current?.stopTrade();
    }
  }, [gameState, wager, leverage, direction, openInFlight, activeRecovery, isConnected, needsFuel, liveTradeReady, settling, getAccessToken, walletAddress, showTradeError, showLowFuelPrompt, showStuckTradeError, waitForLiveTrade]);

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
      // No upper cap — the user can pick any fuel. Insufficient balance
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
        busy={openInFlight || activeRecovery}
        state={gameState}
        isConnected={isConnected}
        liveTradeReady={liveTradeReady}
        settling={settling}
        addFuelPulseKey={addFuelPulseKey}
        onLeverageChange={handleLeverageChange}
        onWagerChange={handleWagerChange}
        onAddFuel={openFuelTank}
        onAction={handleAction}
      />
      {((lowFuelPrompt && needsFuel) || showLowFuelPreview) && (
        <div key={lowFuelBumpKey} className="low-fuel-popover" role="dialog" aria-label="Low fuel">
          <button
            type="button"
            className="low-fuel-close"
            onClick={() => setLowFuelPrompt(false)}
            aria-label="Dismiss low fuel prompt"
          >
            ×
          </button>
          <Image
            src="/assets/ui/low-fuel-sign.png"
            alt=""
            className="low-fuel-sign"
            width={256}
            height={256}
          />
          <div className="low-fuel-copy">
            <strong>LOW FUEL</strong>
            <span>Need ${displayedFuelShortfall.toFixed(2)} more</span>
          </div>
          <div className="low-fuel-actions">
            <button type="button" className="low-fuel-action primary" onClick={openFuelTank}>
              ADD FUEL
            </button>
            <button type="button" className="low-fuel-action" onClick={lowerFuel}>
              LOWER FUEL
            </button>
          </div>
        </div>
      )}
      {fuelTankOpen && (
        <div className="fuel-tank-modal" role="dialog" aria-modal="true" aria-labelledby="fuel-tank-title">
          <button
            type="button"
            className="fuel-tank-close"
            onClick={() => setFuelTankOpen(false)}
            aria-label="Close Fuel Tank"
          >
            ×
          </button>
          <div className="fuel-tank-title" id="fuel-tank-title">FUEL TANK</div>
          <div className="fuel-tank-subtitle">Add USDC to power live runs.</div>
          <div className="fuel-tank-stats">
            <span>Balance <b>${balance.toFixed(2)}</b></span>
            <span>Selected Fuel <b>${wager.toFixed(2)}</b></span>
            <span>Need <b>${displayedFuelShortfall.toFixed(2)}</b></span>
          </div>
          <div className="fuel-tank-buttons" aria-label="Funding shortcuts">
            {[
              { label: "+$5", amount: 5 },
              { label: "+$25", amount: 25 },
              { label: "+$100", amount: 100 },
              { label: "MAX", amount: Math.max(5, Math.ceil(displayedFuelShortfall || wager)) },
            ].map(({ label, amount }) => (
              <button
                key={label}
                type="button"
                className={`fuel-tank-chip${fuelTankAmount === amount ? " active" : ""}`}
                onClick={() => setFuelTankAmount(amount)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="fuel-tank-primary" onClick={fundFromFuelTank}>
            ADD ${fuelTankAmount} USDC
          </button>
          <div className="fuel-tank-note">Fuel = USDC collateral for live trades. Practice mode uses fake fuel.</div>
        </div>
      )}
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
