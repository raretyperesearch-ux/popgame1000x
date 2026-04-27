# Game audio (Kenney CC0 + your own background music)

Sound effects are bundled from [Kenney.nl](https://kenney.nl) audio packs (Creative Commons Zero — public domain, no attribution required, free for commercial use).

The sound system in `frontend/lib/sounds.ts` references each file by name. Swap any of these for your own files (any Howler-supported format: `.ogg`, `.mp3`, `.wav`, `.m4a`) and update the `DEFS` map in `lib/sounds.ts` if you change the extension.

## Bundled sound effects

| File | Triggered when | Source |
|---|---|---|
| `lever.ogg` | Player pulls the lever to start a trade | Kenney Casino · `chips-handle-3` |
| `liftoff.ogg` | Liftoff at PREPARE → JUMPING | Kenney Music Jingles · `Hit/jingles_HIT00` |
| `footstep.ogg` | Each step during RUNNING | Kenney Impact · `footstep_grass_000` |
| `engine.ogg` | (unused — left for swap-back) | Kenney Sci-Fi · `spaceEngineLow_000` |
| `engine-stop.ogg` | (unused — left for swap-back) | Kenney Sci-Fi · `forceField_002` |
| `chute.ogg` | Parachute opens at stop | Kenney Casino · `card-fan-2` |
| `win.ogg` | EOG modal opens with kind="win" | Kenney Music Jingles · `8-Bit/jingles_NES05` |
| `loss.ogg` | EOG modal opens with kind="loss" | Kenney Music Jingles · `8-Bit/jingles_NES00` |
| `rekt.ogg` | Liquidation impact (immediate) | Kenney Sci-Fi · `explosionCrunch_004` |
| `click.ogg` | Any UI button | Kenney Interface · `click_004` |
| `coin.ogg` | Share / Download buttons | Kenney Casino · `chips-collide-1` |

## Background music

`bg-music.ogg` (or `.mp3` — update the extension in `lib/sounds.ts`) plays in a low-volume loop, starting on the first user click anywhere. **Not bundled** — drop in your own track.

### Why no bundled track

Authentic K-pop is copyrighted; CC0 K-pop doesn't really exist. Kenney has zero looping music tracks in any of its packs. So this slot is intentionally empty until you supply something.

### Where to grab a free track

- **[Pixabay Music](https://pixabay.com/music/)** — free for commercial use, no attribution required. Search "kpop", "synth pop", "jpop", "dance pop", "electro pop". Filter by Genre → Pop / Electronic. Click a track → "Free Download" button → you'll get an MP3.
- **[Free Music Archive](https://freemusicarchive.org/)** — CC-licensed (some attribution required, some not — read each track's license). Genre filters help.
- **[ccMixter](https://ccmixter.org/)** — Creative Commons remixes and originals. Lots of attribution-required, some CC0.
- **[Bensound](https://www.bensound.com/)** — free with attribution on the free tier.

### How to add it

1. Download an `.mp3` or `.ogg` file (5 MB or smaller is ideal — gets re-streamed by Howler).
2. Save it to `frontend/public/sounds/bg-music.ogg` (or `.mp3` — if mp3, change `file: "bg-music.ogg"` to `file: "bg-music.mp3"` in `lib/sounds.ts`).
3. Reload — the track auto-starts on the first click anywhere on the page.

### Tuning

Default music volume is `0.22` (in `DEFS["bg-music"]`). The 🔊/🔇 toggle in the topbar mutes everything including music.

## Swapping a sound effect

Want a different vibe for any of the SFX above?

1. Browse the original Kenney packs:
   - [Casino Audio](https://kenney.nl/assets/casino-audio)
   - [Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds)
   - [Interface Sounds](https://kenney.nl/assets/interface-sounds)
   - [Music Jingles](https://kenney.nl/assets/music-jingles) (8-Bit / NES, Pizzicato, Sax, Hit, Steel)
   - [Impact Sounds](https://kenney.nl/assets/impact-sounds)
   - [UI Audio](https://kenney.nl/assets/ui-audio)
2. Replace the file in this folder keeping the same filename, OR
3. Use a different filename and update the path in `frontend/lib/sounds.ts` (`DEFS` map).

## Adding a new sound

1. Drop the file in this folder.
2. Add the id and definition to `DEFS` in `lib/sounds.ts`.
3. Add the id to the `SoundId` union type.
4. `sounds.play("your-id")` from anywhere.
