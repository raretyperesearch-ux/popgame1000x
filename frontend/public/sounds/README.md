# Game audio (Kenney CC0)

These sounds are bundled directly from [Kenney.nl](https://kenney.nl) audio packs. All Kenney assets are released under **Creative Commons Zero (CC0)** — public domain, no attribution required, free for any use including commercial.

The sound system in `frontend/lib/sounds.ts` references each file by name. Swap any of these for your own files (any Howler-supported format: `.ogg`, `.mp3`, `.wav`, `.m4a`) and update the `DEFS` map in `lib/sounds.ts` if you change the extension.

## What's currently shipped

| File | Triggered when | Source |
|---|---|---|
| `lever.ogg` | Player pulls the lever to start a trade | Kenney Casino Audio · `chips-handle-3` |
| `liftoff.ogg` | Liftoff at end of PREPARE → JUMPING | Kenney Sci-Fi Sounds · `spaceEngine_000` |
| `engine.ogg` | LIVE state (loops while flying) | Kenney Sci-Fi Sounds · `spaceEngineLow_000` |
| `engine-stop.ogg` | LIVE → STOPPED (parachute deploy) | Kenney Sci-Fi Sounds · `forceField_002` |
| `chute.ogg` | Parachute opens at stop | Kenney Sci-Fi Sounds · `forceField_000` |
| `win.ogg` | EOG modal opens with kind="win" | Kenney Music Jingles · `8-Bit/jingles_NES00` |
| `loss.ogg` | EOG modal opens with kind="loss" | Kenney Music Jingles · `8-Bit/jingles_NES05` |
| `rekt.ogg` | Liquidation impact (immediate) | Kenney Sci-Fi Sounds · `explosionCrunch_004` |
| `click.ogg` | Any UI button | Kenney Interface Sounds · `click_004` |
| `coin.ogg` | Share/Download buttons | Kenney Casino Audio · `chips-collide-1` |

## Swapping a sound

Want a different vibe?

1. Browse the original Kenney packs:
   - [Casino Audio](https://kenney.nl/assets/casino-audio)
   - [Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds)
   - [Interface Sounds](https://kenney.nl/assets/interface-sounds)
   - [Music Jingles](https://kenney.nl/assets/music-jingles) (8-Bit / NES, Pizzicato, Sax, Hit, Steel)
   - [Impact Sounds](https://kenney.nl/assets/impact-sounds)
   - [UI Audio](https://kenney.nl/assets/ui-audio)
2. Replace the file in this folder, keeping the same filename, OR
3. Use a different filename and update the path in `frontend/lib/sounds.ts` (`DEFS` map).

## Tuning

Per-sound default volumes are in `lib/sounds.ts` (`DEFS`). Master volume is 0.8. Engine loop is intentionally low (0.35) since it plays continuously. The 🔊 / 🔇 toggle in the top bar mutes everything (persisted to `localStorage`).

## Adding a new sound

1. Drop the file in this folder.
2. Add the id and definition to `DEFS` in `lib/sounds.ts`.
3. Add the id to the `SoundId` union type.
4. `sounds.play("your-id")` from anywhere.
