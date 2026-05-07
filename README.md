# pi-vibe-mode

Pi extension that plays background radio while you work. It keeps music on at a lower cruise volume, then fades up when the Pi agent is running.

## Installed locally

This extension has been installed for this user at:

```sh
~/.pi/agent/extensions/vibe-mode/index.ts
```

Pi auto-discovers extensions in `~/.pi/agent/extensions/`; use `/reload` in Pi or restart Pi after changes.

## Audio dependencies

`pi-vibe-mode` shells out to `mpv` for playback. `mpv` uses `yt-dlp` to resolve YouTube streams, so both binaries need to be available on your `PATH`.

macOS:

```sh
brew install mpv yt-dlp
```

Verify:

```sh
mpv --version
yt-dlp --version
```

## Commands

- `/vibe` toggles background audio on or off.
- `/vibe-restart` restarts `mpv` after installing dependencies or changing audio state.
- `/vibe-next` switches to the next station.
- `/vibe-prev` switches to the previous station.
- `/vibe-status` shows current status and config path.

## Config

Runtime settings persist to:

```sh
~/.pi/agent/vibe-mode.json
```

Edit that file to customize stations or volume. Defaults:

- `enabled`: `false`
- `station`: `house`
- `volume`: `45`
- `idleVolumeRatio`: `0.6`
- `fadeMs`: `1800`
- `preResolve`: `true`
- `prewarm`: `true`

Built-in stations: `house`, `lofi`, `jazz`.
