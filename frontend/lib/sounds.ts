"use client";

import { Howl, Howler } from "howler";

/**
 * Game sound manager.
 *
 * Loads sound files lazily on first request, plays them via Howler. Engine
 * loop is tracked so we can start/stop it as the player enters/exits the
 * LIVE state. If a file is missing the corresponding play() is silent —
 * no errors thrown, just a console warning so you know which file to add.
 *
 * Drop audio files into frontend/public/sounds/ matching the names below.
 * See frontend/public/sounds/README.md for source recommendations.
 */
export type SoundId =
  | "lever-pull"
  | "liftoff"
  | "footstep"
  | "engine-loop"
  | "engine-stop"
  | "win-fanfare"
  | "loss-thud"
  | "rekt-crash"
  | "ui-click"
  | "coin-clink"
  | "deploy-chute";

interface SoundDef {
  file: string;
  volume?: number;
  loop?: boolean;
  rate?: number;
}

const DEFS: Record<SoundId, SoundDef> = {
  "lever-pull":   { file: "lever.ogg",       volume: 0.55 },
  "liftoff":      { file: "liftoff.ogg",     volume: 0.7 },
  "footstep":     { file: "footstep.ogg",    volume: 0.35 },
  "engine-loop":  { file: "engine.ogg",      volume: 0.35, loop: true },
  "engine-stop":  { file: "engine-stop.ogg", volume: 0.5 },
  "win-fanfare":  { file: "win.ogg",         volume: 0.75 },
  "loss-thud":    { file: "loss.ogg",        volume: 0.6 },
  "rekt-crash":   { file: "rekt.ogg",        volume: 0.85 },
  "ui-click":     { file: "click.ogg",       volume: 0.35 },
  "coin-clink":   { file: "coin.ogg",        volume: 0.45 },
  "deploy-chute": { file: "chute.ogg",       volume: 0.5 },
};

const STORAGE_KEY = "popgame-muted";

class SoundManager {
  private sounds = new Map<SoundId, Howl>();
  private engineHandle: number | null = null;
  private muted = false;
  private masterVolume = 0.8;
  private initialized = false;

  init() {
    if (this.initialized) return;
    this.initialized = true;
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    this.muted = saved === "1";
    Howler.mute(this.muted);
    Howler.volume(this.masterVolume);
  }

  private getSound(id: SoundId): Howl {
    let h = this.sounds.get(id);
    if (!h) {
      const def = DEFS[id];
      h = new Howl({
        src: [`/sounds/${def.file}`],
        volume: def.volume ?? 0.5,
        loop: !!def.loop,
        rate: def.rate ?? 1,
        preload: true,
        onloaderror: () => {
          // silent failure — files may not be present yet
          console.warn(`[sounds] missing /sounds/${def.file}`);
        },
      });
      this.sounds.set(id, h);
    }
    return h;
  }

  play(id: SoundId): number | null {
    if (typeof window === "undefined") return null;
    this.init();
    if (this.muted) return null;
    try {
      return this.getSound(id).play();
    } catch {
      return null;
    }
  }

  startEngine() {
    if (typeof window === "undefined") return;
    this.init();
    if (this.engineHandle !== null) return;
    if (this.muted) return;
    const h = this.getSound("engine-loop");
    this.engineHandle = h.play();
    h.fade(0, (DEFS["engine-loop"].volume ?? 0.5), 220, this.engineHandle);
  }

  stopEngine() {
    if (this.engineHandle === null) return;
    const h = this.sounds.get("engine-loop");
    if (h) {
      const handle = this.engineHandle;
      h.fade(h.volume(handle) as number, 0, 180, handle);
      window.setTimeout(() => h.stop(handle), 200);
    }
    this.engineHandle = null;
  }

  isMuted() {
    this.init();
    return this.muted;
  }

  setMuted(m: boolean) {
    this.init();
    this.muted = m;
    Howler.mute(m);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, m ? "1" : "0");
    }
    if (m) this.stopEngine();
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }
}

export const sounds = new SoundManager();
