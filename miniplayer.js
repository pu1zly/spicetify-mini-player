// @ts-check
// NAME: Spotify Mini Player (Document PiP)
// AUTHOR: Antigravity
// DESCRIPTION: Native borderless always-on-top draggable mini player with fixed cohesive design & marquee

(function MiniPlayer() {
    if (!Spicetify.Player || !Spicetify.Topbar) {
        setTimeout(MiniPlayer, 300);
        return;
    }

    let pipWindow = null;
    let pipWindowFrameWidth = 0;
    let pipWindowFrameHeight = 0;
    let updateInterval = null;
    let rafId = null;
    let isOpening = false;
    let activePiPTimers = new Set();
    let isUserSeeking = false;
    let isAdjustingVolume = false;
    let lastFormattedTime = "";
    let lastSliderValue = -1;
    let lastMarqueeKey = "";
    let upcomingObserver = null;
    // Current layout mode ("standard" | "compact" | "mini") is set up below, after settings load
    let topbarButton = null;

    function cleanupPiPTimers() {
        if (rafId) {
            try { pipWindow?.cancelAnimationFrame(rafId); } catch (e) {}
            try { cancelAnimationFrame(rafId); } catch (e) {}
            rafId = null;
        }
        if (updateInterval) {
            try { pipWindow?.clearInterval(updateInterval); } catch (e) {}
            try { clearInterval(updateInterval); } catch (e) {}
            updateInterval = null;
        }
        for (const id of activePiPTimers) {
            try { pipWindow?.clearTimeout(id); } catch (e) {}
            try { clearTimeout(id); } catch (e) {}
        }
        activePiPTimers.clear();
        if (upcomingObserver) {
            try { upcomingObserver.disconnect(); } catch (e) {}
            upcomingObserver = null;
        }
        isUserSeeking = false;
        isAdjustingVolume = false;
        lastUpcomingKey = null;
        lastFormattedTime = "";
        lastSliderValue = -1;
        lastMarqueeKey = "";
    }

    function safeSetTimeout(fn, ms) {
        if (!pipWindow || pipWindow.closed) return null;
        const id = pipWindow.setTimeout(() => {
            activePiPTimers.delete(id);
            fn();
        }, ms);
        activePiPTimers.add(id);
        return id;
    }

    function safeClearTimeout(id) {
        if (id) {
            activePiPTimers.delete(id);
            try { pipWindow?.clearTimeout(id); } catch (e) {}
            try { clearTimeout(id); } catch (e) {}
        }
    }

    // Remembered window position (shared by both modes so toggling doesn't make the window jump)
    const POS_KEY = "spicetify_miniplayer_position";
    let lastSavedPos = "";
    let positionSaveEnabledAt = 0;

    // Links: current track's album URI (artist URIs live on the rendered artist names)
    let currentAlbumUri = "";

    // ---------- Settings (edited from the topbar gear button) ----------
    const SETTINGS_KEY = "spicetify_miniplayer_settings";
    const DEFAULT_SETTINGS = {
        autoFade: true,          // dim the window when the mouse isn't over it
        idleOpacity: 0.35,       // how visible the content stays while faded (Document PiP windows can't be truly see-through)
        idleDelay: 800,          // ms after the mouse leaves before fading
        rememberPosition: true,  // reopen where you left it
        scrollAdjust: true,      // wheel = volume, wheel over timeline = seek
        seekStep: 5,             // seconds per scroll notch
        volumeStep: 5,           // percent per scroll notch
        clickToOpen: true,       // click title/artist to open album/artist page
        showUpcoming: true,      // "Next up" bar (needs upcomingSong.js)
        modes: { standard: true, compact: true, mini: true }  // which modes you can switch between
    };

    const clampNum = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };

    function cloneDefaultSettings() {
        return {
            ...DEFAULT_SETTINGS,
            modes: { ...DEFAULT_SETTINGS.modes }
        };
    }

    function loadSettings() {
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
        } catch (e) {}
        const s = {
            ...cloneDefaultSettings(),
            ...saved
        };
        s.idleOpacity = clampNum(s.idleOpacity, 0.05, 0.9, DEFAULT_SETTINGS.idleOpacity);
        s.idleDelay = clampNum(s.idleDelay, 200, 5000, DEFAULT_SETTINGS.idleDelay);
        s.seekStep = clampNum(s.seekStep, 1, 30, DEFAULT_SETTINGS.seekStep);
        s.volumeStep = clampNum(s.volumeStep, 1, 20, DEFAULT_SETTINGS.volumeStep);
        ["autoFade", "rememberPosition", "scrollAdjust", "clickToOpen", "showUpcoming"].forEach(k => { s[k] = !!s[k]; });
        const savedModes = (saved && typeof saved.modes === "object" && saved.modes) || {};
        s.modes = {
            standard: savedModes.standard !== false,
            compact: savedModes.compact !== false,
            mini: savedModes.mini !== false
        };
        if (!s.modes.standard && !s.modes.compact && !s.modes.mini) {
            s.modes = { standard: true, compact: true, mini: true };
        }
        return s;
    }

    let settings = loadSettings();

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {}
    }

    // ---------- Modes ----------
    const MODES = ["standard", "compact", "mini"];
    const MODE_LABELS = { standard: "Standard", compact: "Compact", mini: "Mini" };
    const MODE_KEY = "spicetify_miniplayer_mode";

    // Modes the user has left enabled in settings (always at least one)
    function enabledModes() {
        const list = MODES.filter(m => settings.modes[m]);
        return list.length ? list : MODES.slice();
    }

    // The mode a click on the cover / mode button switches to (skips disabled modes).
    // Returns `from` itself when there's nothing else to switch to.
    function nextMode(from = currentMode) {
        const list = enabledModes();
        const idx = MODES.indexOf(from);
        for (let i = 1; i <= MODES.length; i++) {
            const cand = MODES[(idx + i) % MODES.length];
            if (list.includes(cand)) return cand;
        }
        return from;
    }

    function loadMode() {
        let m = localStorage.getItem(MODE_KEY);
        if (!MODES.includes(m)) {
            // Older versions only knew compact on/off
            m = localStorage.getItem("spicetify_miniplayer_compact") === "true" ? "compact" : "standard";
        }
        const list = enabledModes();
        return list.includes(m) ? m : list[0];
    }

    let currentMode = loadMode();

    // "Next up" bar state (driven by the upcomingSong.js extension, if installed)
    let upcomingBarEnabled = false;
    let lastUpcomingKey = null;

    // Fixed Dimensions: strictly locked to prevent expansion/stretching
    const STANDARD_WIDTH = 360;
    const STANDARD_HEIGHT = 185;
    const COMPACT_WIDTH = 440;
    const COMPACT_HEIGHT = 82;
    // Mini mode: title + controls only
    const MINI_WIDTH = 360;
    const MINI_HEIGHT = 48;
    // Extra strip above the card for the "Next up" bar (only added when upcomingSong.js is present)
    const UPCOMING_BAR_HEIGHT = 26;

    // SVG Icons
    const ICONS = {
        mini: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M1.5 5h13A1.5 1.5 0 0 1 16 6.5v3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 9.5v-3A1.5 1.5 0 0 1 1.5 5zm0 1.5a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V7a.5.5 0 0 0-.5-.5h-13z"/></svg>`,
        gear: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path fill-rule="evenodd" d="M8 3.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zM8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(45 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(90 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(135 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(180 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(225 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(270 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(315 8 8)"/></svg>`,
        miniplayer: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h10"/><rect width="20" height="14" x="2" y="3" rx="2"/></svg>`,
        play: `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"/></svg>`,
        pause: `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"/></svg>`,
        prev: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.576a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z"/></svg>`,
        next: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.106A.7.7 0 0 0 1 1.712v12.576a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z"/></svg>`,
        shuffle: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c.9 0 1.745.405 2.308 1.077l1.724 2.056-.99.832L1.936 4.195A2.25 2.25 0 0 0 .39 3.5zm12.76 7.422a.75.75 0 0 1 1.06 1.06L11.39 14.805a.75.75 0 0 1-1.06-1.06l1.439-1.439h-1.61a3.75 3.75 0 0 1-2.872-1.34l-1.724-2.056.99-.832 1.498 1.787a2.25 2.25 0 0 0 1.724.805h1.948l-1.439-1.44z"/></svg>`,
        repeat: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z"/></svg>`,
        heartOutline: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65 4.651 4.651 0 0 1-1.011 3.84L8 15.011l-6.65-6.702A4.65 4.65 0 0 1 .337 4.469 4.614 4.614 0 0 1 1.69 2zm1.062 1.06a3.118 3.118 0 0 0-.916 2.235c0 .828.333 1.62.923 2.215L8 12.784l5.24-5.275c.59-.594.923-1.386.923-2.214 0-.828-.332-1.62-.916-2.233a3.127 3.127 0 0 0-2.21-.914 3.12 3.12 0 0 0-2.215.92L8 4.02l-.822-.952a3.125 3.125 0 0 0-2.215-.92c-.83 0-1.623.332-2.211.913z"/></svg>`,
        heartFilled: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#1db954"><path d="M15.724 4.22A4.313 4.313 0 0 0 12.192.814a4.269 4.269 0 0 0-3.622 1.13.837.837 0 0 1-1.14 0 4.272 4.272 0 0 0-6.21 1.187A4.312 4.312 0 0 0 .416 6.786a4.368 4.368 0 0 0 1.067 2.973l6.064 6.136a.65.65 0 0 0 .918 0l6.07-6.141a4.368 4.368 0 0 0 1.067-2.973 4.312 4.312 0 0 0 .122-2.561z"/></svg>`,
        volumeHigh: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4H0V4.85h2.066l6.925-4a.75.75 0 0 1 .75 0zM11.5 5.5a.75.75 0 0 1 .75-.75 4.5 4.5 0 0 1 0 6.5.75.75 0 1 1-1.06-1.06 3 3 0 0 0 0-4.38.75.75 0 0 1 .31-.31zm2.5-2.5a.75.75 0 0 1 .75-.75 8 8 0 0 1 0 11.5.75.75 0 1 1-1.06-1.06 6.5 6.5 0 0 0 0-9.38.75.75 0 0 1 .31-.31z"/></svg>`,
        volumeMute: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06zM9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4H0V4.85h2.066l6.925-4a.75.75 0 0 1 .75 0z"/></svg>`,
        compact: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M1.5 1h13A1.5 1.5 0 0 1 16 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 13.5v-11A1.5 1.5 0 0 1 1.5 1zm0 1.5a.5.5 0 0 0-.5.5v2h14V3a.5.5 0 0 0-.5-.5h-13zM15 6H1v7.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V6z"/></svg>`,
        expand: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M2.5 1A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 13.5 1h-11zm0 1.5h11a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"/></svg>`,
        close: `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854z"/></svg>`
    };

    // The icon shown for each mode (the cover / mode button shows the mode you'd switch TO)
    const MODE_ICONS = { standard: ICONS.expand, compact: ICONS.compact, mini: ICONS.mini };

    // Pushes current settings into an open mini player window
    function applySettings() {
        if (!pipWindow || pipWindow.closed) return;
        const doc = pipWindow.document;
        doc.documentElement.style.setProperty("--idle-opacity", String(settings.idleOpacity));
        doc.body.classList.toggle("links-off", !settings.clickToOpen);
        if (!settings.autoFade) doc.body.classList.remove("idle");
        refreshModeUi();
    }

    // Updates the cover's hover icon, the Mini-mode button and their tooltips for the next mode
    function refreshModeUi() {
        if (!pipWindow || pipWindow.closed) return;
        const doc = pipWindow.document;
        const next = nextMode();
        // Only one usable mode: nothing to switch to, so hide the switch affordances
        doc.body.classList.toggle("single-mode", next === currentMode);
        const tip = `Switch to ${MODE_LABELS[next]} mode`;
        const modeIcon = doc.getElementById("cover-mode-icon");
        if (modeIcon) modeIcon.innerHTML = MODE_ICONS[next];
        const miniBtn = doc.getElementById("btn-mode-mini");
        if (miniBtn) {
            miniBtn.innerHTML = MODE_ICONS[next];
            miniBtn.setAttribute("title", tip);
        }
        doc.querySelector(".cover-container")?.setAttribute("title", tip);
    }

    // The next-up strip needs both the setting and upcomingSong.js to be present
    function shouldShowUpcoming() {
        return settings.showUpcoming && isUpcomingAvailable();
    }

    // Settings panel (opened by the topbar gear button)
    function openSettings() {
        if (!Spicetify.PopupModal) {
            Spicetify.showNotification("Settings aren't available in this Spotify build.", true);
            return;
        }

        const h = (tag, cls, text) => {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (text !== undefined) e.textContent = text;
            return e;
        };

        const root = h("div", "mp-settings");
        const style = document.createElement("style");
        style.textContent = `
            /* Panel: a scrolling body plus a footer that stays put. Sized and stretched by fitModal(). */
            .mp-settings {
                display: flex;
                flex-direction: column;
                box-sizing: border-box;
                width: min(440px, 100%);
                height: min(460px, 62vh);
                padding-bottom: 20px;
                overflow: hidden;
                color: #fff;
                font-family: inherit;
                font-size: 14px;
            }
            .mp-scroll {
                flex: 1 1 auto;
                min-height: 0;
                overflow-x: hidden;
                overflow-y: auto;
                scrollbar-gutter: stable; /* keep room for the scrollbar so nothing shifts when it appears */
                padding: 0 var(--mp-pad-rs, 6px) 8px var(--mp-pad-l, 0px);
            }
            /* Spotify-style scrollbar: slim rounded pill, no arrows, only visible while hovering the panel */
            .mp-scroll::-webkit-scrollbar { width: 14px; }
            .mp-scroll::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
            .mp-scroll::-webkit-scrollbar-corner { background: transparent; }
            .mp-scroll::-webkit-scrollbar-track { background: transparent; }
            .mp-scroll::-webkit-scrollbar-thumb {
                min-height: 40px;
                background-color: rgba(255, 255, 255, 0);
                border: 4px solid transparent;
                border-radius: 999px;
                background-clip: padding-box;
                transition: background-color 0.15s ease;
            }
            .mp-scroll:hover::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.3); }
            .mp-scroll::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.55); }
            .mp-scroll::-webkit-scrollbar-thumb:active { background-color: rgba(255, 255, 255, 0.75); }
            /* Sections are bold headings; rows sit together in soft rounded groups */
            .mp-section { margin: 22px 0 8px; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; color: #fff; }
            .mp-section:first-child { margin-top: 4px; }
            .mp-group { padding: 2px 16px; border-radius: 8px; background: rgba(255, 255, 255, 0.04); }
            .mp-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 0; }
            .mp-row + .mp-row { border-top: 1px solid rgba(255, 255, 255, 0.06); }
            .mp-text { min-width: 0; flex: 1; }
            .mp-label { font-size: 14px; font-weight: 500; color: #fff; }
            .mp-desc { margin-top: 3px; font-size: 12px; line-height: 1.4; color: #a7a7a7; }
            /* Toggle switch */
            .mp-switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
            .mp-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
            .mp-knob { position: absolute; inset: 0; border-radius: 11px; background: #6a6a6a; transition: background 0.15s ease; }
            .mp-switch:hover .mp-knob { background: #7f7f7f; }
            .mp-knob::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); transition: transform 0.15s ease; }
            .mp-switch input:checked + .mp-knob { background: #1ed760; }
            .mp-switch:hover input:checked + .mp-knob { background: #3be477; }
            .mp-switch input:checked + .mp-knob::after { transform: translateX(16px); }
            /* Slider: thin white track that turns green on hover, thumb appears on hover (like Spotify's player bar) */
            .mp-range { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
            .mp-range input {
                -webkit-appearance: none; appearance: none;
                width: 140px; height: 20px; margin: 0; padding: 0;
                background: transparent; outline: none; cursor: pointer;
                --p: 0; --thumb: 12px;
                --stop: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--p));
            }
            .mp-range input::-webkit-slider-runnable-track {
                height: 4px; border-radius: 2px;
                background: linear-gradient(to right, #fff var(--stop), rgba(255, 255, 255, 0.3) var(--stop));
            }
            .mp-range input:hover::-webkit-slider-runnable-track {
                background: linear-gradient(to right, #1ed760 var(--stop), rgba(255, 255, 255, 0.3) var(--stop));
            }
            .mp-range input::-webkit-slider-thumb {
                -webkit-appearance: none; appearance: none;
                width: var(--thumb); height: var(--thumb); border-radius: 50%;
                background: #fff; margin-top: -4px; opacity: 0;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
                transition: opacity 0.1s ease;
            }
            .mp-range input:hover::-webkit-slider-thumb,
            .mp-range input:active::-webkit-slider-thumb { opacity: 1; }
            .mp-value { min-width: 38px; text-align: right; font-size: 12px; color: #a7a7a7; font-variant-numeric: tabular-nums; }
            .mp-inline { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
            /* Pill buttons, Spotify style: outlined secondary, solid white primary */
            .mp-btn { font: inherit; font-size: 13px; font-weight: 700; padding: 9px 22px; border-radius: 999px; border: 1px solid #727272; background: transparent; color: #fff; cursor: pointer; transition: border-color 0.15s ease, transform 0.1s ease; }
            .mp-btn:hover { border-color: #fff; transform: scale(1.04); }
            .mp-btn:active { transform: scale(0.98); border-color: #b3b3b3; }
            .mp-btn.primary { background: #fff; border-color: #fff; color: #000; }
            .mp-btn.primary:active { background: #e6e6e6; border-color: #e6e6e6; }
            .mp-btn.small { padding: 5px 14px; font-size: 12px; }
            /* Footer stays pinned under the scrolling body, with room above and below the buttons */
            .mp-footer { flex: 0 0 auto; display: flex; justify-content: flex-end; align-items: center; gap: 12px; margin-top: 4px; padding: 18px var(--mp-pad-r, 0px) 0 var(--mp-pad-l, 0px); border-top: 1px solid rgba(255, 255, 255, 0.08); }
            /* Mode chips: Spotify filter-chip look (green when on) */
            .mp-chips { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
            .mp-chip { font: inherit; font-size: 12px; font-weight: 500; min-width: 96px; padding: 7px 14px; text-align: center; border-radius: 999px; border: none; background: #2a2a2a; color: #fff; cursor: pointer; transition: background 0.15s ease; }
            .mp-chip:hover { background: #3a3a3a; }
            .mp-chip.on { background: #1ed760; color: #000; font-weight: 700; }
            .mp-chip.on:hover { background: #3be477; }
        `;
        root.appendChild(style);

        // Layout: a scrolling body (rows grouped under section headings) + a footer that stays put
        const scroll = h("div", "mp-scroll");
        root.appendChild(scroll);
        let group = scroll;

        const update = (key, value) => {
            settings[key] = value;
            saveSettings();
            applySettings();
        };
        const section = (title) => {
            scroll.appendChild(h("div", "mp-section", title));
            group = h("div", "mp-group");
            scroll.appendChild(group);
        };
        const row = (label, desc, control) => {
            const r = h("div", "mp-row");
            const left = h("div", "mp-text");
            left.appendChild(h("div", "mp-label", label));
            if (desc) left.appendChild(h("div", "mp-desc", desc));
            r.appendChild(left);
            r.appendChild(control);
            group.appendChild(r);
        };
        const toggle = (key) => {
            const wrap = h("label", "mp-switch");
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !!settings[key];
            input.addEventListener("change", () => update(key, input.checked));
            wrap.appendChild(input);
            wrap.appendChild(h("span", "mp-knob"));
            return wrap;
        };
        // toUi/fromUi convert between the stored value and the slider's own units
        const slider = (key, min, max, step, toUi, fromUi, fmt) => {
            const wrap = h("div", "mp-range");
            const input = document.createElement("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            // --p drives the slider's fill
            const setFill = () => input.style.setProperty("--p", String((parseFloat(input.value) - min) / (max - min)));
            input.value = String(toUi(settings[key]));
            setFill();
            const out = h("span", "mp-value", fmt(toUi(settings[key])));
            input.addEventListener("input", () => {
                const ui = parseFloat(input.value);
                out.textContent = fmt(ui);
                setFill();
                update(key, fromUi(ui));
            });
            wrap.appendChild(input);
            wrap.appendChild(out);
            return wrap;
        };

        // Chips for choosing which modes are available (at least one must stay on)
        const modeChips = () => {
            const wrap = h("div", "mp-chips");
            MODES.forEach(m => {
                const chip = h("button", "mp-chip" + (settings.modes[m] ? " on" : ""), MODE_LABELS[m]);
                chip.addEventListener("click", () => {
                    const next = { ...settings.modes, [m]: !settings.modes[m] };
                    if (!MODES.some(k => next[k])) {
                        Spicetify.showNotification("Keep at least one mode enabled.", true);
                        return;
                    }
                    settings.modes = next;
                    saveSettings();
                    applySettings();
                    chip.classList.toggle("on", next[m]);
                });
                wrap.appendChild(chip);
            });
            return wrap;
        };

        section("Modes");
        row("Available modes",
            "Choose which modes you can switch between: one, two or all three. Click the album art (or the mode button in Mini) to cycle.",
            modeChips());

        section("Window");
        row("Auto-fade when idle", "Dim the mini player while the mouse isn't over it.", toggle("autoFade"));
        row("Fade amount", "How visible the content stays while faded. Lower is more see-through.",
            slider("idleOpacity", 5, 90, 5, v => Math.round(v * 100), v => v / 100, v => `${v}%`));
        row("Fade delay", "How long after the mouse leaves before it fades.",
            slider("idleDelay", 2, 50, 1, v => Math.round(v / 100), v => v * 100, v => `${(v / 10).toFixed(1)}s`));

        const resetPos = h("button", "mp-btn small", "Reset");
        resetPos.addEventListener("click", () => {
            try { localStorage.removeItem(POS_KEY); } catch (e) {}
            // Don't immediately re-save the current spot while the window is open
            lastSavedPos = (pipWindow && !pipWindow.closed) ? `${pipWindow.screenX},${pipWindow.screenY}` : "";
            Spicetify.showNotification("Saved window position cleared");
        });
        const posControls = h("div", "mp-inline");
        posControls.appendChild(resetPos);
        posControls.appendChild(toggle("rememberPosition"));
        row("Remember window position", "Reopen the mini player where you left it.", posControls);

        section("Controls");
        row("Scroll to adjust", "Scroll over the timeline to seek, anywhere else to change volume.", toggle("scrollAdjust"));
        row("Seek step", "Seconds per scroll notch over the timeline.",
            slider("seekStep", 1, 30, 1, v => v, v => v, v => `${v}s`));
        row("Volume step", "Percent per scroll notch.",
            slider("volumeStep", 1, 20, 1, v => v, v => v, v => `${v}%`));
        row("Click title / artist to open", "Opens the album or artist page in Spotify.", toggle("clickToOpen"));

        section("Next up");
        row("Show next-up bar",
            (isUpcomingAvailable()
                ? "upcomingSong.js detected."
                : "upcomingSong.js wasn't found, so there's nothing to show.")
            + " Applies the next time you open the mini player or switch modes.",
            toggle("showUpcoming"));

        const footer = h("div", "mp-footer");
        const isOpen = !!(pipWindow && !pipWindow.closed);
        const toggleBtn = h("button", "mp-btn primary", isOpen ? "Close mini player" : "Open mini player");
        toggleBtn.addEventListener("click", () => {
            toggleMiniPlayer();
            Spicetify.PopupModal.hide();
        });
        const resetAll = h("button", "mp-btn", "Reset to defaults");
        resetAll.addEventListener("click", () => {
            settings = cloneDefaultSettings();
            saveSettings();
            applySettings();
            Spicetify.PopupModal.hide();
            setTimeout(openSettings, 60);
        });
        // Secondary action on the left, primary on the right (Spotify's usual order)
        footer.appendChild(resetAll);
        footer.appendChild(toggleBtn);
        root.appendChild(footer);

        Spicetify.PopupModal.display({ title: "Mini Player Settings", content: root });

        // The modal wraps our content in its own padded, scrolling container, which caused a second
        // scrollbar, an inset scrollbar and a clipped footer. Once it's on screen, take over that
        // wrapper: stop it scrolling, stretch the panel edge-to-edge so the scrollbar sits on the modal's
        // side, and size the panel to the space the modal actually has so the footer buttons stay reachable.
        // Thin gray border (plus a soft shadow) around the whole modal card
        const styleModalCard = () => {
            let card = null;
            for (let p = root.parentElement, i = 0; p && p !== document.body && i < 12; p = p.parentElement, i++) {
                const r = p.getBoundingClientRect();
                // Stop at the full-screen overlay; the card is the outermost rounded element below it
                if (r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95) break;
                if (parseFloat(getComputedStyle(p).borderTopLeftRadius) > 0) card = p;
            }
            if (card) card.style.boxShadow = "0 0 0 1px rgba(255, 255, 255, 0.14), 0 24px 64px rgba(0, 0, 0, 0.55)";
        };

        let scroller = null;
        const fitModal = () => {
            if (!root.isConnected) return false;
            root.style.cssText = "";

            if (!scroller) {
                for (let p = root.parentElement, i = 0; p && p !== document.body && i < 6; p = p.parentElement, i++) {
                    const oy = getComputedStyle(p).overflowY;
                    if (oy === "auto" || oy === "scroll") { scroller = p; break; }
                }
            }
            const holder = scroller || root.parentElement;
            if (!holder) return false;
            const hcs = getComputedStyle(holder);

            // Space the modal really gives us (measured while its wrapper is still constrained)
            const availH = holder.clientHeight - parseFloat(hcs.paddingTop || "0") - parseFloat(hcs.paddingBottom || "0");
            if (scroller) scroller.style.overflow = "hidden";

            // Stretch edge-to-edge across the wrapper's padding box
            root.style.width = "100%";
            const hr = holder.getBoundingClientRect();
            const rr = root.getBoundingClientRect();
            const padLeft = hr.left + holder.clientLeft;
            const padRight = padLeft + holder.clientWidth;
            const left = Math.max(0, rr.left - padLeft);
            const right = Math.max(0, padRight - rr.right);
            root.style.width = `calc(100% + ${left + right}px)`;
            root.style.marginLeft = `-${left}px`;
            // Inner padding is applied by the body/footer (not the root) so the scrollbar can sit on the modal's edge
            root.style.setProperty("--mp-pad-l", `${left}px`);
            root.style.setProperty("--mp-pad-r", `${right}px`);
            root.style.setProperty("--mp-pad-rs", `${Math.max(0, right - 14)}px`);

            const h = Math.max(240, Math.min(460, availH > 0 ? availH : 460, window.innerHeight * 0.62));
            root.style.height = `${h}px`;
            styleModalCard();
            return true;
        };
        let tries = 0;
        const fitTimer = setInterval(() => {
            tries++;
            if (fitModal()) {
                clearInterval(fitTimer);
                setTimeout(fitModal, 250); // re-fit once the modal's own layout has settled
            } else if (tries > 40) {
                clearInterval(fitTimer);
            }
        }, 50);
    }

    function formatTime(ms) {
        if (!ms || isNaN(ms) || ms < 0) return "0:00";
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}:${sec < 10 ? "0" : ""}${sec}`;
    }

    function getTrackMetadata() {
        const item = Spicetify.Player.data?.item;
        if (!item) {
            return {
                title: "No track playing",
                artist: "Spotify",
                album: "",
                albumUri: "",
                artistList: [],
                cover: "https://open.spotifycdn.com/cdn/images/equaliser-animated-green.f9eb22af.gif",
                duration: 0
            };
        }

        const title = item.name || item.metadata?.title || "Unknown Title";
        // Artists as {name, uri} so each name can link to its own artist page
        const artistList = [];
        if (item.artists && item.artists.length) {
            item.artists.forEach(a => artistList.push({ name: a.name, uri: a.uri || "" }));
        } else if (item.metadata?.artist_name) {
            for (let i = 0; ; i++) {
                const name = item.metadata[i === 0 ? "artist_name" : `artist_name:${i}`];
                if (!name) break;
                artistList.push({ name, uri: item.metadata[i === 0 ? "artist_uri" : `artist_uri:${i}`] || "" });
            }
        }
        const artists = artistList.length ? artistList.map(a => a.name).join(", ") : "Unknown Artist";
        const album = item.album?.name || item.metadata?.album_title || "";
        const cover = item.metadata?.image_xlarge_url || item.metadata?.image_large_url || item.metadata?.image_url || (item.images && item.images[0]?.url) || "";

        return {
            title,
            artist: artists,
            album,
            albumUri: item.album?.uri || item.metadata?.album_uri || "",
            artistList,
            cover,
            duration: Spicetify.Player.getDuration() || (item.duration?.milliseconds || 0)
        };
    }

    // Window size for the current mode, including the "Next up" strip when enabled.
    // The strip is only (re)evaluated on open / mode switch, because Document PiP windows
    // can only be resized from a user gesture, not on every track change.
    function getTargetSize() {
        const SIZES = {
            standard: { width: STANDARD_WIDTH, height: STANDARD_HEIGHT },
            compact: { width: COMPACT_WIDTH, height: COMPACT_HEIGHT },
            mini: { width: MINI_WIDTH, height: MINI_HEIGHT }
        };
        return {
            width: SIZES[currentMode].width,
            height: SIZES[currentMode].height + (upcomingBarEnabled ? UPCOMING_BAR_HEIGHT : 0)
        };
    }

    // upcomingSong.js injects #upcomingSongDiv into Spotify's now-playing bar. If it isn't there,
    // the extension isn't installed/loaded and the mini player just doesn't show the bar.
    function isUpcomingAvailable() {
        return !!document.getElementById("upcomingSongDiv");
    }

    // Reads what upcomingSong.js is currently showing so both always agree on what's next.
    function readUpcomingFromExtension() {
        const titleEl = document.getElementById("upcomingSongTitle");
        if (!titleEl) return null;
        const title = (titleEl.textContent || "").trim();
        // The extension uses this sentinel when the queue has no next track
        if (!title || title === "NoSongWasFound") return { title: "", artist: "" };
        const artist = (document.getElementById("upcomingSongArtist")?.textContent || "").trim();
        return { title, artist };
    }

    function updateUpcomingBar() {
        if (!pipWindow || pipWindow.closed || !upcomingBarEnabled) return;
        const info = readUpcomingFromExtension();
        const title = info?.title || "";
        const artist = info?.artist || "";
        const key = `${title}\u0000${artist}`;
        if (key === lastUpcomingKey) return;
        lastUpcomingKey = key;

        const doc = pipWindow.document;
        const bar = doc.getElementById("upcoming-bar");
        const text = doc.getElementById("upcoming-text");
        const titleEl = doc.getElementById("upcoming-title");
        const artistEl = doc.getElementById("upcoming-artist");
        if (!bar || !text || !titleEl || !artistEl) return;

        if (title) {
            titleEl.textContent = title;
            artistEl.textContent = artist ? ` \u00b7 ${artist}` : "";
            bar.classList.remove("empty");
            bar.title = `Next up: ${title}${artist ? ` \u2014 ${artist}` : ""}`;
        } else {
            titleEl.textContent = "Nothing up next";
            artistEl.textContent = "";
            bar.classList.add("empty");
            bar.title = "";
        }

        // Little fade-in so changes don't just pop
        text.classList.remove("flash");
        void text.offsetWidth;
        text.classList.add("flash");
    }

    function setupUpcomingObserver() {
        if (upcomingObserver) {
            upcomingObserver.disconnect();
            upcomingObserver = null;
        }
        if (!upcomingBarEnabled) return;
        const target = document.getElementById("upcomingSongDiv") || document.querySelector(".main-nowPlayingBar-left");
        if (target) {
            upcomingObserver = new MutationObserver(() => {
                if (pipWindow && !pipWindow.closed && upcomingBarEnabled) {
                    updateUpcomingBar();
                }
            });
            upcomingObserver.observe(target, { childList: true, subtree: true, characterData: true });
        }
    }

    // Opens an album/artist page in the main Spotify window
    function openInSpotify(uri) {
        const m = /^spotify:(album|artist|playlist|show|episode|track):([A-Za-z0-9]+)/.exec(uri || "");
        if (!m) return;
        try {
            Spicetify.Platform.History.push(`/${m[1]}/${m[2]}`);
            window.focus();
        } catch (err) {
            console.warn("[MiniPlayer] Could not open page in Spotify:", err);
        }
    }

    function restoreWindowPosition() {
        if (!pipWindow || !settings.rememberPosition) return;
        try {
            const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
            if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
            pipWindow.moveTo(saved.x, saved.y);
            lastSavedPos = `${saved.x},${saved.y}`;
        } catch (err) {
            console.warn("[MiniPlayer] Could not restore window position:", err);
        }
    }

    function saveWindowPosition() {
        if (!pipWindow || pipWindow.closed || !settings.rememberPosition) return;
        // Skip the first second after opening so a transient default position never overwrites the saved one
        if (Date.now() < positionSaveEnabledAt) return;
        const x = pipWindow.screenX;
        const y = pipWindow.screenY;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const key = `${x},${y}`;
        if (key === lastSavedPos) return;
        lastSavedPos = key;
        try {
            localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
        } catch (err) {}
    }

    // Opens or brings to focus the Document PiP Window
    async function openMiniPlayer() {
        if (isOpening) return;
        if (pipWindow && !pipWindow.closed) {
            try { pipWindow.focus?.(); } catch (e) {}
            return;
        }

        if (!("documentPictureInPicture" in window)) {
            Spicetify.showNotification("Document Picture-in-Picture is not supported in this client build.", true);
            return;
        }

        isOpening = true;
        cleanupPiPTimers();

        try {
            upcomingBarEnabled = shouldShowUpcoming();
            const { width, height } = getTargetSize();

            // Request floating document PiP window
            // @ts-ignore
            pipWindow = await window.documentPictureInPicture.requestWindow({
                width,
                height
            });
            pipWindowFrameWidth = pipWindow.outerWidth - pipWindow.innerWidth;
            pipWindowFrameHeight = pipWindow.outerHeight - pipWindow.innerHeight;

            restoreWindowPosition();
            positionSaveEnabledAt = Date.now() + 1000;

            pipWindow.document.title = "Spotify Mini Player";

            // Inject Custom Styles
            const style = pipWindow.document.createElement("style");
            style.textContent = getMiniPlayerStyles();
            pipWindow.document.head.appendChild(style);

            // Inject DOM
            pipWindow.document.body.innerHTML = getMiniPlayerHTML();
            applySettings();

            // Set Initial State
            renderFullUI();

            setupUpcomingObserver();

            // Bind Event Listeners
            bindMiniPlayerEvents();

            // Recalculate text overflow/marquee on window resize without illegal resizeTo() calls
            pipWindow.addEventListener("resize", () => {
                updateMarqueeEffect(true);
            });

            // Smooth requestAnimationFrame loop for active visual progress updates
            startProgressLoop();

            // Slower background timer (every 2.5s) for position saving, upcoming sync, and idle checks
            updateInterval = pipWindow.setInterval(slowBackgroundTick, 2500);

            // Handle PiP Window Close
            pipWindow.addEventListener("pagehide", () => {
                saveWindowPosition();
                cleanupPiPTimers();
                pipWindow = null;
                updateButtonStates(false);
            });

            updateButtonStates(true);
        } catch (err) {
            console.error("[MiniPlayer] Failed to open Document PiP window:", err);
            Spicetify.showNotification("Failed to open Mini Player window.", true);
            cleanupPiPTimers();
            pipWindow = null;
            updateButtonStates(false);
        } finally {
            isOpening = false;
        }
    }

    function closeMiniPlayer() {
        cleanupPiPTimers();
        if (pipWindow && !pipWindow.closed) {
            try { pipWindow.close(); } catch (e) {}
        }
        pipWindow = null;
        updateButtonStates(false);
    }

    function toggleMiniPlayer() {
        if (isOpening) return;
        if (pipWindow && !pipWindow.closed) {
            closeMiniPlayer();
        } else {
            openMiniPlayer();
        }
    }

    function updateButtonStates(isActive) {
        const domPlaybarBtn = document.getElementById("miniplayer-playbar-btn");
        if (domPlaybarBtn) {
            domPlaybarBtn.style.color = isActive ? "#1db954" : "#b3b3b3";
        }
    }

    function getMiniPlayerStyles() {
        return `
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
                user-select: none;
                -webkit-user-select: none;
            }
            html, body {
                width: 100vw;
                height: 100vh;
                margin: 0;
                padding: 0;
                overflow: hidden;
                background: #121212;
                color: #ffffff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            body {
                flex-direction: column;
            }
            /* With the next-up strip, pin it to the very top and centre the card in the remaining space,
               so any spare window height never shows up as an empty bar above the strip */
            body.has-upcoming {
                justify-content: flex-start;
            }
            body.has-upcoming .miniplayer-card {
                margin-top: auto;
                margin-bottom: auto;
            }
            /* "Next up" strip above the card (from upcomingSong.js). Hidden unless enabled. */
            .upcoming-bar {
                display: none;
                position: relative;
                z-index: 1;
                flex: 0 0 ${UPCOMING_BAR_HEIGHT}px;
                height: ${UPCOMING_BAR_HEIGHT}px;
                width: 100%;
                align-items: center;
                gap: 10px;
                /* Same padding in both modes: extra room on top so the text isn't hugging the edge */
                padding: 4px 12px 1px;
                background: rgba(255, 255, 255, 0.05);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                overflow: hidden;
                /* Native window drag: hold the strip anywhere to move the player (this never resizes it) */
                -webkit-app-region: drag;
                cursor: grab;
            }
            body.has-upcoming .upcoming-bar {
                display: flex;
            }
            .upcoming-label {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                flex-shrink: 0;
                color: #1ed760;
                font-size: 9px;
                font-weight: 700;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                line-height: 1;
            }
            .upcoming-dot {
                width: 4px;
                height: 4px;
                border-radius: 50%;
                background: #1ed760;
                box-shadow: 0 0 5px #1ed760;
            }
            .upcoming-text {
                display: block;
                flex: 1 1 auto;
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                font-size: 10.5px;
                line-height: 1.2;
            }
            .upcoming-title {
                color: #ffffff;
                font-weight: 600;
            }
            .upcoming-artist {
                color: #b3b3b3;
                font-weight: 500;
            }
            .upcoming-bar.empty .upcoming-title {
                color: #7a7a7a;
                font-weight: 500;
            }
            .upcoming-text.flash {
                animation: upcoming-fade 0.25s ease;
            }
            @keyframes upcoming-fade {
                from { opacity: 0; transform: translateY(3px); }
                to { opacity: 1; transform: none; }
            }
            /* Auto-fade: dim everything when the mouse isn't over the window */
            .miniplayer-card, .upcoming-bar {
                transition: opacity 0.35s ease;
            }
            body.idle .miniplayer-card,
            body.idle .upcoming-bar {
                opacity: var(--idle-opacity, 0.35);
            }
            /* Ghost effect: the content fades hard, but the blurred cover-art backdrop stays visible,
               so the window reads as a faint tinted pane rather than just going dark */
            body.idle #ambient-bg {
                opacity: max(var(--idle-opacity, 0.35), 0.5);
            }
            /* Ambient dynamic background */
            #ambient-bg {
                position: absolute;
                inset: -20px;
                background-size: cover;
                background-position: center;
                filter: blur(40px) brightness(0.24);
                opacity: 0.9;
                z-index: 0;
                transition: background-image 0.5s ease, opacity 0.35s ease;
                pointer-events: none;
            }
            /* Locked Fixed-Size Card: NEVER expands or stretches when window edges are touched */
            .miniplayer-card {
                position: relative;
                z-index: 1;
                width: ${STANDARD_WIDTH}px;
                height: ${STANDARD_HEIGHT}px;
                max-width: ${STANDARD_WIDTH}px;
                max-height: ${STANDARD_HEIGHT}px;
                min-width: ${STANDARD_WIDTH}px;
                min-height: ${STANDARD_HEIGHT}px;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                padding: 10px 14px 12px 14px;
                box-sizing: border-box;
                /* Native CEF window drag */
                -webkit-app-region: drag;
                cursor: grab;
                overflow: hidden;
            }
            .miniplayer-card:active {
                cursor: grabbing;
            }
            /* Interactive elements are non-draggable */
            button, input, .icon-btn, .progress-bar-container, .volume-slider, .play-pause-btn {
                -webkit-app-region: no-drag !important;
                cursor: pointer;
            }
            /* Header Bar */
            .header-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                height: 18px;
                margin-bottom: 2px;
                -webkit-app-region: drag;
            }
            .drag-pill {
                display: flex;
                align-items: center;
                gap: 5px;
                color: rgba(255, 255, 255, 0.45);
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                pointer-events: none;
            }
            .drag-pill svg {
                opacity: 0.6;
            }
            .window-actions {
                display: flex;
                align-items: center;
                gap: 4px;
            }
            .icon-btn {
                background: transparent;
                border: none;
                color: #b3b3b3;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                border-radius: 50%;
                transition: color 0.15s ease, background 0.15s ease, transform 0.1s ease;
            }
            .icon-btn:hover {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.12);
            }
            .icon-btn:active {
                transform: scale(0.92);
            }
            .icon-btn.active {
                color: #1db954;
            }
            /* Track Section */
            .track-section {
                display: flex;
                align-items: center;
                gap: 12px;
                min-width: 0;
            }
            .cover-container {
                position: relative;
                flex-shrink: 0;
                width: 52px;
                height: 52px;
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 4px 14px rgba(0,0,0,0.55);
                background: #282828;
                /* Interactive: double-click switches between compact and standard mode */
                pointer-events: auto;
                cursor: pointer;
                -webkit-app-region: no-drag !important;
            }
            .cover-art {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
                -webkit-user-drag: none;
            }
            /* Hover overlay on the cover: dims the art and shows the mode-switch icon */
            .cover-overlay {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0, 0, 0, 0.55);
                color: #ffffff;
                opacity: 0;
                transition: opacity 0.18s ease;
                pointer-events: none;
            }
            .cover-container:hover .cover-overlay {
                opacity: 1;
            }
            .cover-overlay svg {
                width: 18px;
                height: 18px;
                display: block;
            }
            .meta-container {
                display: flex;
                flex-direction: column;
                justify-content: center;
                min-width: 0;
                flex-grow: 1;
                overflow: hidden;
            }
            .meta-row {
                display: flex;
                align-items: center;
                gap: 6px;
                min-width: 0;
            }
            /* Marquee Title Container */
            .track-title-wrapper {
                overflow: hidden;
                white-space: nowrap;
                position: relative;
                min-width: 0;
                flex-grow: 1;
            }
            .track-title {
                display: inline-block;
                font-size: 13.5px;
                font-weight: 700;
                color: #ffffff;
                letter-spacing: -0.2px;
                line-height: 1.25;
                white-space: nowrap;
                transition: transform 0.2s ease;
            }
            /* Seamless looping marquee: the title is duplicated and the track slides one
               full title-width (+gap) so the loop point is invisible. Edges fade out. */
            .marquee-track {
                display: inline-flex;
                white-space: nowrap;
                will-change: transform;
            }
            .marquee-track.marquee {
                padding-left: 8px;
                animation: marquee-loop var(--marquee-dur, 10s) linear infinite;
            }
            .marquee-track.marquee .track-title {
                margin-right: 40px;
            }
            .track-title-wrapper.is-overflowing {
                -webkit-mask-image: linear-gradient(to right, transparent 0, #000 8px, #000 calc(100% - 18px), transparent 100%);
                mask-image: linear-gradient(to right, transparent 0, #000 8px, #000 calc(100% - 18px), transparent 100%);
            }
            @keyframes marquee-loop {
                0% {
                    transform: translateX(0);
                }
                8% {
                    transform: translateX(0);
                    /* ease in/out so it glides out of the pause instead of snapping into motion */
                    animation-timing-function: cubic-bezier(0.45, 0, 0.55, 1);
                }
                100% {
                    transform: translateX(calc(-1 * var(--marquee-dist, 100px)));
                }
            }
            .track-artist {
                font-size: 11.5px;
                font-weight: 500;
                color: #b3b3b3;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-top: 2px;
                line-height: 1.2;
            }
            /* Clickable title (album page) and artist names (artist pages) */
            .track-title.linkable,
            .track-title-text.linkable,
            .artist-link.linkable {
                -webkit-app-region: no-drag !important;
                cursor: pointer;
            }
            .track-title.linkable:hover,
            .track-title-text.linkable:hover {
                text-decoration: underline;
            }
            .artist-link.linkable:hover {
                color: #ffffff;
                text-decoration: underline;
            }
            /* Settings: "Click title / artist to open" turned off -> behave like plain, draggable text */
            body.links-off .track-title.linkable,
            body.links-off .track-title-text.linkable,
            body.links-off .artist-link.linkable {
                -webkit-app-region: drag !important;
                cursor: inherit;
            }
            body.links-off .track-title.linkable:hover,
            body.links-off .track-title-text.linkable:hover,
            body.links-off .artist-link.linkable:hover {
                text-decoration: none;
                color: inherit;
            }
            .heart-btn {
                flex-shrink: 0;
                padding: 3px;
                margin-left: 2px;
            }
            .heart-btn:hover {
                background: transparent;
                transform: scale(1.1);
            }
            /* Progress Scrubber (Standard Mode) */
            .progress-section {
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 4px 0 2px 0;
            }
            .time-label {
                font-size: 10px;
                color: #a7a7a7;
                font-variant-numeric: tabular-nums;
                min-width: 26px;
                text-align: center;
            }
            .progress-bar-container {
                position: relative;
                flex-grow: 1;
                display: flex;
                align-items: center;
                height: 14px;
            }
            /* Sliders: tall invisible hit area with a thin visible track, so the cursor doesn't have to
               line up with a 3-4px line. Fill is driven by --p (0..1) and ends exactly under the thumb. */
            .progress-slider,
            .volume-slider {
                -webkit-appearance: none;
                appearance: none;
                display: block;
                margin: 0;
                padding: 0;
                background: transparent;
                outline: none;
                --p: 0;
                --track-h: 4px;
                --thumb: 10px;
                --stop: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--p));
            }
            .progress-slider::-webkit-slider-runnable-track,
            .volume-slider::-webkit-slider-runnable-track {
                height: var(--track-h);
                border-radius: 999px;
                background: linear-gradient(to right, #1db954 var(--stop), rgba(255, 255, 255, 0.22) var(--stop));
                transition: height 0.15s ease;
            }
            .progress-slider::-webkit-slider-thumb,
            .volume-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: var(--thumb);
                height: var(--thumb);
                border-radius: 50%;
                background: #ffffff;
                margin-top: calc((var(--track-h) - var(--thumb)) / 2);
                transition: opacity 0.15s ease, transform 0.1s ease, margin-top 0.15s ease;
            }
            .progress-slider {
                width: 100%;
                height: 18px;
            }
            .progress-bar-container:hover .progress-slider {
                --track-h: 6px;
            }
            .progress-slider::-webkit-slider-thumb {
                opacity: 0;
            }
            .progress-bar-container:hover .progress-slider::-webkit-slider-thumb {
                opacity: 1;
                transform: scale(1.15);
            }
            /* Controls Section (Centered) */
            .controls-section {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-top: 2px;
            }
            .controls-spacer {
                width: 65px;
                flex-shrink: 0;
            }
            .playback-controls {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .play-pause-btn {
                background: #ffffff;
                color: #000000;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                border: none;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                transition: transform 0.12s ease, background 0.12s ease;
            }
            .play-pause-btn:hover {
                transform: scale(1.08);
                background: #f2f2f2;
            }
            .play-pause-btn:active {
                transform: scale(0.95);
            }
            /* Volume Section */
            .volume-section {
                display: flex;
                align-items: center;
                gap: 6px;
                width: 65px;
                flex-shrink: 0;
                justify-content: flex-end;
            }
            .volume-slider {
                width: 48px;
                height: 18px;
                --track-h: 3px;
                --thumb: 8px;
            }

            /* DEFAULT (Standard) Mode: Hide compact-only elements */
            .compact-actions-cluster {
                display: none !important;
            }

            /* ======================================================== */
            /* COMPACT BAR MODE: Longer, includes long timeline bar!    */
            /* ======================================================== */
            body.compact-mode .miniplayer-card {
                width: 100%;
                height: ${COMPACT_HEIGHT}px;
                max-width: ${COMPACT_WIDTH}px;
                max-height: ${COMPACT_HEIGHT}px;
                min-width: 0;
                min-height: ${COMPACT_HEIGHT}px;
                padding: 8px 10px 10px;
                justify-content: center;
                gap: 7px;
            }
            body.compact-mode .header-bar,
            body.compact-mode .drag-pill,
            body.compact-mode .volume-section,
            body.compact-mode #btn-shuffle,
            body.compact-mode #btn-repeat,
            body.compact-mode .controls-spacer,
            body.compact-mode .controls-section {
                display: none !important;
            }
            /* Show compact cluster only in compact mode */
            body.compact-mode .compact-actions-cluster {
                display: contents !important;
            }
            /* Expand + close stacked vertically at the far right */
            body.compact-mode .compact-actions-cluster .window-actions {
                flex-direction: column-reverse;
                gap: 0;
                margin-left: 0 !important;
                transform: none;
                flex-shrink: 0;
            }
            body.compact-mode .compact-actions-cluster .window-actions .icon-btn {
                width: 20px;
                height: 20px;
            }
            body.compact-mode .track-section {
                gap: 10px;
                align-items: center;
                margin-top: 0;
            }
            body.compact-mode .cover-container {
                width: 42px;
                height: 42px;
            }
            /* Let the title/artist take all remaining width instead of a fixed 170px */
            body.compact-mode .meta-container {
                max-width: 140px;
                flex: 1 1 0;
                min-width: 0;
            }
            body.compact-mode .track-title {
                font-size: 12.5px;
            }
            body.compact-mode .track-artist {
                font-size: 10.5px;
                margin-top: 1px;
            }
            body.compact-mode .playback-controls {
                gap: 8px;
            }
            body.compact-mode #btn-prev-compact,
            body.compact-mode #btn-next-compact {
                width: 26px;
                height: 26px;
                margin: 0;
            }
            body.compact-mode .compact-actions-cluster .playback-controls {
                transform: none;
                gap: 3px;
                margin: 0 auto;
                flex-shrink: 0;
            }
            body.compact-mode #btn-shuffle-compact,
            body.compact-mode #btn-repeat-compact,
            body.compact-mode #btn-volume-compact {
                width: 24px;
                height: 24px;
            }
            /* Icon alignment: block-level svgs avoid inline baseline offsets, and the
               speaker glyph is left-heavy (body left, waves right) so nudge it to look centered */
            .icon-btn svg {
                display: block;
                flex-shrink: 0;
            }
            #btn-volume-compact svg,
            #btn-volume-icon-compact svg,
            #btn-volume-icon svg {
                transform: translateX(0.75px);
            }
            /* Compact volume popup: slides over the timeline row when the speaker is clicked */
            .volume-popup {
                display: none;
                position: absolute;
                left: 10px;
                right: 10px;
                bottom: 8px;
                height: 18px;
                z-index: 5;
                align-items: center;
                gap: 6px;
                padding: 0;
            }
            .volume-popup, .volume-popup * {
                -webkit-app-region: no-drag !important;
            }
            /* Hidden-but-laid-out in compact mode so it can crossfade with the timeline */
            body.compact-mode .volume-popup {
                display: flex;
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                transform: translateY(3px);
                transition: opacity 0.22s ease, transform 0.22s ease, visibility 0s linear 0.22s;
            }
            body.compact-mode .volume-popup.open {
                opacity: 1;
                visibility: visible;
                pointer-events: auto;
                transform: none;
                transition: opacity 0.22s ease, transform 0.22s ease, visibility 0s;
            }
            /* Timeline fades out while the volume row is showing, and back in afterwards */
            body.compact-mode .progress-section {
                transition: opacity 0.22s ease;
            }
            body.compact-mode.volume-open .progress-section {
                opacity: 0;
                pointer-events: none;
            }
            .volume-popup .icon-btn {
                width: 18px;
                height: 18px;
                flex-shrink: 0;
            }
            .volume-popup .volume-slider {
                flex: 1;
                width: auto;
                height: 18px;
                --track-h: 4px;
                --thumb: 11px;
            }
            .volume-pct {
                font-size: 9.5px;
                color: #a7a7a7;
                min-width: 24px;
                text-align: center;
                font-variant-numeric: tabular-nums;
            }
            body.compact-mode .play-pause-btn {
                width: 32px;
                height: 32px;
                margin: 0;
            }
            /* Compact Mode Timeline Bar: Full width, sleek and long */
            body.compact-mode .progress-section {
                display: flex !important;
                margin: 0;
                gap: 6px;
                width: 100%;
                height: 14px;
            }
            body.compact-mode .time-label {
                font-size: 9.5px;
                min-width: 24px;
            }
            body.compact-mode .progress-slider {
                height: 16px;
                --track-h: 3px;
            }
            body.compact-mode .progress-bar-container:hover .progress-slider {
                --track-h: 5px;
            }

            /* ======================================================== */
            /* MINI MODE: title + controls only (plus the next-up strip) */
            /* Builds on the compact layout, so it only overrides what differs */
            /* ======================================================== */
            body.mini-mode .miniplayer-card {
                max-width: ${MINI_WIDTH}px;
                /* Fill whatever height the window has, so a window that's taller than expected
                   never shows an empty bar between the strip and the controls */
                flex: 1 1 auto;
                height: auto;
                max-height: none;
                min-height: ${MINI_HEIGHT}px;
                padding: 8px 10px;
                gap: 0;
            }
            body.mini-mode .cover-container,
            body.mini-mode .track-artist,
            body.compact-mode.mini-mode .progress-section,
            body.mini-mode .volume-popup,
            body.mini-mode #btn-volume-compact {
                display: none !important;
            }
            body.mini-mode .meta-container {
                max-width: 140px;
                flex: 1 1 0;
                min-width: 0;
            }
            body.mini-mode .track-artist-inline {
                color: #b3b3b3;
                font-weight: 500;
                margin-left: 2px;
            }
            body.mini-mode .track-artist-inline .artist-link.linkable {
                color: #b3b3b3;
            }
            body.mini-mode .track-artist-inline .artist-link.linkable:hover {
                color: #ffffff;
            }
            body.mini-mode .compact-actions-cluster .window-actions {
                flex-direction: row;
                gap: 2px;
            }
            /* Mini-only mode button (Mini has no cover to click) */
            .mini-only {
                display: none !important;
            }
            body.mini-mode .mini-only {
                display: flex !important;
            }
            /* Only one usable mode: hide every switch affordance */
            body.single-mode .mini-only {
                display: none !important;
            }
            body.single-mode .cover-overlay {
                display: none;
            }
            body.single-mode .cover-container {
                cursor: default;
            }
            /* Brief volume readout shown over the card in Mini mode */
            .volume-toast {
                position: absolute;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%) scale(0.96);
                z-index: 6;
                padding: 4px 12px;
                border-radius: 999px;
                background: rgba(18, 18, 18, 0.94);
                border: 1px solid rgba(255, 255, 255, 0.14);
                color: #ffffff;
                font-size: 11px;
                font-weight: 600;
                white-space: nowrap;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.15s ease, transform 0.15s ease;
            }
            .volume-toast.show {
                opacity: 1;
                transform: translate(-50%, -50%);
            }
        `;
    }

    function getMiniPlayerHTML() {
        return `
            <div id="ambient-bg"></div>
            <!-- "Next up" strip (only shown when upcomingSong.js is installed) -->
            <div class="upcoming-bar" id="upcoming-bar">
                <span class="upcoming-label"><span class="upcoming-dot"></span>Next</span>
                <span class="upcoming-text" id="upcoming-text"><span id="upcoming-title" class="upcoming-title"></span><span id="upcoming-artist" class="upcoming-artist"></span></span>
            </div>
            <div class="miniplayer-card" id="miniplayer-card">
                <!-- Standard Mode Header -->
                <div class="header-bar" id="header-bar">
                    <div class="drag-pill">
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                            <circle cx="3" cy="4" r="1.5"/>
                            <circle cx="8" cy="4" r="1.5"/>
                            <circle cx="13" cy="4" r="1.5"/>
                            <circle cx="3" cy="11" r="1.5"/>
                            <circle cx="8" cy="11" r="1.5"/>
                            <circle cx="13" cy="11" r="1.5"/>
                        </svg>
                        Spotify
                    </div>
                    <div class="window-actions">
                        <button class="icon-btn" id="btn-close" title="Close Mini Player">
                            ${ICONS.close}
                        </button>
                    </div>
                </div>

                <!-- Track Info & Controls Row -->
                <div class="track-section">
                    <div class="cover-container" title="Switch mode">
                        <img id="cover-img" class="cover-art" src="" alt="Album Art" />
                        <div class="cover-overlay" id="cover-mode-icon">${MODE_ICONS[nextMode()]}</div>
                    </div>
                    <div class="meta-container">
                        <div class="meta-row">
                            <div class="track-title-wrapper" id="title-wrapper">
                                <div class="marquee-track" id="marquee-track">
                                    <span id="track-title" class="track-title" title="">No track playing</span>
                                </div>
                            </div>
                        </div>
                        <div id="track-artist" class="track-artist" title="">Spotify</div>
                    </div>

                    <!-- Compact Mode Inline Actions Cluster -->
                    <div class="compact-actions-cluster">
                        <div class="playback-controls compact-only">
                            <button class="icon-btn" id="btn-shuffle-compact" title="Enable Shuffle">
                                ${ICONS.shuffle}
                            </button>
                            <button class="icon-btn" id="btn-prev-compact" title="Previous Track">
                                ${ICONS.prev}
                            </button>
                            <button class="play-pause-btn" id="btn-play-pause-compact" title="Play / Pause">
                                ${ICONS.play}
                            </button>
                            <button class="icon-btn" id="btn-next-compact" title="Next Track">
                                ${ICONS.next}
                            </button>
                            <button class="icon-btn" id="btn-repeat-compact" title="Enable Repeat">
                                ${ICONS.repeat}
                            </button>
                            <button class="icon-btn" id="btn-volume-compact" title="Volume">
                                ${ICONS.volumeHigh}
                            </button>
                        </div>
                        <div class="window-actions compact-only" style="margin-left: 4px;">
                            <button class="icon-btn mini-only" id="btn-mode-mini" title="Switch mode">
                                ${MODE_ICONS[nextMode()]}
                            </button>
                            <button class="icon-btn" id="btn-close-compact" title="Close Mini Player">
                                ${ICONS.close}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Timeline Scrubber Bar (Shown in both Standard & Compact modes) -->
                <div class="progress-section" id="progress-section">
                    <span id="time-current" class="time-label">0:00</span>
                    <div class="progress-bar-container">
                        <input type="range" id="progress-slider" class="progress-slider" min="0" max="1000" value="0" />
                    </div>
                    <span id="time-duration" class="time-label">0:00</span>
                </div>

                <!-- Standard Mode Bottom Controls -->
                <div class="controls-section" id="controls-section">
                    <div class="controls-spacer"></div>

                    <div class="playback-controls">
                        <button class="icon-btn" id="btn-shuffle" title="Enable Shuffle">
                            ${ICONS.shuffle}
                        </button>
                        <button class="icon-btn" id="btn-prev" title="Previous Track">
                            ${ICONS.prev}
                        </button>
                        <button class="play-pause-btn" id="btn-play-pause" title="Play / Pause">
                            ${ICONS.play}
                        </button>
                        <button class="icon-btn" id="btn-next" title="Next Track">
                            ${ICONS.next}
                        </button>
                        <button class="icon-btn" id="btn-repeat" title="Enable Repeat">
                            ${ICONS.repeat}
                        </button>
                    </div>

                    <div class="volume-section">
                        <button class="icon-btn" id="btn-volume-icon" title="Mute / Unmute">
                            ${ICONS.volumeHigh}
                        </button>
                        <input type="range" id="volume-slider" class="volume-slider" min="0" max="100" value="100" />
                    </div>
                </div>

                <!-- Compact Mode Volume Popup (opens from the speaker button) -->
                <div class="volume-popup" id="volume-popup">
                    <button class="icon-btn" id="btn-volume-icon-compact" title="Mute / Unmute">${ICONS.volumeHigh}</button>
                    <input type="range" id="volume-slider-compact" class="volume-slider" min="0" max="100" value="100" />
                    <span id="volume-pct" class="volume-pct">100%</span>
                </div>

                <!-- Brief volume readout (used by Mini mode, which has no slider) -->
                <div class="volume-toast" id="volume-toast"></div>
            </div>
        `;
    }

    function bindMiniPlayerEvents() {
        if (!pipWindow) return;
        const doc = pipWindow.document;

        // Native Mouse Drag tracking fallback
        let isDragging = false;
        let startX = 0, startY = 0;
        const card = doc.getElementById("miniplayer-card");

        if (card) {
            card.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                if (/** @type {HTMLElement} */(e.target).closest("button, input, a, .progress-bar-container")) return;
                isDragging = true;
                startX = e.screenX;
                startY = e.screenY;
            });

            pipWindow.addEventListener("mousemove", (e) => {
                if (!isDragging) return;
                const dx = e.screenX - startX;
                const dy = e.screenY - startY;
                startX = e.screenX;
                startY = e.screenY;
                try {
                    pipWindow.moveBy(dx, dy);
                } catch (err) {}
            });

            pipWindow.addEventListener("mouseup", () => {
                isDragging = false;
            });
        }

        // Mode Toggles
        const toggleMode = () => {
            const next = nextMode();
            if (next === currentMode) return; // only one usable mode
            currentMode = next;
            localStorage.setItem(MODE_KEY, currentMode);
            applyModeLayout(true);
        };
        // Mini mode has no cover, so it gets its own small mode button
        doc.getElementById("btn-mode-mini")?.addEventListener("click", toggleMode);

        // Click the album art to switch modes (ignore clicks that were really a window drag)
        const coverContainer = doc.querySelector(".cover-container");
        let coverDownX = 0;
        let coverDownY = 0;
        coverContainer?.addEventListener("mousedown", (e) => {
            coverDownX = e.screenX;
            coverDownY = e.screenY;
        });
        coverContainer?.addEventListener("click", (e) => {
            if (Math.abs(e.screenX - coverDownX) > 4 || Math.abs(e.screenY - coverDownY) > 4) return;
            toggleMode();
        });

        // Click the title -> album page, click an artist name -> that artist's page.
        // Clicks that were really a window drag are ignored.
        const bindLink = (root, selector, getUri) => {
            let downX = 0;
            let downY = 0;
            root?.addEventListener("mousedown", (e) => {
                downX = e.screenX;
                downY = e.screenY;
            });
            root?.addEventListener("click", (e) => {
                if (!settings.clickToOpen) return;
                if (Math.abs(e.screenX - downX) > 4 || Math.abs(e.screenY - downY) > 4) return;
                const el = /** @type {HTMLElement} */ (e.target).closest(selector);
                const uri = el ? getUri(el) : "";
                if (uri) openInSpotify(uri);
            });
        };
        bindLink(doc.getElementById("title-wrapper"), ".track-title.linkable, .track-title-text.linkable", () => currentAlbumUri);
        bindLink(doc.getElementById("title-wrapper"), ".artist-link.linkable", (el) => el.dataset.uri || "");
        bindLink(doc.getElementById("track-artist"), ".artist-link.linkable", (el) => el.dataset.uri || "");

        // Close Buttons
        doc.getElementById("btn-close")?.addEventListener("click", () => closeMiniPlayer());
        doc.getElementById("btn-close-compact")?.addEventListener("click", () => closeMiniPlayer());

        // Play / Pause
        const handlePlayPause = () => Spicetify.Player.togglePlay();
        doc.getElementById("btn-play-pause")?.addEventListener("click", handlePlayPause);
        doc.getElementById("btn-play-pause-compact")?.addEventListener("click", handlePlayPause);

        // Prev & Next
        const handlePrev = () => Spicetify.Player.back();
        const handleNext = () => Spicetify.Player.next();
        doc.getElementById("btn-prev")?.addEventListener("click", handlePrev);
        doc.getElementById("btn-prev-compact")?.addEventListener("click", handlePrev);
        doc.getElementById("btn-next")?.addEventListener("click", handleNext);
        doc.getElementById("btn-next-compact")?.addEventListener("click", handleNext);

        // Shuffle & Repeat
        // Shuffle & Repeat (standard + compact buttons)
        ["btn-shuffle", "btn-shuffle-compact"].forEach(id => {
            doc.getElementById(id)?.addEventListener("click", () => {
                Spicetify.Player.toggleShuffle();
                safeSetTimeout(updateShuffleRepeatState, 100);
            });
        });
        ["btn-repeat", "btn-repeat-compact"].forEach(id => {
            doc.getElementById(id)?.addEventListener("click", () => {
                Spicetify.Player.toggleRepeat();
                safeSetTimeout(updateShuffleRepeatState, 100);
            });
        });

        // Progress Scrubber
        const progressSlider = doc.getElementById("progress-slider");
        if (progressSlider) {
            progressSlider.addEventListener("mousedown", () => {
                isUserSeeking = true;
            });
            progressSlider.addEventListener("input", (e) => {
                const duration = Spicetify.Player.getDuration() || 0;
                // @ts-ignore
                const pct = (e.target.value / 1000);
                const currentMs = duration * pct;
                const timeCurrent = doc.getElementById("time-current");
                if (timeCurrent) {
                    const formatted = formatTime(currentMs);
                    if (formatted !== lastFormattedTime) {
                        lastFormattedTime = formatted;
                        timeCurrent.textContent = formatted;
                    }
                }
                updateSliderFill(progressSlider, pct * 100);
            });
            progressSlider.addEventListener("change", (e) => {
                // @ts-ignore
                const pct = (e.target.value / 1000);
                Spicetify.Player.seek(pct);
                isUserSeeking = false;
                startProgressLoop();
            });
        }

        // Volume Controls (standard row + compact click-popup)
        const volumePopup = doc.getElementById("volume-popup");
        const volumeTrigger = doc.getElementById("btn-volume-compact");
        let volumePopupTimer;

        const isVolumePopupOpen = () => !!volumePopup?.classList.contains("open");
        const resetVolumePopupTimer = () => {
            safeClearTimeout(volumePopupTimer);
            volumePopupTimer = safeSetTimeout(() => {
                if (isAdjustingVolume) resetVolumePopupTimer();
                else setVolumePopup(false);
            }, 2000);
        };
        const setVolumePopup = (open) => {
            if (!volumePopup) return;
            volumePopup.classList.toggle("open", open);
            doc.body.classList.toggle("volume-open", open);
            volumeTrigger?.classList.toggle("active", open);
            if (open) {
                updateVolumeUI(Spicetify.Player.getVolume());
                resetVolumePopupTimer();
            } else {
                safeClearTimeout(volumePopupTimer);
            }
        };

        volumeTrigger?.addEventListener("click", () => setVolumePopup(!isVolumePopupOpen()));

        // Any interaction inside the popup counts as activity and restarts the 2s timer
        volumePopup?.addEventListener("pointermove", () => {
            if (isVolumePopupOpen()) resetVolumePopupTimer();
        });

        // Clicking anywhere outside the popup closes it
        doc.addEventListener("mousedown", (e) => {
            if (!isVolumePopupOpen()) return;
            const target = /** @type {HTMLElement} */ (e.target);
            if (target.closest("#volume-popup, #btn-volume-compact")) return;
            setVolumePopup(false);
        });

        ["volume-slider", "volume-slider-compact"].forEach(id => {
            const slider = doc.getElementById(id);
            if (!slider) return;
            slider.addEventListener("pointerdown", () => { isAdjustingVolume = true; });
            slider.addEventListener("input", (e) => {
                // @ts-ignore
                const val = parseFloat(e.target.value) / 100;
                Spicetify.Player.setVolume(val);
                updateVolumeUI(val);
                if (isVolumePopupOpen()) resetVolumePopupTimer();
            });
        });
        doc.addEventListener("pointerup", () => { isAdjustingVolume = false; });

        ["btn-volume-icon", "btn-volume-icon-compact"].forEach(id => {
            doc.getElementById(id)?.addEventListener("click", () => {
                Spicetify.Player.toggleMute();
                if (isVolumePopupOpen()) resetVolumePopupTimer();
                safeSetTimeout(() => {
                    const vol = Spicetify.Player.getVolume();
                    updateVolumeUI(vol);
                }, 100);
            });
        });

        // Brief volume readout for Mini mode (no slider there)
        let volumeToastTimer;
        const showVolumeToast = (vol) => {
            const toast = doc.getElementById("volume-toast");
            if (!toast) return;
            toast.textContent = `Volume ${Math.round(vol * 100)}%`;
            toast.classList.add("show");
            safeClearTimeout(volumeToastTimer);
            volumeToastTimer = safeSetTimeout(() => toast.classList.remove("show"), 900);
        };

        // Scroll wheel: over the timeline = seek, anywhere else = volume (step sizes come from settings)
        if (card) {
            let lastWheelSeekMs = null;
            let lastWheelSeekAt = 0;
            let wheelSeekTimer;
            card.addEventListener("wheel", (e) => {
                if (!settings.scrollAdjust) return;
                e.preventDefault();
                if (e.deltaY === 0) return;
                const dir = e.deltaY < 0 ? 1 : -1;
                const target = /** @type {HTMLElement} */ (e.target);

                if (target.closest("#progress-section")) {
                    const duration = Spicetify.Player.getDuration() || 0;
                    if (!duration) return;
                    const now = Date.now();
                    // Chain rapid scrolls from the last target so steps stack up before the seek lands
                    const base = (lastWheelSeekMs !== null && now - lastWheelSeekAt < 600)
                        ? lastWheelSeekMs
                        : (Spicetify.Player.getProgress() || 0);
                    const next = Math.min(Math.max(duration - 1000, 0), Math.max(0, base + dir * settings.seekStep * 1000));
                    lastWheelSeekMs = next;
                    lastWheelSeekAt = now;
                    Spicetify.Player.seek(next / duration);

                    // Reflect immediately and hold the tick off briefly so it doesn't flicker back
                    isUserSeeking = true;
                    safeClearTimeout(wheelSeekTimer);
                    wheelSeekTimer = safeSetTimeout(() => {
                        isUserSeeking = false;
                        startProgressLoop();
                    }, 450);
                    const timeCurrent = doc.getElementById("time-current");
                    if (timeCurrent) {
                        const formatted = formatTime(next);
                        if (formatted !== lastFormattedTime) {
                            lastFormattedTime = formatted;
                            timeCurrent.textContent = formatted;
                        }
                    }
                    const slider = doc.getElementById("progress-slider");
                    if (slider) {
                        // @ts-ignore
                        slider.value = String(Math.round((next / duration) * 1000));
                        updateSliderFill(slider, (next / duration) * 100);
                    }
                } else {
                    const current = Spicetify.Player.getVolume() || 0;
                    const next = Math.min(1, Math.max(0, Math.round((current + dir * settings.volumeStep / 100) * 100) / 100));
                    Spicetify.Player.setVolume(next);
                    updateVolumeUI(next);
                    // Compact has no visible slider, so show the volume row; Mini shows a brief readout
                    if (currentMode === "compact") {
                        if (!isVolumePopupOpen()) setVolumePopup(true);
                        else resetVolumePopupTimer();
                    } else if (currentMode === "mini") {
                        showVolumeToast(next);
                    }
                }
            }, { passive: false });
        }

        // Auto-fade: dim the window shortly after the mouse leaves, restore instantly on return
        // (always bound; settings.autoFade is checked at runtime so the setting can change live)
        {
            let mouseInside = false;
            let fadeTimer;
            const root = doc.documentElement;
            const scheduleFade = (delay) => {
                safeClearTimeout(fadeTimer);
                fadeTimer = safeSetTimeout(() => {
                    if (mouseInside || !settings.autoFade) return;
                    // Don't dim mid-interaction (e.g. dragging a slider or the window)
                    if (isUserSeeking || isAdjustingVolume || isDragging) {
                        scheduleFade(500);
                        return;
                    }
                    doc.body.classList.add("idle");
                }, delay);
            };
            // Brighten everything (card AND the next-up strip, in every mode) the moment the mouse is over the window
            const wake = () => {
                mouseInside = true;
                safeClearTimeout(fadeTimer);
                doc.body.classList.remove("idle");
            };
            root.addEventListener("mouseenter", wake);
            // Safety net: any movement over the window counts as hovering, even if mouseenter was missed
            doc.addEventListener("mousemove", () => {
                if (!mouseInside || doc.body.classList.contains("idle")) wake();
            });
            root.addEventListener("mouseleave", (e) => {
                mouseInside = false;
                // Native drag areas (the next-up strip, empty card space) don't send mouse events, so moving
                // onto one looks like leaving the window. If the pointer "left" while still inside the window's
                // bounds, it's most likely resting on a drag area, so give it a longer grace period.
                const w = pipWindow ? pipWindow.innerWidth : 0;
                const hgt = pipWindow ? pipWindow.innerHeight : 0;
                const insideBounds = e.clientX > 1 && e.clientY > 1 && e.clientX < w - 1 && e.clientY < hgt - 1;
                scheduleFade(insideBounds ? settings.idleDelay + 2200 : settings.idleDelay);
            });
            // If the window opens without the mouse on it, dim it after a few seconds
            scheduleFade(2500);
        }

        // Save window position only when dragging/moving finishes or window loses focus
        pipWindow.addEventListener("mouseup", saveWindowPosition);
        pipWindow.addEventListener("blur", saveWindowPosition);

        // Resume visual progress loop immediately when PiP document becomes visible
        doc.addEventListener("visibilitychange", () => {
            if (!doc.hidden) {
                updateProgressVisuals();
                if (Spicetify.Player.isPlaying()) {
                    startProgressLoop();
                }
            }
        });

        applyModeLayout();
    }

    function applyModeLayout(redetect = false) {
        if (!pipWindow) return;
        const doc = pipWindow.document;
        // Popup only exists in compact mode; close it when the layout changes
        doc.getElementById("volume-popup")?.classList.remove("open");
        doc.body.classList.remove("volume-open");
        doc.getElementById("btn-volume-compact")?.classList.remove("active");
        // Compact and Mini share the compact layout; Mini then strips it down further
        doc.body.classList.toggle("compact-mode", currentMode !== "standard");
        doc.body.classList.toggle("mini-mode", currentMode === "mini");
        // Re-check for upcomingSong.js on mode switches (a user gesture, so the window may be resized)
        if (redetect) upcomingBarEnabled = shouldShowUpcoming();
        doc.body.classList.toggle("has-upcoming", upcomingBarEnabled);
        lastUpcomingKey = null;
        updateUpcomingBar();
        // The cover's hover icon / Mini button show the mode you'd switch to
        refreshModeUi();
        resizePiPWindowToMode();
        renderFullUI();
        safeSetTimeout(updateMarqueeEffect, 100);
    }

    function resizePiPWindowToMode() {
        if (!pipWindow || pipWindow.closed) return;

        const { width: targetWidth, height: targetHeight } = getTargetSize();
        if (pipWindow.innerWidth === targetWidth && pipWindow.innerHeight === targetHeight) return;

        try {
            pipWindow.resizeTo(
                targetWidth + pipWindowFrameWidth,
                targetHeight + pipWindowFrameHeight
            );
        } catch (err) {
            console.warn("[MiniPlayer] Unable to restore the fixed window size:", err);
        }
    }

    function updateMarqueeEffect(force = false) {
        if (!pipWindow || pipWindow.closed) return;
        const doc = pipWindow.document;
        const wrapper = doc.getElementById("title-wrapper");
        const track = doc.getElementById("marquee-track");
        const titleEl = doc.getElementById("track-title");
        if (!wrapper || !track || !titleEl) return;

        const availableWidth = wrapper.clientWidth;
        const titleText = titleEl.textContent || "";
        const key = `${currentMode}\u0000${availableWidth}\u0000${titleText}`;
        if (!force && key === lastMarqueeKey) return;
        lastMarqueeKey = key;

        // Reset any previous marquee state
        doc.getElementById("track-title-clone")?.remove();
        track.classList.remove("marquee");
        wrapper.classList.remove("is-overflowing");
        track.style.removeProperty("--marquee-dist");
        track.style.removeProperty("--marquee-dur");

        const textWidth = titleEl.getBoundingClientRect().width;
        if (textWidth - availableWidth > 4) {
            const gap = 40; // keep in sync with .marquee-track.marquee .track-title margin-right
            const clone = titleEl.cloneNode(true);
            clone.id = "track-title-clone";
            clone.setAttribute("aria-hidden", "true");
            track.appendChild(clone);

            const dist = textWidth + gap;
            track.style.setProperty("--marquee-dist", `${dist}px`);
            track.style.setProperty("--marquee-dur", `${Math.max(7, dist / 26)}s`);
            wrapper.classList.add("is-overflowing");
            track.classList.add("marquee");
        }
    }

    function renderFullUI() {
        if (!pipWindow) return;
        const doc = pipWindow.document;
        const meta = getTrackMetadata();

        // Title & Artist
        const titleEl = doc.getElementById("track-title");
        const artistEl = doc.getElementById("track-artist");
        currentAlbumUri = meta.albumUri || "";
        if (titleEl) {
            titleEl.textContent = "";
            titleEl.title = meta.title + (meta.album ? ` (${meta.album})` : "");
            
            const titleSpan = doc.createElement("span");
            titleSpan.className = "track-title-text" + (currentAlbumUri ? " linkable" : "");
            titleSpan.textContent = meta.title;
            if (currentAlbumUri) titleSpan.dataset.uri = currentAlbumUri;
            titleEl.appendChild(titleSpan);

            // In Mini Mode, combine Title and Artist on the same line like upcomingSong
            if (currentMode === "mini" && meta.artist) {
                const artistInline = doc.createElement("span");
                artistInline.className = "track-artist-inline";
                artistInline.appendChild(doc.createTextNode(" \u00b7 "));
                if (meta.artistList.length) {
                    meta.artistList.forEach((a, i) => {
                        if (i > 0) artistInline.appendChild(doc.createTextNode(", "));
                        const span = doc.createElement("span");
                        span.className = "artist-link" + (a.uri ? " linkable" : "");
                        span.textContent = a.name;
                        if (a.uri) span.dataset.uri = a.uri;
                        artistInline.appendChild(span);
                    });
                } else {
                    artistInline.appendChild(doc.createTextNode(meta.artist));
                }
                titleEl.appendChild(artistInline);
            }
        }
        if (artistEl) {
            artistEl.title = meta.artist;
            artistEl.textContent = "";
            if (meta.artistList.length) {
                meta.artistList.forEach((a, i) => {
                    if (i > 0) artistEl.appendChild(doc.createTextNode(", "));
                    const span = doc.createElement("span");
                    span.className = "artist-link" + (a.uri ? " linkable" : "");
                    span.textContent = a.name;
                    if (a.uri) span.dataset.uri = a.uri;
                    artistEl.appendChild(span);
                });
            } else {
                artistEl.textContent = meta.artist;
            }
        }

        updateMarqueeEffect();

        // Cover Art & Ambient BG
        const coverEl = doc.getElementById("cover-img");
        const ambientBg = doc.getElementById("ambient-bg");
        if (coverEl && meta.cover) {
            // @ts-ignore
            coverEl.src = meta.cover;
        }
        if (ambientBg && meta.cover) {
            ambientBg.style.backgroundImage = `url("${meta.cover}")`;
        }

        // Duration Label
        const durationEl = doc.getElementById("time-duration");
        if (durationEl) {
            durationEl.textContent = formatTime(meta.duration);
        }

        // Controls
        updatePlayPauseButton();
        updateShuffleRepeatState();

        // Volume
        const vol = Spicetify.Player.getVolume();
        updateVolumeUI(vol);
    }

    function updatePlayPauseButton() {
        if (!pipWindow) return;
        const doc = pipWindow.document;
        const btnStandard = doc.getElementById("btn-play-pause");
        const btnCompact = doc.getElementById("btn-play-pause-compact");
        const isPlaying = Spicetify.Player.isPlaying();
        const icon = isPlaying ? ICONS.pause : ICONS.play;

        if (btnStandard) {
            btnStandard.innerHTML = icon;
            btnStandard.title = isPlaying ? "Pause" : "Play";
        }
        if (btnCompact) {
            btnCompact.innerHTML = icon;
            btnCompact.title = isPlaying ? "Pause" : "Play";
        }
    }

    function updateShuffleRepeatState() {
        if (!pipWindow) return;
        const doc = pipWindow.document;
        const data = Spicetify.Player.data;
        if (data) {
            const isShuffle = !!data.shuffle;
            const isRepeat = data.repeat > 0;
            ["btn-shuffle", "btn-shuffle-compact"].forEach(id => {
                doc.getElementById(id)?.classList.toggle("active", isShuffle);
            });
            ["btn-repeat", "btn-repeat-compact"].forEach(id => {
                doc.getElementById(id)?.classList.toggle("active", isRepeat);
            });
        }
    }

    function updateVolumeUI(vol) {
        if (!pipWindow) return;
        const doc = pipWindow.document;
        const slider = doc.getElementById("volume-slider");
        const iconBtn = doc.getElementById("btn-volume-icon");

        const pct = Math.round((vol || 0) * 100);
        ["volume-slider", "volume-slider-compact"].forEach(id => {
            const s = doc.getElementById(id);
            if (!s) return;
            // @ts-ignore
            s.value = String(pct);
            updateSliderFill(s, pct);
        });
        const icon = pct === 0 ? ICONS.volumeMute : ICONS.volumeHigh;
        ["btn-volume-icon", "btn-volume-icon-compact", "btn-volume-compact"].forEach(id => {
            const b = doc.getElementById(id);
            if (b) b.innerHTML = icon;
        });
        const pctLabel = doc.getElementById("volume-pct");
        if (pctLabel) pctLabel.textContent = `${pct}%`;
    }

    function updateSliderFill(sliderEl, pct) {
        if (!sliderEl) return;
        const p = Math.min(100, Math.max(0, pct)) / 100;
        sliderEl.style.setProperty("--p", String(p));
    }

    function updateProgressVisuals() {
        if (!pipWindow || pipWindow.closed || isUserSeeking) return;
        const doc = pipWindow.document;

        const currentMs = Spicetify.Player.getProgress() || 0;
        const durationMs = Spicetify.Player.getDuration() || 0;

        const timeCurrent = doc.getElementById("time-current");
        const slider = doc.getElementById("progress-slider");

        if (timeCurrent) {
            const formatted = formatTime(currentMs);
            if (formatted !== lastFormattedTime) {
                lastFormattedTime = formatted;
                timeCurrent.textContent = formatted;
            }
        }

        if (slider && durationMs > 0) {
            const pct = Math.min(1, Math.max(0, currentMs / durationMs));
            const sliderVal = Math.round(pct * 1000);
            if (sliderVal !== lastSliderValue) {
                lastSliderValue = sliderVal;
                // @ts-ignore
                slider.value = String(sliderVal);
                updateSliderFill(slider, pct * 100);
            }
        }
    }

    function startProgressLoop() {
        if (rafId) return;
        if (!pipWindow || pipWindow.closed) return;

        const loop = () => {
            if (!pipWindow || pipWindow.closed) {
                rafId = null;
                return;
            }

            if (!pipWindow.document.hidden && !isUserSeeking) {
                updateProgressVisuals();
            }

            if (Spicetify.Player.isPlaying()) {
                rafId = pipWindow.requestAnimationFrame(loop);
            } else {
                rafId = null;
            }
        };

        rafId = pipWindow.requestAnimationFrame(loop);
    }

    function slowBackgroundTick() {
        if (!pipWindow || pipWindow.closed) return;
        saveWindowPosition();
        updateUpcomingBar();
        // Fallback progress tick when document is hidden or audio is paused
        if (pipWindow.document.hidden || !Spicetify.Player.isPlaying()) {
            updateProgressVisuals();
        }
        // Keep the popup in sync if volume is changed elsewhere (e.g. main Spotify window)
        if (!isAdjustingVolume && pipWindow.document.getElementById("volume-popup")?.classList.contains("open")) {
            updateVolumeUI(Spicetify.Player.getVolume());
        }
    }

    // Attach Spicetify Event Listeners for live sync
    Spicetify.Player.addEventListener("songchange", () => {
        if (pipWindow && !pipWindow.closed) {
            lastFormattedTime = "";
            lastSliderValue = -1;
            renderFullUI();
            updateUpcomingBar();
            startProgressLoop();
        }
    });

    Spicetify.Player.addEventListener("onplaypause", () => {
        if (pipWindow && !pipWindow.closed) {
            updatePlayPauseButton();
            if (Spicetify.Player.isPlaying()) {
                startProgressLoop();
            } else {
                updateProgressVisuals();
            }
        }
    });

    // Register UI Buttons inside Spotify Client
    function registerButtons() {
        // 1. Topbar Button: opens the mini player's settings (the playbar button / Alt+M toggle the player)
        if (Spicetify.Topbar?.Button) {
            try {
                topbarButton = new Spicetify.Topbar.Button(
                    "Mini Player Settings",
                    ICONS.gear,
                    () => openSettings()
                );
            } catch (e) {
                console.warn("[MiniPlayer] Could not create Topbar button:", e);
            }
        }

        // 2. Playbar Button
        try {
            const addPlaybarIcon = () => {
                if (document.getElementById("miniplayer-playbar-btn")) return true;
                const rightControls = document.querySelector(".main-nowPlayingBar-right") || document.querySelector('[data-testid="now-playing-bar-right"]');
                if (!rightControls) return false;

                const btn = document.createElement("button");
                btn.id = "miniplayer-playbar-btn";
                btn.className = "main-genericButton-button";
                btn.setAttribute("aria-label", "Mini Player (Alt+M)");
                btn.style.background = "transparent";
                btn.style.border = "none";
                btn.style.color = "#b3b3b3";
                btn.style.cursor = "pointer";
                btn.style.display = "inline-flex";
                btn.style.alignItems = "center";
                btn.style.justifyContent = "center";
                btn.style.padding = "6px";
                btn.innerHTML = ICONS.miniplayer;

                if (Spicetify.Tippy && Spicetify.TippyProps) {
                    Spicetify.Tippy(btn, {
                        content: "Mini Player (Alt+M)",
                        ...Spicetify.TippyProps
                    });
                } else {
                    btn.title = "Mini Player (Alt+M)";
                }

                btn.onmouseenter = () => btn.style.color = "#ffffff";
                btn.onmouseleave = () => {
                    btn.style.color = (pipWindow && !pipWindow.closed) ? "#1db954" : "#b3b3b3";
                };
                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleMiniPlayer();
                };

                // Smart insertion: find the button cluster and insert at its start
                // Try known Spotify control buttons to locate the cluster container
                const knownBtns = [
                    rightControls.querySelector('[data-testid="now-playing-view-button"]'),
                    rightControls.querySelector('[data-testid="control-button-npv"]'),
                    rightControls.querySelector('[data-testid="lyrics-button"]'),
                    rightControls.querySelector('[data-testid="control-button-lyrics"]'),
                    rightControls.querySelector('[data-testid="queue-button"]'),
                    rightControls.querySelector('[data-testid="control-button-queue"]'),
                ];

                let inserted = false;
                for (const knownBtn of knownBtns) {
                    if (knownBtn) {
                        // Insert into the same parent container as the existing buttons
                        knownBtn.parentNode.insertBefore(btn, knownBtn);
                        inserted = true;
                        break;
                    }
                }

                if (!inserted) {
                    // Fallback: find the first button inside a child div (the cluster container)
                    const firstNestedBtn = rightControls.querySelector("div button, div [role='button']");
                    if (firstNestedBtn && firstNestedBtn.parentNode !== rightControls) {
                        firstNestedBtn.parentNode.insertBefore(btn, firstNestedBtn);
                    } else {
                        // Last resort: append so it's at the end of the cluster, not floating far left
                        rightControls.appendChild(btn);
                    }
                }
                return true;
            };

            let playbarObserver = null;
            const initPlaybarIcon = () => {
                if (addPlaybarIcon()) {
                    if (!playbarObserver) {
                        const target = document.querySelector(".main-nowPlayingBar-container") || document.querySelector(".main-nowPlayingBar-right") || document.body;
                        playbarObserver = new MutationObserver(() => {
                            if (!document.getElementById("miniplayer-playbar-btn")) {
                                addPlaybarIcon();
                            }
                        });
                        playbarObserver.observe(target, { childList: true, subtree: true });
                    }
                    return true;
                }
                return false;
            };

            if (!initPlaybarIcon()) {
                const retryTimer = setInterval(() => {
                    if (initPlaybarIcon()) {
                        clearInterval(retryTimer);
                    }
                }, 500);
            }
        } catch (e) {
            console.warn("[MiniPlayer] Playbar injection error:", e);
        }

        // 3. Global Shortcut within Spotify (Alt + M)
        window.addEventListener("keydown", (e) => {
            if (e.altKey && (e.key === "m" || e.key === "M")) {
                const target = /** @type {HTMLElement} */ (e.target);
                const tag = target?.tagName?.toLowerCase();
                const isEditable = target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
                if (isEditable) return;

                e.preventDefault();
                toggleMiniPlayer();
            }
        });
    }

    registerButtons();
})();
