"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Topbar from "./components/Topbar";
import HistoryStrip, { type HistoryEntry } from "./components/HistoryStrip";
import GameScene, { type GameSceneHandle } from "./components/GameScene";
import PnLReadout from "./components/PnLReadout";
import Controls from "./components/Controls";
import HelpOverlay from "./components/HelpOverlay";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";

export default function Home() {
  const [balance, setBalance] = useState(100);
  const [leverage, setLeverage] = useState(100);
  const [wager, setWager] = useState(5);
  const [gameState, setGameState] = useState<GameState>("IDLE");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pnl, setPnl] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const gameRef = useRef<GameSceneHandle>(null);

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

  const handleAction = useCallback(() => {
    if (gameState === "IDLE" && balance >= wager) {
      setBalance((prev) => prev - wager);
      setGameState("RUNNING");
      gameRef.current?.startJump(leverage, wager);
    } else if (gameState === "LIVE") {
      gameRef.current?.stopTrade();
    }
  }, [gameState, balance, wager, leverage]);

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
        onHelpClick={() => setShowHelp(true)}
      />
      <HistoryStrip history={history} />
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
        pnlReadout={<PnLReadout pnlDollars={gameState === "LIVE" ? pnl : null} />}
      />
      <Controls
        leverage={leverage}
        wager={wager}
        balance={balance}
        state={gameState}
        onLeverageChange={handleLeverageChange}
        onWagerChange={handleWagerChange}
        onAction={handleAction}
      />
      <HelpOverlay show={showHelp} onClose={handleCloseHelp} />
    </div>
  );
}
