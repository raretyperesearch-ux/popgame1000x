# Game audio

The sound system in `frontend/lib/sounds.ts` looks for these files. If a file is missing the corresponding play() is silent (with a console warning) — the game still works, it just stays quiet on that event.

## Required files

Drop into this folder (`frontend/public/sounds/`):

| File | Triggered when | Suggested vibe |
|---|---|---|
| `lever.mp3` | Player pulls the lever to start a trade | mechanical click / chip handle / lever clack |
| `liftoff.mp3` | Liftoff at end of PREPARE → JUMPING | rocket whoosh / jet ignition |
| `engine.mp3` | LIVE state (loops while flying) | seamless jet engine loop, ~1–2 s, low-mid frequency, looped |
| `engine-stop.mp3` | LIVE → STOPPED (parachute deploy) | engine sputter / shutdown |
| `chute.mp3` | Parachute opens at stop | fabric whoosh / pop |
| `win.mp3` | EOG modal opens with kind="win" | short jingle / cha-ching / fanfare |
| `loss.mp3` | EOG modal opens with kind="loss" | sad trombone / minor sting |
| `rekt.mp3` | Liquidation impact (immediate) | explosion / crash / thud |
| `click.mp3` | Any UI button (deposit, share, continue, menu) | crisp soft click, < 100 ms |
| `coin.mp3` | Share/Download buttons in the EOG modal | coin clink / chip drop |

`.mp3` is preferred for compression; Howler also accepts `.wav`/`.ogg`/`.m4a` if you swap the extension in `lib/sounds.ts` definitions.

## Free CC0 sources (no attribution required)

Best fit overall: **Kenney.nl** — free game audio packs, CC0, designed for games. Each pack is ~50–200 sounds organized by theme.

- **Casino Audio Pack** (https://kenney.nl/assets/casino-audio) — `lever.mp3` (chip drop / handle), `coin.mp3`
- **Sci-Fi Sounds** (https://kenney.nl/assets/sci-fi-sounds) — `liftoff.mp3` (rocket / launch), `engine.mp3` (looping engines), `engine-stop.mp3` (shutdowns)
- **Interface Sounds** (https://kenney.nl/assets/interface-sounds) — `click.mp3`
- **Impact Sounds** (https://kenney.nl/assets/impact-sounds) — `rekt.mp3` (explosion / crash)
- **Jingles** — search Kenney for jingle/positive/negative stings, or freesound.org if Kenney's set doesn't fit

Other CC0 options:
- https://opengameart.org/art-search-advanced (filter by CC0)
- https://pixabay.com/sound-effects/ (royalty-free, free with account)
- https://freesound.org (CC-licensed, attribution often required)

## Rough tuning

Default per-sound volumes are set in `lib/sounds.ts` (`DEFS` object). Engine loop is intentionally low (0.35) since it plays continuously; one-shots are louder. Master volume is 0.8. The mute toggle is in the top bar (🔊 / 🔇 icon next to the help button).

## Adding a new sound

1. Add the file to this folder.
2. Add the id and file definition to `DEFS` in `frontend/lib/sounds.ts`.
3. `sounds.play("your-id")` from anywhere.
