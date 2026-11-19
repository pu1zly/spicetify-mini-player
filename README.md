# Spicetify Mini Player

An always-on-top, draggable mini player extension for Spotify using Chromium's Document Picture-in-Picture capability. It remains visible and fully responsive even while Spotify is minimized.

---

## Capabilities

- **Always Visible**: Floats above all other windows using native Document PiP.
- **Three Layout Modes**:
  - **Standard Mode (360x185)**: Full view featuring album artwork, ambient background glow, live seek bar with timestamps, track/artist details, heart button, playback controls, and volume controls.
    
    ![Standard Mode](assets/standard-mode.png)

  - **Compact Mode (440x82)**: Streamlined bar with album thumb, title and artist, timeline bar, and playback controls.
    
    ![Compact Mode](assets/compact-mode.png)

  - **Mini Mode (360x48)**: Ultra-minimal single-line view combining track title and artist with marquee scrolling and controls.
- **Next Up Integration**: Automatically pairs with `upcomingSong.js` to display upcoming queue items in a top bar.
- **Smooth Playback**: Powered by `requestAnimationFrame` for timeline updates without unneeded DOM manipulation.
- **Native Dragging**: Move the player anywhere on screen using header or empty card areas.
- **Fast Access**:
  - Shortcut: `Alt + M` (disabled while typing in inputs)
  - Playbar button next to Spotify queue and lyrics
  - Topbar settings button

---

## Setup & Installation

### Option 1: Automatic Script (Windows)

1. Open your terminal or file explorer in the repository directory:
   ```cmd
   cd C:\Users\Floyd\spicetify-miniplayer
   ```
2. Run `install.bat`.
3. Launch Spotify. Toggle the player with `Alt + M` or the playbar icon.

### Option 2: Manual Installation

1. Copy `miniplayer.js` into your Spicetify Extensions directory:
   ```powershell
   Copy-Item "miniplayer.js" "$env:APPDATA\spicetify\Extensions\miniplayer.js"
   ```
2. Register and apply the extension:
   ```cmd
   spicetify config extensions miniplayer.js
   spicetify apply
   ```

---

## Removal

Run `uninstall.bat` or unregister via the command line:
```cmd
spicetify config extensions miniplayer.js-
spicetify apply
```

---

## License

This project is released under the terms of the MIT License.
