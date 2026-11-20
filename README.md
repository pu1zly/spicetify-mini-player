# Spicetify Mini Player

An always-on-top, draggable mini player extension for Spotify using Chromium's Document Picture-in-Picture capability. It remains visible and fully responsive even while Spotify is minimized.

---

## Capabilities

- **Always Visible**: Floats above all other windows using native Document PiP.
- **Three Layout Modes**:
  - **Standard Mode (360x185)**: Full view featuring album artwork, ambient background glow, live seek bar with timestamps, track/artist details, heart button, playback controls, and volume controls.
    
    <p align="center">
      <img src="assets/standard-mode.png" alt="Standard Mode" />
    </p>

  - **Compact Mode (440x82)**: Streamlined bar with album thumb, title and artist, timeline bar, and playback controls.
    
    <p align="center">
      <img src="assets/compact-mode.png" alt="Compact Mode" />
    </p>

  - **Mini Mode (360x48)**: Ultra-minimal single-line view combining track title and artist with marquee scrolling and controls.
    
    <p align="center">
      <img src="assets/mini-mode.png" alt="Mini Mode" />
    </p>
- **Next Up Display**: Shows upcoming queue items in a top bar by reading the queue directly.
- **Smooth Playback**: Powered by `requestAnimationFrame` for timeline updates without unneeded DOM manipulation.
- **Native Dragging**: Move the player anywhere on screen using header or empty card areas.
- **Fast Access**:
  - Shortcut: `Alt + M` (disabled while typing in inputs)
  - Playbar button next to Spotify queue and lyrics
  - Topbar settings button

---

## Setup & Installation

1. Copy `miniplayer.js` into your Spicetify Extensions directory:
   - **PowerShell (Windows)**:
     ```powershell
     Copy-Item "miniplayer.js" "$env:APPDATA\spicetify\Extensions\miniplayer.js"
     ```
   - **File Explorer / Run Prompt (Windows)**:
     Copy `miniplayer.js` directly to:
     ```text
     %appdata%\spicetify\Extensions\
     ```
     *(or `%userprofile%\.spicetify\Extensions\` depending on your Spicetify installation)*
   - **Linux / macOS**:
     ```bash
     cp miniplayer.js ~/.config/spicetify/Extensions/
     ```
2. Enable the extension and apply:
   ```bash
   spicetify config extensions miniplayer.js
   spicetify apply
   ```

3. Toggle the player anytime in Spotify with `Alt + M` or by clicking the mini player icon in the playbar.

---

## Removal

To disable and remove the extension:
```bash
spicetify config extensions miniplayer.js-
spicetify apply
```

---

## License

This project is released under the terms of the MIT License.
