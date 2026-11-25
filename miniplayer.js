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
    let rafId = null;
    let progressTimerId = null;
    let isOpening = false;
    let lyricsObserver = null;
    let lyricsPollTimerId = null;
    let lyricsRefreshTimerId = null;
    let lyricsSource = null;
    let lastLyricsSnapshotKey = "";
    let lyricsTrackUri = "";      // track the lyrics view currently belongs to
    let lyricsStaleSig = "";      // content signature that was on screen when the track changed
    let lyricsStaleUntil = 0;     // until then, an unchanged signature means "still the old song"
    let lyricsTextMode = "original";
    let lyricsRomanizationAvailable = false;
    let episodeVideoSource = null;
    let episodeVideoStream = null;
    let episodeVideoUri = "";
    let failedEpisodeVideoSource = null;
    let failedEpisodeVideoUri = "";
    let lastEpisodeVideoWarning = "";
    // Layout mode and top-bar/queue state. Declared up here, ahead of the functions that read them
    // (currentMode is assigned from the saved setting once settings have loaded, further down).
    let currentMode = "standard";
    let lastUpcomingKey = null;
    let queueOpen = false;
    let lastQueueKey = null;
    let queueMenuEl = null;
    let queueMenuDisposers = [];
    let queueSelectionMode = false;
    let queueSelectedItems = new Map();
    let queueBulkConfirm = false;
    let queueBulkRemoving = false;
    let queueRenderDisposers = [];
    let queueRowDisposers = new Map();
    let renderedQueueItems = null;
    let queueHeadRemoval = null;
    let queueDragDisposers = [];
    let queueDragState = null;
    let queueRenderGeneration = 0;
    // Re-evaluates which mini player launcher the playback bar shows (assigned in registerButtons)
    let syncPlaybarButtons = () => {};
    let pipResources = null;
    const playerState = {
        currentTrack: null,
        isPlaying: false,
        progress: 0,
        duration: 0,
        volume: 1,
        shuffle: false,
        repeat: 0,
        queue: []
    };
    const playerStateListeners = new Set();
    const PLAYER_STATE_SYNC_MS = 2500;
    const QUEUE_STATE_SYNC_MS = 1500;
    const QUEUE_SNAPSHOT_WARNING_THRESHOLD = 100;
    const WINDOW_POSITION_SYNC_MS = 2500;
    const EPISODE_VIDEO_SYNC_MS = 500;
    const LYRICS_TEXT_MODES = ["original", "romanized", "both"];
    const LYRICS_TEXT_MODE_LABELS = {
        original: "Original",
        romanized: "Romanized",
        both: "Both"
    };
    const LYRICS_POLL_INTERVAL_MS = 100;
    const LYRICS_REFRESH_DEBOUNCE_MS = 40;
    const LYRICS_STALE_TIMEOUT_MS = 4000;
    const lyricsLineCache = new WeakMap(); // line element -> parsed text, so unchanged lines are never re-parsed
    let isUserSeeking = false;
    let isAdjustingVolume = false;
    let lastFormattedTime = "";
    let lastSliderValue = -1;
    let lastMarqueeKey = "";
    // Experimental dynamic resizing state (see applyFluidLayout)
    const fluid = { win: null, sig: "", prevSize: null };
    let lastProgressPaint = 0; // throttles the progress loop (see startProgressLoop)
    // Current layout mode ("standard" | "compact" | "mini") is set up below, after settings load

    function isPiPWindowOpen() {
        return !!pipWindow && !pipWindow.closed;
    }

    function createPiPResourceRegistry(win) {
        let active = true;
        const disposers = new Set();
        const timeouts = new Map();
        const intervals = new Map();
        const frames = new Map();

        const trackHandle = (map, id, cancel) => {
            const dispose = () => {
                if (!map.has(id)) return;
                map.delete(id);
                disposers.delete(dispose);
                cancel(id);
            };
            map.set(id, dispose);
            disposers.add(dispose);
            return id;
        };
        const forgetHandle = (map, id) => {
            const dispose = map.get(id);
            if (!dispose) return;
            map.delete(id);
            disposers.delete(dispose);
        };

        return {
            addCleanup(dispose) {
                if (!active) {
                    dispose();
                    return () => {};
                }
                disposers.add(dispose);
                return () => {
                    if (!disposers.delete(dispose)) return;
                    dispose();
                };
            },
            listen(target, type, listener, options) {
                target.addEventListener(type, listener, options);
                const dispose = () => {
                    target.removeEventListener(type, listener, options);
                    disposers.delete(dispose);
                };
                disposers.add(dispose);
                return dispose;
            },
            observe(observer, target, options) {
                observer.observe(target, options);
                const dispose = () => {
                    observer.disconnect();
                    disposers.delete(dispose);
                };
                disposers.add(dispose);
                return observer;
            },
            setTimeout(fn, ms) {
                const id = win.setTimeout(() => {
                    forgetHandle(timeouts, id);
                    if (active) fn();
                }, ms);
                return trackHandle(timeouts, id, handle => win.clearTimeout(handle));
            },
            clearTimeout(id) {
                timeouts.get(id)?.();
            },
            delay(ms) {
                return new Promise(resolve => {
                    let id;
                    let settled = false;
                    const finish = (completed) => {
                        if (settled) return;
                        settled = true;
                        forgetHandle(timeouts, id);
                        resolve(completed);
                    };
                    id = win.setTimeout(() => finish(active), ms);
                    const dispose = () => {
                        if (!timeouts.has(id)) return;
                        timeouts.delete(id);
                        disposers.delete(dispose);
                        win.clearTimeout(id);
                        finish(false);
                    };
                    timeouts.set(id, dispose);
                    disposers.add(dispose);
                });
            },
            setInterval(fn, ms) {
                const id = win.setInterval(() => {
                    if (active) fn();
                }, ms);
                return trackHandle(intervals, id, handle => win.clearInterval(handle));
            },
            requestAnimationFrame(fn) {
                const id = win.requestAnimationFrame(() => {
                    forgetHandle(frames, id);
                    if (active) fn();
                });
                return trackHandle(frames, id, handle => win.cancelAnimationFrame(handle));
            },
            cleanup() {
                if (!active) return;
                active = false;
                for (const dispose of [...disposers]) {
                    try {
                        dispose();
                    } catch (err) {
                        console.warn("[MiniPlayer] Could not clean up a PiP resource:", err);
                    }
                }
                disposers.clear();
            }
        };
    }

    function listenPiP(target, type, listener, options) {
        if (!target || !pipResources) return;
        return pipResources.listen(target, type, listener, options);
    }

    function syncPodcastVideoLayout() {
        if (!isPiPWindowOpen()) return;
        const active = !!episodeVideoStream
            && pipWindow.innerWidth >= 690
            && pipWindow.innerHeight >= 420;
        pipWindow.document.body.classList.toggle("podcast-video-wide", active);
    }

    function releaseEpisodeVideo() {
        if (episodeVideoStream) {
            episodeVideoStream.getTracks().forEach(track => track.stop());
            episodeVideoStream = null;
        }
        if (isPiPWindowOpen()) {
            const video = pipWindow.document.getElementById("episode-video");
            if (video) {
                video.pause();
                video.srcObject = null;
                video.onloadeddata = null;
            }
            pipWindow.document.querySelector(".cover-container")?.classList.remove("video-active");
            pipWindow.document.body.classList.remove("podcast-video-active");
            pipWindow.document.body.classList.remove("podcast-video-wide");
        }
        episodeVideoSource = null;
    }

    function warnEpisodeVideoCaptureUnavailable(uri, reason) {
        const key = `${uri}\u0000${reason}`;
        if (key === lastEpisodeVideoWarning) return;
        lastEpisodeVideoWarning = key;
        console.warn(`[MiniPlayer] Podcast video preview unavailable (${reason}); keeping episode art.`);
        Spicetify.showNotification("Podcast video isn't accessible; showing episode art.", true);
    }

    function findVisibleSpotifyVideo() {
        let bestVideo = null;
        let bestArea = 0;
        for (const video of document.querySelectorAll("video")) {
            if (!video.isConnected || video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
            const rect = video.getBoundingClientRect();
            if (rect.width < 96 || rect.height < 54
                || rect.bottom <= 0 || rect.right <= 0
                || rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue;
            const style = window.getComputedStyle(video);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestVideo = video;
                bestArea = area;
            }
        }
        return bestVideo;
    }

    function syncEpisodeVideo() {
        if (!isPiPWindowOpen()) return;
        const item = playerState.currentTrack;
        const uri = item?.uri || "";
        const isEpisode = uri.startsWith("spotify:episode:") || item?.type === "episode";
        pipWindow.document.body.classList.toggle("podcast-track", isEpisode);
        if (!isEpisode) {
            releaseEpisodeVideo();
            episodeVideoUri = "";
            failedEpisodeVideoSource = null;
            failedEpisodeVideoUri = "";
            return;
        }
        if (currentMode !== "standard") {
            releaseEpisodeVideo();
            return;
        }
        if (episodeVideoUri !== uri) {
            releaseEpisodeVideo();
            episodeVideoUri = uri;
            failedEpisodeVideoSource = null;
            failedEpisodeVideoUri = "";
        }

        const source = findVisibleSpotifyVideo();
        if (!source) {
            if (episodeVideoSource && !episodeVideoSource.isConnected) releaseEpisodeVideo();
            return;
        }
        if (source === episodeVideoSource && episodeVideoStream) return;
        if (source === failedEpisodeVideoSource && uri === failedEpisodeVideoUri) return;

        releaseEpisodeVideo();
        const capture = source.captureStream || source.mozCaptureStream;
        if (typeof capture !== "function") {
            failedEpisodeVideoSource = source;
            failedEpisodeVideoUri = uri;
            warnEpisodeVideoCaptureUnavailable(uri, "captureStream is unsupported");
            return;
        }

        let capturedStream = null;
        try {
            capturedStream = capture.call(source);
            const videoTracks = capturedStream.getVideoTracks();
            capturedStream.getAudioTracks().forEach(track => track.stop());
            if (!videoTracks.length || typeof pipWindow.MediaStream !== "function") {
                capturedStream.getTracks().forEach(track => track.stop());
                failedEpisodeVideoSource = source;
                failedEpisodeVideoUri = uri;
                warnEpisodeVideoCaptureUnavailable(uri, "no usable video track");
                return;
            }

            const video = pipWindow.document.getElementById("episode-video");
            const cover = pipWindow.document.querySelector(".cover-container");
            if (!video || !cover) {
                capturedStream.getTracks().forEach(track => track.stop());
                return;
            }
            episodeVideoSource = source;
            episodeVideoStream = new pipWindow.MediaStream(videoTracks);
            video.muted = true;
            video.playsInline = true;
            video.onloadeddata = () => {
                if (episodeVideoSource === source && isPiPWindowOpen()) {
                    cover.classList.add("video-active");
                    pipWindow.document.body.classList.add("podcast-video-active");
                    syncPodcastVideoLayout();
                }
            };
            video.srcObject = episodeVideoStream;
            const playResult = video.play();
            if (playResult && typeof playResult.catch === "function") {
                playResult.catch(error => {
                    if (episodeVideoSource !== source) return;
                    console.warn("[MiniPlayer] Podcast video preview failed to play:", error);
                    releaseEpisodeVideo();
                    failedEpisodeVideoSource = source;
                    failedEpisodeVideoUri = uri;
                    warnEpisodeVideoCaptureUnavailable(uri, "captured video could not play");
                });
            }
        } catch (error) {
            capturedStream?.getTracks().forEach(track => track.stop());
            failedEpisodeVideoSource = source;
            failedEpisodeVideoUri = uri;
            console.warn("[MiniPlayer] Podcast video preview capture failed:", error);
            warnEpisodeVideoCaptureUnavailable(uri, "capture failed");
        }
    }

    function cleanupPiPResources() {
        stopLyricsAdapter();
        releaseEpisodeVideo();
        clearQueueDrag(true);
        const resources = pipResources;
        pipResources = null;
        resources?.cleanup();
        rafId = null;
        progressTimerId = null;
        isUserSeeking = false;
        isAdjustingVolume = false;
        lastUpcomingKey = null;
        queueOpen = false;
        lastQueueKey = null;
        queueMenuEl = null;
        queueMenuDisposers = [];
        queueSelectionMode = false;
        queueSelectedItems.clear();
        queueBulkConfirm = false;
        queueBulkRemoving = false;
        queueRenderDisposers = [];
        queueRowDisposers.clear();
        renderedQueueItems = null;
        queueHeadRemoval?.animation.cancel();
        queueHeadRemoval = null;
        queueDragDisposers = [];
        queueDragState = null;
        queueRenderGeneration++;
        lastFormattedTime = "";
        lastSliderValue = -1;
        lastMarqueeKey = "";
    }

    function safeSetTimeout(fn, ms) {
        if (!isPiPWindowOpen() || !pipResources) return null;
        return pipResources.setTimeout(fn, ms);
    }

    function safeClearTimeout(id) {
        if (id !== null && id !== undefined) {
            pipResources?.clearTimeout(id);
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
        toggleShortcut: { code: "KeyM", key: "M", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false },
        clickToOpen: true,       // click title/artist to open album/artist page
        dynamicResize: false,    // experimental: free window resizing, the layout adapts to the size
        showUpcoming: true,      // Show the next playback-queue item in the top bar
        replaceNative: true,     // Spotify's own mini player button opens this player instead
        modes: { standard: true, compact: true, mini: true }  // which modes you can switch between
    };

    const clampNum = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };

    function normalizeToggleShortcut(shortcut) {
        const fallback = DEFAULT_SETTINGS.toggleShortcut;
        if (!shortcut || typeof shortcut !== "object") return { ...fallback };
        const code = typeof shortcut.code === "string" ? shortcut.code.trim() : "";
        const key = typeof shortcut.key === "string" ? shortcut.key : "";
        const hasModifier = !!(shortcut.ctrlKey || shortcut.altKey || shortcut.shiftKey || shortcut.metaKey);
        if (!code || !key || ["Control", "Alt", "Shift", "Meta"].includes(key) || !hasModifier) {
            return { ...fallback };
        }
        return {
            code,
            key,
            ctrlKey: !!shortcut.ctrlKey,
            altKey: !!shortcut.altKey,
            shiftKey: !!shortcut.shiftKey,
            metaKey: !!shortcut.metaKey
        };
    }

    function formatToggleShortcut(shortcut = settings.toggleShortcut) {
        const parts = [];
        if (shortcut.ctrlKey) parts.push("Ctrl");
        if (shortcut.altKey) parts.push("Alt");
        if (shortcut.shiftKey) parts.push("Shift");
        if (shortcut.metaKey) parts.push("Meta");
        const key = shortcut.key === " "
            ? "Space"
            : shortcut.key.length === 1
                ? shortcut.key.toUpperCase()
                : shortcut.key.replace(/^Arrow/, "Arrow ");
        parts.push(key);
        return parts.join(" + ");
    }

    function shortcutMatchesEvent(event, shortcut = settings.toggleShortcut) {
        return (event.code || event.key) === shortcut.code
            && event.ctrlKey === shortcut.ctrlKey
            && event.altKey === shortcut.altKey
            && event.shiftKey === shortcut.shiftKey
            && event.metaKey === shortcut.metaKey;
    }

    function cloneDefaultSettings() {
        return {
            ...DEFAULT_SETTINGS,
            toggleShortcut: { ...DEFAULT_SETTINGS.toggleShortcut },
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
        s.toggleShortcut = normalizeToggleShortcut(s.toggleShortcut);
        ["autoFade", "rememberPosition", "scrollAdjust", "clickToOpen", "showUpcoming", "replaceNative", "dynamicResize"].forEach(k => { s[k] = !!s[k]; });
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

    function saveMode(mode) {
        try {
            localStorage.setItem(MODE_KEY, mode);
        } catch (err) {
            console.warn("[MiniPlayer] Could not save mode:", err);
        }
    }

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
        let m;
        try {
            m = localStorage.getItem(MODE_KEY);
            if (!MODES.includes(m)) {
                // Older versions only knew compact on/off
                m = localStorage.getItem("spicetify_miniplayer_compact") === "true" ? "compact" : "standard";
            }
        } catch (err) {
            console.warn("[MiniPlayer] Could not load saved mode:", err);
        }
        const list = enabledModes();
        return list.includes(m) ? m : list[0];
    }

    currentMode = loadMode();

    // Fixed Dimensions: strictly locked to prevent expansion/stretching
    const STANDARD_WIDTH = 360;
    const STANDARD_HEIGHT = 185;
    const COMPACT_WIDTH = 440;
    const COMPACT_HEIGHT = 82;
    // Mini mode: title + controls only
    const MINI_WIDTH = 360;
    const MINI_HEIGHT = 48;
    // Top bar above the card: holds the queue button and optional next-track text
    const UPCOMING_BAR_HEIGHT = 26;
    // Keep the queue window at 75% of its original 260px panel plus the 26px top bar.
    const QUEUE_PANEL_HEIGHT = Math.round((260 + UPCOMING_BAR_HEIGHT) * 0.75) - UPCOMING_BAR_HEIGHT;
    // Experimental dynamic resizing
    const PROGRESS_STEPS = 10000; // progress slider resolution: about 1 s per step even on a 3 hour episode
    const SIZE_KEY = "spicetify_miniplayer_size";
    const FLUID_MIN_WIDTH = 240;
    const FLUID_MIN_HEIGHT = 51;
    const FLUID_QUEUE_MIN_HEIGHT = QUEUE_PANEL_HEIGHT + UPCOMING_BAR_HEIGHT; // window grows to this while the queue is open
    const FLUID_MAX_WIDTH = 1536;  // Chrome's ceiling for a Document PiP window
    const FLUID_MAX_HEIGHT = 863;
    const FLUID_SHRINK_FACTOR = 1.25; // the shrink button appears once the window is this much bigger than the biggest enabled mode
    const FLUID_ART_MIN_HEIGHT = 290; // card height above which the big album-art layout kicks in

    // SVG Icons
    const ICONS = {
        more: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="2.5" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13.5" cy="8" r="1.5"/></svg>`,
        queue: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z"/></svg>`,
        mini: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M1.5 5h13A1.5 1.5 0 0 1 16 6.5v3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 9.5v-3A1.5 1.5 0 0 1 1.5 5zm0 1.5a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V7a.5.5 0 0 0-.5-.5h-13z"/></svg>`,
        shrink: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10h4v4M14 6h-4V2M10 6l4-4M6 10l-4 4"/></svg>`,
        gear: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path fill-rule="evenodd" d="M8 3.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zM8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(45 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(90 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(135 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(180 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(225 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(270 8 8)"/><rect x="6.9" y="0.8" width="2.2" height="3.2" rx="0.6" transform="rotate(315 8 8)"/></svg>`,
        miniplayer: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h10"/><rect width="20" height="14" x="2" y="3" rx="2"/></svg>`,
        play: `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"/></svg>`,
        pause: `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"/></svg>`,
        prev: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.576a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z"/></svg>`,
        next: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.106A.7.7 0 0 0 1 1.712v12.576a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z"/></svg>`,
        shuffle: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c.9 0 1.745.405 2.308 1.077l1.724 2.056-.99.832L1.936 4.195A2.25 2.25 0 0 0 .39 3.5zm12.76 7.422a.75.75 0 0 1 1.06 1.06L11.39 14.805a.75.75 0 0 1-1.06-1.06l1.439-1.439h-1.61a3.75 3.75 0 0 1-2.872-1.34l-1.724-2.056.99-.832 1.498 1.787a2.25 2.25 0 0 0 1.724.805h1.948l-1.439-1.44z"/></svg>`,
        repeat: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z"/></svg>`,
        volumeHigh: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>`,
        volumeMedium: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/></svg>`,
        volumeMute: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z"/><path d="m16.5 14.5 5-5"/><path d="m16.5 9.5 5 5"/></svg>`,
        compact: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M1.5 1h13A1.5 1.5 0 0 1 16 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 13.5v-11A1.5 1.5 0 0 1 1.5 1zm0 1.5a.5.5 0 0 0-.5.5v2h14V3a.5.5 0 0 0-.5-.5h-13zM15 6H1v7.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V6z"/></svg>`,
        expand: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M2.5 1A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 13.5 1h-11zm0 1.5h11a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"/></svg>`,
        close: `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854z"/></svg>`,
        lyrics: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12"/><path d="M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5"/><circle cx="16" cy="7" r="5"/></svg>`
    };

    // The icon shown for each mode (the cover / mode button shows the mode you'd switch TO)
    const MODE_ICONS = { standard: ICONS.expand, compact: ICONS.compact, mini: ICONS.mini };

    // Pushes current settings into an open mini player window
    function applySettings() {
        syncPlaybarButtons(); // "Replace Spotify's mini player" applies even when our window is closed
        updatePlaybarShortcutLabel();
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        doc.documentElement.style.setProperty("--idle-opacity", String(settings.idleOpacity));
        doc.body.classList.toggle("links-off", !settings.clickToOpen);
        if (!settings.autoFade) doc.body.classList.remove("idle");
        const wasFluid = doc.body.classList.contains("fluid");
        doc.body.classList.toggle("fluid", !!settings.dynamicResize);
        if (settings.dynamicResize) applyFluidLayout(true);
        else if (wasFluid) leaveFluidLayout();
        refreshModeUi();
        lastUpcomingKey = null; // lets the "Show next song" setting apply instantly
        updateUpcomingBar();
    }

    function updatePlaybarShortcutLabel() {
        const button = document.getElementById("miniplayer-playbar-btn");
        if (!button) return;
        const label = `Mini Player (${formatToggleShortcut()})`;
        button.setAttribute("aria-label", label);
        button.title = label;
        if (typeof button._tippy?.setContent === "function") button._tippy.setContent(label);
    }

    // Updates the cover's hover icon, the Mini-mode button and their tooltips for the next mode
    function refreshModeUi() {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        const next = nextMode();
        const item = playerState.currentTrack;
        const isEpisode = item?.uri?.startsWith("spotify:episode:")
            || item?.type === "episode";
        const canExpandPodcast = settings.dynamicResize
            && isEpisode
            && (pipWindow.innerWidth < 690 || pipWindow.innerHeight < 420);
        if (canExpandPodcast) {
            const title = "Expand podcast video";
            doc.querySelector(".cover-container")?.setAttribute("title", title);
            const modeIcon = doc.getElementById("cover-mode-icon");
            if (modeIcon) modeIcon.innerHTML = ICONS.expand;
            return;
        }
        // Only one usable mode: nothing to switch to, so hide the switch affordances
        doc.body.classList.toggle("single-mode", next === currentMode || !!settings.dynamicResize);
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
            .mp-shortcut-control { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
            .mp-shortcut-status { max-width: 180px; color: #a7a7a7; font-size: 10px; line-height: 1.3; text-align: right; }
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

        const shortcutControl = () => {
            const wrap = h("div", "mp-shortcut-control");
            const button = h("button", "mp-btn small", formatToggleShortcut());
            const status = h("span", "mp-shortcut-status", "");
            let recording = false;
            button.type = "button";
            button.setAttribute("aria-label", `Change mini player shortcut, currently ${formatToggleShortcut()}`);
            status.setAttribute("aria-live", "polite");

            const stopRecording = (message) => {
                recording = false;
                button.textContent = formatToggleShortcut();
                button.setAttribute("aria-label", `Change mini player shortcut, currently ${formatToggleShortcut()}`);
                status.textContent = message;
            };
            button.addEventListener("click", () => {
                recording = true;
                button.textContent = "Press keys…";
                button.setAttribute("aria-label", "Press a key combination; Escape cancels");
                status.textContent = "Include a modifier key. Escape cancels.";
            });
            button.addEventListener("keydown", event => {
                if (!recording) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") {
                    stopRecording("Shortcut change canceled.");
                    return;
                }
                if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
                    status.textContent = "Now press a non-modifier key.";
                    return;
                }
                if (!(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)) {
                    status.textContent = "Include Ctrl, Alt, Shift, or Meta.";
                    return;
                }
                const code = event.code && event.code !== "Unidentified" ? event.code : event.key;
                if (!code || code === "Unidentified") {
                    status.textContent = "That key could not be recognized. Try another.";
                    return;
                }

                settings.toggleShortcut = normalizeToggleShortcut({
                    code,
                    key: event.key,
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey
                });
                saveSettings();
                updatePlaybarShortcutLabel();
                stopRecording(`Shortcut set to ${formatToggleShortcut()}.`);
            });
            wrap.appendChild(button);
            wrap.appendChild(status);
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
                    if (!next[currentMode]) {
                        currentMode = MODES.find(mode => next[mode]);
                        saveMode(currentMode);
                        if (isPiPWindowOpen()) applyModeLayout();
                    }
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
            lastSavedPos = isPiPWindowOpen() ? `${pipWindow.screenX},${pipWindow.screenY}` : "";
            Spicetify.showNotification("Saved window position cleared");
        });
        const posControls = h("div", "mp-inline");
        posControls.appendChild(resetPos);
        posControls.appendChild(toggle("rememberPosition"));
        row("Remember window position", "Reopen the mini player where you left it.", posControls);

        section("Controls");
        row("Mini player shortcut", "Click the button, then press a key combination with a modifier. Escape cancels.",
            shortcutControl());
        row("Scroll to adjust", "Scroll over the timeline to seek, anywhere else to change volume.", toggle("scrollAdjust"));
        row("Seek step", "Seconds per scroll notch over the timeline.",
            slider("seekStep", 1, 30, 1, v => v, v => v, v => `${v}s`));
        row("Volume step", "Percent per scroll notch.",
            slider("volumeStep", 1, 20, 1, v => v, v => v, v => `${v}%`));
        row("Click title / artist to open", "Opens the album or artist page in Spotify.", toggle("clickToOpen"));

        section("Spotify integration");
        row("Replace Spotify's mini player",
            "Spotify's own and SpicyLyrics' Open in Miniplayer buttons, including episode video controls, open this player instead. Turn off to restore Spotify's native mini player. "
            + (findNativeMiniplayerButtons().length > 0
                ? "Spotify's button detected."
                : "Spotify's button wasn't found (Spotify may have changed it), so this extension's own playbar button is shown instead."),
            toggle("replaceNative"));

        section("Top bar");
        row("Show next song",
            "Shows the first upcoming track from the playback queue in the top bar.",
            toggle("showUpcoming"));

        section("Experimental");
        row("Dynamic resizing",
            "Resize the window freely and everything inside moves with it: the layout switches between Mini, Compact and Standard, scales up to fit, and shows a large album-art layout when tall. Replaces click-to-switch modes. A shrink button appears in the top bar when the window gets large.",
            toggle("dynamicResize"));

        const footer = h("div", "mp-footer");
        const isOpen = isPiPWindowOpen();
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

            const modalHeight = Math.max(240, Math.min(460, availH > 0 ? availH : 460, window.innerHeight * 0.62));
            root.style.height = `${modalHeight}px`;
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
        const hours = Math.floor(totalSec / 3600);
        const min = Math.floor((totalSec % 3600) / 60);
        const sec = totalSec % 60;
        const secText = sec < 10 ? `0${sec}` : `${sec}`;
        // Episodes and audiobooks run for hours: 1:23:45 rather than 83:45
        return hours > 0
            ? `${hours}:${min < 10 ? "0" : ""}${min}:${secText}`
            : `${min}:${secText}`;
    }

    function getTrackMetadata() {
        const item = playerState.currentTrack;
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
        // Podcast episodes have no artists: show the podcast's name instead, linking to its show page
        const isEpisode = (item.uri || "").startsWith("spotify:episode:") || item.type === "episode";
        let showUri = "";
        if (!artistList.length && isEpisode) {
            const showName = item.show?.name || item.metadata?.show_name || item.metadata?.album_title
                || item.album?.name || item.metadata?.artist_name || "";
            showUri = item.show?.uri || item.metadata?.show_uri || item.metadata?.album_uri || item.album?.uri || "";
            if (showName) artistList.push({ name: showName, uri: showUri });
        }
        const artists = artistList.length ? artistList.map(a => a.name).join(", ") : "Unknown Artist";
        const album = item.album?.name || item.metadata?.album_title || "";
        const cover = normalizeImageUrl(
            item.metadata?.image_xlarge_url ||
            item.metadata?.image_large_url ||
            item.metadata?.image_url ||
            item.images?.[0]?.url ||
            ""
        );

        return {
            title,
            artist: artists,
            album,
            albumUri: item.album?.uri || item.metadata?.album_uri || showUri || "",
            artistList,
            cover,
            duration: playerState.duration || (item.duration?.milliseconds || 0)
        };
    }

    // ---------- Experimental: dynamic resizing ----------
    // With "Dynamic resizing" on, the window is freely resizable. Its size picks the layout
    // (Mini / Compact / Standard, plus a big album-art layout when tall) and sets --s (scale)
    // and --art (cover size), so everything inside the card moves and grows to fit.

    // Per-window bookkeeping: a freshly opened window starts with a clean slate
    function fluidState() {
        if (fluid.win !== pipWindow) {
            fluid.win = pipWindow;
            fluid.sig = "";
            fluid.prevSize = null;
        }
        return fluid;
    }

    // Size to open at: the last size you resized to when dynamic resizing is on, else the mode's fixed size
    function getOpenSize() {
        if (settings.dynamicResize) {
            try {
                const saved = JSON.parse(localStorage.getItem(SIZE_KEY) || "null");
                if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
                    return {
                        width: clampNum(saved.w, FLUID_MIN_WIDTH, FLUID_MAX_WIDTH, STANDARD_WIDTH),
                        height: clampNum(saved.h, FLUID_MIN_HEIGHT, FLUID_MAX_HEIGHT, STANDARD_HEIGHT + UPCOMING_BAR_HEIGHT)
                    };
                }
            } catch (err) {}
        }
        return getTargetSize();
    }

    function saveWindowSize() {
        if (!settings.dynamicResize || !isPiPWindowOpen() || queueOpen) return;
        if (Date.now() < positionSaveEnabledAt) return;
        const w = pipWindow.innerWidth;
        const h = pipWindow.innerHeight;
        // A closing window reports 0x0, so only real sizes are stored
        if (!(w >= FLUID_MIN_WIDTH) || !(h >= FLUID_MIN_HEIGHT)) return;
        try {
            localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }));
        } catch (err) {}
    }

    // Which of the three layouts fits this window (w = window width, ch = height left for the card)
    function pickFluidMode(w, ch) {
        let want;
        if (ch < 78 || (ch < 150 && w < 400)) want = "mini";
        else if (ch < 150) want = "compact";
        else want = "standard";
        const list = enabledModes();
        if (list.includes(want)) return want;
        // That layout is switched off in settings: use the closest one that's still enabled
        const wi = MODES.indexOf(want);
        return list.slice().sort((a, b) => Math.abs(MODES.indexOf(a) - wi) - Math.abs(MODES.indexOf(b) - wi))[0];
    }

    function applyFluidLayout(force = false) {
        if (!isPiPWindowOpen() || !settings.dynamicResize || queueOpen) return;
        const state = fluidState();
        const doc = pipWindow.document;
        syncPodcastVideoLayout();
        refreshModeUi();
        const w = pipWindow.innerWidth;
        // Under 74px tall the top bar would leave the card less than the 48px Mini needs, so the bar steps aside
        const slim = pipWindow.innerHeight < UPCOMING_BAR_HEIGHT + MINI_HEIGHT;
        const ch = pipWindow.innerHeight - (slim ? 0 : UPCOMING_BAR_HEIGHT); // the height the card actually gets
        if (!(w > 0) || !(ch > 0)) return;

        const mode = pickFluidMode(w, ch);
        const art = mode === "standard" && ch >= FLUID_ART_MIN_HEIGHT;
        const base = mode === "mini" ? [MINI_WIDTH, MINI_HEIGHT]
            : mode === "compact" ? [COMPACT_WIDTH, COMPACT_HEIGHT]
            : [STANDARD_WIDTH, STANDARD_HEIGHT];
        // Scale relative to the layout's design size (never below 1: the layouts are already tight)
        const raw = art ? w / STANDARD_WIDTH : Math.min(w / base[0], ch / base[1]);
        const s = Math.round(Math.min(art ? 1.5 : 1.8, Math.max(1, raw)) * 20) / 20;
        const lyricsScale = Math.round(Math.min(2.5, Math.max(1, raw)) * 20) / 20;
        // Album art takes whatever height is left above the title, timeline and controls
        const artSize = art ? Math.round(Math.max(64, Math.min(w - 56, ch - 165 * s, 420))) : 0;

        // Controls follow the window. Standard/art: the transport row is exactly centered, volume hugs the right
        // and shows a slider only when its side has room (otherwise just the mute icon). Compact/Mini: once the
        // window is wide enough for it, the controls sit in the middle with the title left and close right.
        const side = (w - 28 - 168 * s) / 2; // room on each side of the transport row
        const volW = Math.floor(Math.min(160, side - 22 * s - 14));
        const iconOnly = mode === "standard" && volW < 40;
        const ctr = (mode === "compact" && w >= 240 + 300 * s) || (mode === "mini" && w >= 260 + 160 * s);
        // Narrow: no room for an inline slider, so the speaker button opens the volume row (as in Compact)
        const miniVol = mode === "mini";
        // Absolute minimum (240 wide): drop shuffle/repeat so title, transport, volume and close still fit
        const tiny = mode === "mini" && w < 300;
        // Big window: offer a button that shrinks it back to the biggest mode enabled in settings
        const shrinkTarget = biggestEnabledMode();
        const shrinkSize = modeWindowSize(shrinkTarget);
        const canShrink = pipWindow.innerWidth >= shrinkSize.width * FLUID_SHRINK_FACTOR
            || pipWindow.innerHeight >= shrinkSize.height * FLUID_SHRINK_FACTOR;

        const sig = `${mode}|${art}|${s}|${lyricsScale}|${artSize}|${ctr}|${iconOnly}|${volW}|${miniVol}|${tiny}|${slim}|${canShrink}|${shrinkTarget}`;
        if (!force && sig === state.sig) return;
        state.sig = sig;

        if (mode !== currentMode) {
            currentMode = mode; // deliberately not saved: the size decides, your saved mode stays as it was
            applyModeLayout();
        }
        doc.body.classList.toggle("art-layout", art);
        doc.documentElement.style.setProperty("--s", String(s));
        doc.documentElement.style.setProperty("--lyrics-s", String(lyricsScale));
        doc.documentElement.style.setProperty("--art", `${artSize}px`);
        doc.documentElement.style.setProperty("--vol-w", `${Math.max(40, volW)}px`);
        doc.body.classList.toggle("ctr-controls", ctr);
        doc.body.classList.toggle("vol-icon-only", iconOnly);
        doc.body.classList.toggle("mini-vol", miniVol);
        doc.body.classList.toggle("tiny", tiny);
        doc.body.classList.toggle("slim", slim);
        doc.body.classList.toggle("can-shrink", canShrink);
        doc.getElementById("btn-shrink")?.setAttribute("title", `Shrink to ${MODE_LABELS[shrinkTarget]} size`);
        doc.getElementById("btn-volume-icon")?.setAttribute("title", iconOnly ? "Volume" : "Mute / Unmute");
        // Layout changed so the volume row isn't available any more: close it
        if (mode !== "compact" && !iconOnly && !miniVol) {
            doc.getElementById("volume-popup")?.classList.remove("open");
            doc.body.classList.remove("volume-open");
        }
        // Font sizes just changed, so the title may now overflow (or no longer overflow)
        safeSetTimeout(() => updateMarqueeEffect(true), 50);
    }

    // Fixed window size (content area, top bar included) of a mode
    function modeWindowSize(mode) {
        const base = mode === "mini" ? [MINI_WIDTH, MINI_HEIGHT]
            : mode === "compact" ? [COMPACT_WIDTH, COMPACT_HEIGHT]
            : [STANDARD_WIDTH, STANDARD_HEIGHT];
        return { width: base[0], height: base[1] + UPCOMING_BAR_HEIGHT };
    }

    // The biggest mode left enabled in settings (MODES is ordered biggest first)
    function biggestEnabledMode() {
        return enabledModes()[0];
    }

    // Shrink button: resize the window down to the biggest enabled mode's fixed size
    function shrinkToBiggestMode() {
        if (!isPiPWindowOpen()) return;
        const { width, height } = modeWindowSize(biggestEnabledMode());
        try {
            pipWindow.resizeTo(width + pipWindowFrameWidth, height + pipWindowFrameHeight);
        } catch (err) {
            console.warn("[MiniPlayer] Unable to shrink the window:", err);
            Spicetify.showNotification("Couldn't resize the window", true);
        }
    }

    function expandPodcastVideoPreview() {
        if (!isPiPWindowOpen() || !settings.dynamicResize) return false;
        const item = playerState.currentTrack;
        const isEpisode = item?.uri?.startsWith("spotify:episode:")
            || item?.type === "episode";
        if (!isEpisode) return false;
        if (pipWindow.innerWidth >= 690 && pipWindow.innerHeight >= 420) return false;
        try {
            pipWindow.resizeTo(690 + pipWindowFrameWidth, 420 + pipWindowFrameHeight);
            return true;
        } catch (err) {
            console.warn("[MiniPlayer] Unable to expand the podcast video:", err);
            Spicetify.showNotification("Couldn't expand the podcast video", true);
            return false;
        }
    }

    // Turning dynamic resizing off while the window is open: back to the fixed, saved mode
    function leaveFluidLayout() {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        doc.body.classList.remove("fluid", "art-layout", "ctr-controls", "vol-icon-only", "mini-vol", "tiny", "slim", "can-shrink");
        doc.documentElement.style.removeProperty("--s");
        doc.documentElement.style.removeProperty("--lyrics-s");
        doc.documentElement.style.removeProperty("--art");
        doc.documentElement.style.removeProperty("--vol-w");
        const state = fluidState();
        state.sig = "";
        state.prevSize = null;
        currentMode = loadMode();
        applyModeLayout(); // also snaps the window back to that mode's fixed size
    }

    // Compact and Mini grow to fit the reduced queue panel while it is open.
    function getTargetSize() {
        const SIZES = {
            standard: { width: STANDARD_WIDTH, height: STANDARD_HEIGHT },
            compact: { width: COMPACT_WIDTH, height: COMPACT_HEIGHT },
            mini: { width: MINI_WIDTH, height: MINI_HEIGHT }
        };
        const size = SIZES[currentMode];
        const height = queueOpen && currentMode !== "standard"
            ? Math.max(size.height, QUEUE_PANEL_HEIGHT) + UPCOMING_BAR_HEIGHT
            : size.height + UPCOMING_BAR_HEIGHT;
        return {
            width: size.width,
            height
        };
    }

    function updateUpcomingBar() {
        if (!isPiPWindowOpen()) return;
        const active = settings.showUpcoming;
        const nextTrack = active ? playerState.queue[0] : null;
        const title = nextTrack?.title || "";
        const artist = nextTrack?.artist || "";
        const key = `${active}\u0000${title}\u0000${artist}`;
        if (key === lastUpcomingKey) return;
        lastUpcomingKey = key;

        const doc = pipWindow.document;
        const bar = doc.getElementById("upcoming-bar");
        const text = doc.getElementById("upcoming-text");
        const titleEl = doc.getElementById("upcoming-title");
        const artistEl = doc.getElementById("upcoming-artist");
        if (!bar || !text || !titleEl || !artistEl) return;
        bar.classList.toggle("no-next", !active);

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

    // ---------- Queue ----------
    function normalizeImageUrl(raw) {
        if (raw.startsWith("spotify:image:")) return `https://i.scdn.co/image/${raw.split(":")[2]}`;
        return raw.startsWith("http") ? raw : "";
    }

    function queueImageUrl(md) {
        return normalizeImageUrl(md.image_small_url || md.image_url || md.image_large_url || md.image_xlarge_url || "");
    }

    function sleep(ms) {
        return pipResources ? pipResources.delay(ms) : Promise.resolve(false);
    }

    function queueEntryParts(entry) {
        const track = entry?.contextTrack || entry || {};
        return {
            uid: String(track.uid || ""),
            uri: String(track.uri || ""),
            source: String(entry?.contextTrack ? entry.provider || "" : entry?.fromQueue ? "queue" : "context"),
            removed: !!(entry?.removed && entry.removed.length)
        };
    }

    function parseSpotifyResource(uri) {
        const match = /^spotify:(track|episode|album|artist|playlist|show):([A-Za-z0-9]+)$/.exec(String(uri || ""));
        return match ? { type: match[1], id: match[2] } : null;
    }

    function shareableSpotifyLink(uri) {
        const resource = parseSpotifyResource(uri);
        return resource && (resource.type === "track" || resource.type === "episode")
            ? `https://open.spotify.com/${resource.type}/${resource.id}`
            : "";
    }

    function queueStructureSignature(entries) {
        return JSON.stringify(entries.map(entry => {
            const { uid, uri, source, removed } = queueEntryParts(entry);
            return [uid, uri, source, removed];
        }));
    }

    function queueActiveStructureSignature(entries, excludedIndex = -1) {
        return JSON.stringify(entries.reduce((active, entry, index) => {
            if (index === excludedIndex) return active;
            const parts = queueEntryParts(entry);
            if (!parts.removed) active.push([parts.uid, parts.uri, parts.source]);
            return active;
        }, []));
    }

    function queueOccurrenceIdentity(entry, index, entries, uidCounts) {
        const parts = queueEntryParts(entry);
        const uidOccurrences = parts.uid ? (uidCounts?.get(parts.uid) ?? 1) : 0;
        if (parts.uid && uidOccurrences === 1) return `uid:${parts.uid}`;

        const neighbor = candidate => {
            if (!candidate) return "";
            const p = queueEntryParts(candidate);
            return p.uid ? `uid:${p.uid}` : `${p.source}:${p.uri}`;
        };
        return JSON.stringify([
            "position",
            index,
            parts.uri,
            parts.source,
            neighbor(entries[index - 1]),
            neighbor(entries[index + 1])
        ]);
    }

    function resolveQueueOccurrence(item, entries, revision, { removal = false } = {}) {
        if (!Array.isArray(entries)) return { status: "unsupported", reason: "Queue snapshot is unavailable" };
        if (!item?.uri) return { status: "not-found", reason: "Queue item has no URI" };

        if (item.uid) {
            const matches = [];
            entries.forEach((entry, index) => {
                if (queueEntryParts(entry).uid === String(item.uid)) matches.push({ entry, index });
            });
            if (!matches.length) return { status: "not-found", reason: "Queue item is no longer present" };
            if (matches.length !== 1) return { status: "ambiguous", reason: "Spotify returned a duplicate queue UID" };
            const match = matches[0];
            if (queueEntryParts(match.entry).removed) {
                return { status: "not-found", reason: "Queue item has already been removed" };
            }
            if (queueEntryParts(match.entry).uri !== item.uri) {
                return { status: "conflict", reason: "Queue UID now points to a different item" };
            }
            if (item.fromQueue !== (queueEntryParts(match.entry).source === "queue")) {
                return { status: "not-found", reason: "Queue item source changed" };
            }
            return { status: "success", ...match };
        }

        const currentSignature = queueStructureSignature(entries);
        if (!item.queueSnapshotSignature || currentSignature !== item.queueSnapshotSignature) {
            return { status: "conflict", reason: "Queue changed since this item was displayed" };
        }
        if (item.queueRevision != null && revision != null && item.queueRevision !== revision) {
            return { status: "conflict", reason: "Queue revision changed since this item was displayed" };
        }

        const index = item.queueIndex;
        const entry = Number.isInteger(index) ? entries[index] : null;
        if (!entry || queueOccurrenceIdentity(entry, index, entries) !== item.identity) {
            return { status: "not-found", reason: "Queue occurrence could not be matched" };
        }
        const parts = queueEntryParts(entry);
        if (parts.removed) return { status: "not-found", reason: "Queue item has already been removed" };
        if (parts.uri !== item.uri || item.fromQueue !== (parts.source === "queue")) {
            return { status: "not-found", reason: "Queue item source or URI changed" };
        }
        if (removal && entries.filter(candidate => queueEntryParts(candidate).uri === item.uri).length > 1) {
            return { status: "ambiguous", reason: "Spotify's removal API cannot distinguish duplicate URIs without a queue UID" };
        }
        return { status: "success", entry, index };
    }

    async function applyQueueReorder(item, destination) {
        const eligibilityReason = SpotifyAdapter.canMoveToNext(item);
        if (eligibilityReason) return { status: "unsupported", reason: eligibilityReason };

        const queue = Spicetify.Platform?.PlayerAPI?._queue;
        const client = queue?._client;
        const state = queue?._queue;
        const entries = state?.nextTracks;
        const revision = state?.queueRevision;
        if (!Array.isArray(entries)) return { status: "unsupported", reason: "Spotify's internal queue snapshot is unavailable" };
        if (revision == null) return { status: "unsupported", reason: "Spotify's queue revision is unavailable; reordering cannot be guarded safely" };

        const source = resolveQueueOccurrence(item, entries, revision);
        if (source.status !== "success") return source;
        if (queueEntryParts(source.entry).source !== "queue") {
            return { status: "unsupported", reason: "Only manually queued items can be reordered" };
        }

        let destinationIndex = destination.index;
        if (destination.item) {
            const target = resolveQueueOccurrence(destination.item, entries, revision);
            if (target.status !== "success") return target;
            if (target.index === source.index) return { status: "already-positioned" };
            const placementOffset = destination.placement === "after" ? 1 : 0;
            destinationIndex = target.index - (source.index < target.index ? 1 : 0) + placementOffset;
        }
        if (!Number.isInteger(destinationIndex)) {
            return { status: "unsupported", reason: "The requested queue position is invalid" };
        }

        const nextTracks = [...entries];
        const [track] = nextTracks.splice(source.index, 1);
        destinationIndex = Math.max(0, Math.min(destinationIndex, nextTracks.length));
        if (destinationIndex === source.index) {
            return { status: destination.index === 0 ? "already-next" : "already-positioned" };
        }
        nextTracks.splice(destinationIndex, 0, track);

        const beforeSignature = queueStructureSignature(entries);
        const latest = queue?._queue;
        if (!Array.isArray(latest?.nextTracks)) {
            return { status: "unsupported", reason: "Spotify's internal queue snapshot disappeared" };
        }
        if (latest.queueRevision !== revision || queueStructureSignature(latest.nextTracks) !== beforeSignature) {
            return { status: "conflict", reason: "Queue changed before the reorder could be applied" };
        }
        try {
            const result = await client.setQueue({
                nextTracks,
                prevTracks: latest.prevTracks,
                queueRevision: revision
            });
            if (result === false) return { status: "failed", reason: "Spotify rejected the reorder request" };
        } catch (error) {
            console.warn("[MiniPlayer] Queue setQueue API failed:", error?.message || "unknown error");
            return { status: "conflict", reason: "Spotify rejected the queue revision or reorder request" };
        }

        const expectedSignature = queueStructureSignature(nextTracks);
        let verified = false;
        for (let attempt = 0; attempt < 4; attempt++) {
            const current = queue?._queue?.nextTracks;
            if (Array.isArray(current) && queueStructureSignature(current) === expectedSignature) {
                verified = true;
                break;
            }
            if (attempt < 3) await sleep(100);
        }
        return { status: "success", verified };
    }

    const SpotifyAdapter = {
        async play(uri, options = {}) {
            const api = Spicetify.Platform?.PlayerAPI;
            if (typeof api?.play === "function") {
                return api.play({ uri, url: `context://${uri}` }, {}, options);
            }
            if (typeof Spicetify.Player?.playUri === "function") {
                return Spicetify.Player.playUri(uri, {}, options);
            }
            throw new Error("No play API available");
        },

        canPlay(item) {
            const uri = String(item?.uri || "");
            const resource = parseSpotifyResource(uri);
            const isLocalTrack = uri.startsWith("spotify:local:") && uri.length > "spotify:local:".length;
            if (!resource || (resource.type !== "track" && resource.type !== "episode")) {
                if (!isLocalTrack) return "This item type can't be played from the queue menu";
            }
            return typeof Spicetify.Platform?.PlayerAPI?.play === "function"
                || typeof Spicetify.Player?.playUri === "function"
                ? ""
                : "Spotify's playback API is unavailable";
        },

        canPlayNow(item) {
            if (!item?.fromQueue) return this.canPlay(item);
            const reorderReason = this.canMoveToNext(item);
            if (reorderReason) return reorderReason;
            return typeof Spicetify.Player?.next === "function"
                ? ""
                : "Spotify's Next playback action is unavailable";
        },

        canMoveToNext(item) {
            if (!item?.fromQueue) return "Only manually queued items can be reordered";
            if (item.uid && item.uidOccurrenceCount > 1) return "Spotify returned a duplicate queue UID for this item";
            if (!item.uid && (!item.identity || !item.queueSnapshotSignature || !Number.isInteger(item.queueIndex))) {
                return "This queue item has no safe occurrence identity";
            }
            const queue = Spicetify.Platform?.PlayerAPI?._queue;
            if (typeof queue?._client?.setQueue !== "function") return "Spotify's queue reorder API is unavailable";
            if (!Array.isArray(queue?._queue?.nextTracks)) return "Spotify's internal queue snapshot is unavailable";
            return queue._queue.queueRevision != null
                ? ""
                : "Spotify's queue revision is unavailable; reordering cannot be guarded safely";
        },

        canRemoveFromQueue(item) {
            const supported = typeof Spicetify.Platform?.PlayerAPI?.removeFromQueue === "function"
                || typeof Spicetify.removeFromQueue === "function"
            if (!supported) return "Spotify's queue removal API is unavailable";
            const { entries, revision } = this.getQueueSnapshot();
            const target = resolveQueueOccurrence(item, entries, revision, { removal: true });
            return target.status === "success" ? "" : target.reason;
        },

        canBulkRemoveFromQueue(item) {
            if (!item?.fromQueue) return "Bulk removal is limited to manually queued items";
            return this.canRemoveFromQueue(item);
        },

        canAddToQueue(item) {
            if (item?.fromQueue) return "This item is already in the queue";
            const resource = parseSpotifyResource(item?.uri);
            if (!resource || (resource.type !== "track" && resource.type !== "episode")) {
                return "Only tracks and episodes can be added to the queue";
            }
            return typeof Spicetify.addToQueue === "function"
                && typeof Spicetify.Player?.origin?._queue?.addToQueue === "function"
                ? ""
                : "Spotify's queue add API is unavailable";
        },

        canOpenSpotifyPage(uri, expectedTypes) {
            const resource = parseSpotifyResource(uri);
            if (!resource || !expectedTypes.includes(resource.type)) return "No valid Spotify page is available";
            return typeof Spicetify.Platform?.History?.push === "function"
                ? ""
                : "Spotify page navigation is unavailable";
        },

        getQueueSnapshot() {
            const state = Spicetify.Platform?.PlayerAPI?._queue?._queue;
            const entries = Array.isArray(state?.nextTracks) ? state.nextTracks : Spicetify.Queue?.nextTracks;
            return { entries, revision: state?.queueRevision ?? Spicetify.Queue?.queueRevision };
        },

        resolveQueueItem(item) {
            const { entries, revision } = this.getQueueSnapshot();
            return resolveQueueOccurrence(item, entries, revision);
        },

        async addToQueue(item) {
            const reason = this.canAddToQueue(item);
            if (reason) return { status: "unsupported", reason };
            const add = Spicetify.addToQueue;
            const target = this.resolveQueueItem(item);
            if (target.status !== "success") return target;
            try {
                const uri = queueEntryParts(target.entry).uri;
                const countManualMatches = entries => {
                    if (!Array.isArray(entries)) return null;
                    return entries.filter(entry => {
                        const parts = queueEntryParts(entry);
                        return !parts.removed && parts.source === "queue" && parts.uri === uri;
                    }).length;
                };
                const manualCounts = () => ({
                    internal: countManualMatches(Spicetify.Platform?.PlayerAPI?._queue?._queue?.nextTracks),
                    public: countManualMatches(Spicetify.Queue?.nextTracks)
                });
                const hasNewManualMatch = (before, current) => ["internal", "public"].some(source =>
                    before[source] != null && current[source] != null && current[source] > before[source]
                );
                const previousCounts = manualCounts();
                // Spicetify's queue helper forwards URI objects to Spotify's queue method.
                const result = await add([{ uri }]);
                if (result === false) {
                    for (let attempt = 0; attempt < 10; attempt++) {
                        if (hasNewManualMatch(previousCounts, manualCounts())) {
                            return { status: "success", verified: true };
                        }
                        if (attempt < 9) await sleep(100);
                    }
                    console.warn("[MiniPlayer] Queue add returned false and no new manual queue item appeared.", {
                        uriType: uri.split(":")[1] || "unknown",
                        before: previousCounts,
                        after: manualCounts()
                    });
                    return { status: "failed", reason: "Spotify rejected the queue add request" };
                }
                return { status: "success" };
            } catch (error) {
                const response = error?.response || error?.cause?.response;
                console.warn("[MiniPlayer] Queue add API threw:", {
                    name: error?.name || "",
                    message: error?.message || response?.data?.message || response?.body?.message || "unknown error",
                    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 6).join("\n") : "",
                    status: error?.status ?? error?.statusCode ?? response?.status ?? null,
                    statusText: error?.statusText || response?.statusText || "",
                    responseMessage: response?.data?.message || response?.body?.message || ""
                });
                return { status: "failed", reason: "Spotify's queue add request failed" };
            }
        },

        async removeFromQueue(item) {
            const api = Spicetify.Platform?.PlayerAPI;
            const remove = typeof api?.removeFromQueue === "function"
                ? api.removeFromQueue.bind(api)
                : typeof Spicetify.removeFromQueue === "function"
                    ? Spicetify.removeFromQueue
                    : null;
            if (!remove) return { status: "unsupported", reason: "Spotify removeFromQueue API is unavailable" };

            const { entries, revision } = this.getQueueSnapshot();
            const target = resolveQueueOccurrence(item, entries, revision, { removal: true });
            if (target.status !== "success") return target;
            const parts = queueEntryParts(target.entry);
            try {
                const result = await remove([{ uri: parts.uri, uid: parts.uid || undefined }]);
                if (result === false) return { status: "failed", reason: "Spotify rejected the remove request" };
            } catch (error) {
                console.warn("[MiniPlayer] Queue remove API failed:", error?.message || "unknown error");
                return { status: "failed", reason: "Spotify's remove request failed" };
            }

            const beforeUriCount = parts.uid
                ? 0
                : entries.filter(entry => {
                    const candidate = queueEntryParts(entry);
                    return !candidate.removed && candidate.uri === parts.uri;
                }).length;
            const stillQueued = () => {
                const latest = Spicetify.Platform?.PlayerAPI?._queue?._queue?.nextTracks
                    || Spicetify.Queue?.nextTracks;
                if (!Array.isArray(latest)) return null;
                return parts.uid
                    ? latest.some(entry => {
                        const candidate = queueEntryParts(entry);
                        return !candidate.removed && candidate.uid === parts.uid;
                    })
                    : latest.filter(entry => {
                        const candidate = queueEntryParts(entry);
                        return !candidate.removed && candidate.uri === parts.uri;
                    }).length >= beforeUriCount;
            };
            for (let attempt = 0; attempt < 4; attempt++) {
                if (stillQueued() === false) return { status: "success", verified: true };
                if (attempt < 3) await sleep(100);
            }
            return { status: "success", verified: false };
        },

        async removeManyFromQueue(items) {
            if (!Array.isArray(items) || !items.length) {
                return { status: "failed", succeeded: 0, failed: [{ reason: "No queue items are selected" }] };
            }
            const initial = this.getQueueSnapshot();
            if (!Array.isArray(initial.entries)) {
                return { status: "unsupported", succeeded: 0, failed: [{ reason: "Queue snapshot is unavailable" }] };
            }

            const failures = [];
            const targets = [];
            const seenTargets = new Set();
            for (const item of items) {
                if (!item?.fromQueue) {
                    failures.push({ item, reason: "Bulk removal is limited to manually queued items" });
                    continue;
                }
                const capabilityReason = this.canRemoveFromQueue(item);
                if (capabilityReason) {
                    failures.push({ item, reason: capabilityReason });
                    continue;
                }
                const resolved = resolveQueueOccurrence(item, initial.entries, initial.revision, { removal: true });
                if (resolved.status !== "success") {
                    failures.push({ item, reason: resolved.reason });
                    continue;
                }
                const parts = queueEntryParts(resolved.entry);
                const targetKey = parts.uid ? `uid:${parts.uid}` : `index:${resolved.index}`;
                if (seenTargets.has(targetKey)) {
                    failures.push({ item, reason: "The same queue occurrence was selected more than once" });
                    continue;
                }
                seenTargets.add(targetKey);
                targets.push({ item, uid: parts.uid, uri: parts.uri, index: resolved.index });
            }

            targets.sort((a, b) => b.index - a.index);
            let expectedSignature = queueActiveStructureSignature(initial.entries);
            let succeeded = 0;
            const succeededItems = [];
            for (let index = 0; index < targets.length; index++) {
                const target = targets[index];
                const current = this.getQueueSnapshot();
                if (!Array.isArray(current.entries)) {
                    failures.push({ item: target.item, reason: "Queue snapshot became unavailable" });
                    for (let pending = index + 1; pending < targets.length; pending++) {
                        failures.push({ item: targets[pending].item, reason: "Stopped because the queue snapshot is unavailable" });
                    }
                    break;
                }
                const currentSignature = queueActiveStructureSignature(current.entries);
                if (currentSignature !== expectedSignature) {
                    failures.push({ item: target.item, reason: "Queue changed during bulk removal; stopped to avoid removing the wrong item" });
                    for (let pending = index + 1; pending < targets.length; pending++) {
                        failures.push({ item: targets[pending].item, reason: "Stopped because the queue changed during bulk removal" });
                    }
                    break;
                }

                const uriMatches = current.entries.filter(entry => queueEntryParts(entry).uri === target.uri);
                if (!target.uid && uriMatches.length > 1) {
                    failures.push({ item: target.item, reason: "Duplicate URIs without queue IDs cannot be removed safely" });
                    continue;
                }
                const matches = [];
                current.entries.forEach((entry, entryIndex) => {
                    const parts = queueEntryParts(entry);
                    if (parts.removed || parts.source !== "queue" || parts.uri !== target.uri) return;
                    if (target.uid && parts.uid !== target.uid) return;
                    if (!target.uid && parts.uid) return;
                    matches.push({ entry, index: entryIndex });
                });
                if (matches.length !== 1) {
                    failures.push({
                        item: target.item,
                        reason: matches.length ? "Queue item identity is ambiguous" : "Queue item is no longer present"
                    });
                    continue;
                }

                const match = matches[0];
                const parts = queueEntryParts(match.entry);
                const currentItem = {
                    ...target.item,
                    uid: parts.uid || undefined,
                    uri: parts.uri,
                    fromQueue: true,
                    queueIndex: match.index,
                    queueRevision: current.revision,
                    identity: queueOccurrenceIdentity(match.entry, match.index, current.entries),
                    queueSnapshotSignature: queueStructureSignature(current.entries)
                };
                const result = await this.removeFromQueue(currentItem);
                const after = this.getQueueSnapshot();
                if (!Array.isArray(after.entries)) {
                    failures.push({ item: target.item, reason: "Queue could not be verified after removal" });
                    for (let pending = index + 1; pending < targets.length; pending++) {
                        failures.push({ item: targets[pending].item, reason: "Stopped because the queue could not be verified" });
                    }
                    break;
                }

                const afterSignature = queueActiveStructureSignature(after.entries);
                const expectedAfter = queueActiveStructureSignature(current.entries, match.index);
                if (afterSignature === expectedAfter) {
                    succeeded++;
                    succeededItems.push(target.item);
                    expectedSignature = expectedAfter;
                    continue;
                }
                if (afterSignature === currentSignature) {
                    failures.push({
                        item: target.item,
                        reason: result.status === "success"
                            ? "Spotify did not remove the selected item"
                            : result.reason || "Spotify rejected the remove request"
                    });
                    continue;
                }
                failures.push({ item: target.item, reason: "Queue changed during bulk removal; stopped to avoid removing the wrong item" });
                for (let pending = index + 1; pending < targets.length; pending++) {
                    failures.push({ item: targets[pending].item, reason: "Stopped because the queue changed during bulk removal" });
                }
                break;
            }

            return {
                status: failures.length ? (succeeded ? "partial" : "failed") : "success",
                succeeded,
                succeededItems,
                failed: failures,
                total: items.length
            };
        },

        moveToNext(item) {
            return applyQueueReorder(item, { index: 0 });
        },

        moveQueueItem(item, targetItem, placement) {
            if (placement !== "before" && placement !== "after") {
                return Promise.resolve({ status: "unsupported", reason: "Queue drop position is invalid" });
            }
            return applyQueueReorder(item, { item: targetItem, placement });
        },

        // `limit` keeps this cheap: a podcast show can have thousands of episodes queued, and the top bar
        // only needs the next one (the full list is only read while the queue panel is open)
        getQueue(limit = Infinity) {
            const queue = Spicetify.Queue;
            const next = Array.isArray(queue?.nextTracks) ? queue.nextTracks : [];
            const currentUid = queue?.track?.contextTrack?.uid;
            const revision = queue?.queueRevision ?? Spicetify.Platform?.PlayerAPI?._queue?._queue?.queueRevision;
            const snapshotSignature = limit === Infinity ? queueStructureSignature(next) : "";
            const uidCounts = new Map();
            if (limit === Infinity) {
                for (const track of next) {
                    const uid = queueEntryParts(track).uid;
                    if (uid) uidCounts.set(uid, (uidCounts.get(uid) || 0) + 1);
                }
            }
            const items = [];
            for (let queueIndex = 0; queueIndex < next.length; queueIndex++) {
                const track = next[queueIndex];
                const contextTrack = track?.contextTrack;
                if (!contextTrack || (track.removed && track.removed.length)
                    || (currentUid && contextTrack.uid === currentUid)) continue;
                const metadata = contextTrack.metadata || {};
                const names = [];
                for (let i = 0; ; i++) {
                    const name = metadata[i === 0 ? "artist_name" : `artist_name:${i}`];
                    if (!name) break;
                    names.push(name);
                }
                // Podcast episodes have no artist: show the podcast (show) name and link to the show
                const isEpisode = (contextTrack.uri || "").startsWith("spotify:episode:");
                const showName = metadata.show_name || metadata.album_title || "";
                const showUri = metadata.show_uri || metadata.album_uri || "";
                const item = {
                    uid: contextTrack.uid,
                    uri: contextTrack.uri,
                    title: metadata.title || metadata.name || "Unknown track",
                    artist: names.join(", ") || (isEpisode ? showName : ""),
                    image: queueImageUrl(metadata),
                    albumUri: isEpisode ? showUri : (metadata.album_uri || ""),
                    artistUri: isEpisode ? showUri : (metadata.artist_uri || ""),
                    fromQueue: track.provider === "queue",
                    uidOccurrenceCount: contextTrack.uid ? (uidCounts.get(String(contextTrack.uid)) || 1) : 0,
                    queueIndex,
                    queueRevision: revision
                };
                item.identity = queueOccurrenceIdentity(track, queueIndex, next, uidCounts);
                if (snapshotSignature) item.queueSnapshotSignature = snapshotSignature;
                items.push(item);
                if (items.length >= limit) break;
            }
            return items;
        }
    };

    function playerStateKey(key, value) {
        if (key === "currentTrack") {
            if (!value) return "";
            const metadata = value.metadata || {};
            const artists = (Array.isArray(value.artists) ? value.artists : [])
                .map(artist => `${artist.uri || ""}:${artist.name || ""}`).join(",");
            return [
                value.uri || "",
                value.name || "",
                metadata.title || "",
                metadata.album_title || "",
                metadata.image_xlarge_url || metadata.image_large_url || metadata.image_url || value.images?.[0]?.url || "",
                metadata.album_uri || value.album?.uri || "",
                value.duration?.milliseconds || "",
                artists
            ].join("\u0000");
        }
        if (key === "queue") {
            return JSON.stringify(value.map(item => [
                item.identity || "",
                item.uri || "",
                item.title || "",
                item.artist || "",
                item.image || "",
                item.albumUri || "",
                item.artistUri || "",
                item.fromQueue ? "queue" : "context"
            ]));
        }
        return value;
    }

    function publishPlayerState(patch) {
        const changedKeys = new Set();
        for (const [key, value] of Object.entries(patch)) {
            if (!Object.is(playerStateKey(key, playerState[key]), playerStateKey(key, value))) {
                changedKeys.add(key);
            }
            playerState[key] = value;
        }
        if (changedKeys.size) {
            for (const listener of [...playerStateListeners]) {
                try {
                    listener(playerState, changedKeys);
                } catch (err) {
                    console.error("[MiniPlayer] Player state subscriber failed:", err);
                }
            }
        }
        return changedKeys;
    }

    // Playback position using Spotify's own maths. Spicetify.Player.getProgress() ignores playback speed
    // (podcasts and audiobooks run at 1.25x, 1.5x, 2x...), keeps counting while buffering and can run past the
    // end, so on episodes the bar crept slowly and then snapped forward whenever Spotify refreshed its state.
    function getPlaybackProgress() {
        const state = Spicetify.Player.origin?._state;
        const position = state?.positionAsOfTimestamp;
        if (!state || !Number.isFinite(position) || !Number.isFinite(state.timestamp)) {
            return Spicetify.Player.getProgress() || 0;
        }
        if (state.isPaused || state.isBuffering) return position;
        const speed = Number.isFinite(state.speed) && state.speed > 0 ? state.speed : 1;
        const progress = position + (Date.now() - state.timestamp) * speed;
        return state.duration > 0 ? Math.min(progress, state.duration) : progress;
    }

    // Seeks to an exact millisecond position. Spicetify.Player.seek() reads a non-integer 0..1 as a fraction
    // but the integer 1 as 1 ms, so dragging the scrubber to the very end used to restart the episode.
    function seekToMs(ms) {
        Spicetify.Player.seek(Math.max(0, Math.round(ms)));
    }

    function syncPlayerState(keys = Object.keys(playerState)) {
        const requested = new Set(keys);
        const needsPlayerData = ["currentTrack", "duration", "shuffle", "repeat"].some(key => requested.has(key));
        const data = needsPlayerData ? Spicetify.Player.data || {} : {};
        const patch = {};

        if (requested.has("currentTrack")) patch.currentTrack = data.item || null;
        if (requested.has("isPlaying")) patch.isPlaying = !!Spicetify.Player.isPlaying();
        if (requested.has("progress")) patch.progress = getPlaybackProgress();
        if (requested.has("duration")) {
            patch.duration = Spicetify.Player.getDuration() || data.item?.duration?.milliseconds || 0;
        }
        if (requested.has("volume")) {
            const volume = Spicetify.Player.getVolume();
            patch.volume = Number.isFinite(volume) ? volume : playerState.volume;
        }
        if (requested.has("shuffle")) patch.shuffle = !!data.shuffle;
        if (requested.has("repeat")) patch.repeat = Number(data.repeat) || 0;
        if (requested.has("queue")) patch.queue = SpotifyAdapter.getQueue(queueOpen ? Infinity : 1);
        const changedKeys = publishPlayerState(patch);
        if (requested.has("queue") && queueOpen && isPiPWindowOpen()) {
            updateQueueHeader(pipWindow.document, playerState.queue);
        }
        return changedKeys;
    }

    function updatePlayerState(patch) {
        return publishPlayerState(patch);
    }

    function subscribePlayerState(listener) {
        playerStateListeners.add(listener);
        const unsubscribe = () => playerStateListeners.delete(listener);
        return pipResources ? pipResources.addCleanup(unsubscribe) : unsubscribe;
    }

    function reportQueueActionFailure(action, result) {
        const status = result?.status || "failed";
        const messages = {
            unsupported: result.reason || "This queue action isn't supported",
            "not-found": "That item is no longer in the queue. Refresh and try again.",
            ambiguous: result.reason || "Spotify couldn't identify that queue occurrence safely",
            conflict: result.reason || "The queue changed. Refresh it and try again.",
            failed: result.reason || "Spotify couldn't complete that queue action"
        };
        console.warn(`[MiniPlayer] Queue ${action} ${status}:`, result?.reason || "no additional detail");
        Spicetify.showNotification(messages[status] || `Couldn't ${action} that queue item`, true);
    }

    // Plays exactly this queue occurrence, without acting on a stale or ambiguous row.
    async function playQueueItem(it) {
        const playReason = SpotifyAdapter.canPlayNow(it);
        if (playReason) {
            reportQueueActionFailure("play", { status: "unsupported", reason: playReason });
            return;
        }
        const target = SpotifyAdapter.resolveQueueItem(it);
        if (target.status !== "success") {
            reportQueueActionFailure("play", target);
            return;
        }
        const targetParts = queueEntryParts(target.entry);
        const queueEntries = Spicetify.Platform?.PlayerAPI?._queue?._queue?.nextTracks
            || Spicetify.Queue?.nextTracks
            || [];
        if (!it.uid && !it.fromQueue
            && queueEntries.filter(entry => queueEntryParts(entry).uri === it.uri).length > 1) {
            reportQueueActionFailure("play", {
                status: "ambiguous",
                reason: "This context track has duplicate URIs and no occurrence UID"
            });
            return;
        }
        if (it.fromQueue) {
            const reorderReason = SpotifyAdapter.canMoveToNext(it);
            if (reorderReason) {
                reportQueueActionFailure("play", { status: "unsupported", reason: reorderReason });
                return;
            }
            if (typeof Spicetify.Player?.next !== "function") {
                reportQueueActionFailure("play", {
                    status: "unsupported",
                    reason: "Spotify's Next playback action is unavailable"
                });
                return;
            }

            let reorderResult;
            try {
                reorderResult = await SpotifyAdapter.moveToNext(it);
            } catch (err) {
                console.warn("[MiniPlayer] Could not move queued item to the front:", err?.message || "unknown error");
                reportQueueActionFailure("play", { status: "failed", reason: "Spotify couldn't move the item to the front" });
                return;
            }
            if (reorderResult.status !== "already-next"
                && (reorderResult.status !== "success" || !reorderResult.verified)) {
                const result = reorderResult.status === "success"
                    ? {
                        status: "conflict",
                        reason: "Spotify did not confirm the item is next; playback was not advanced"
                    }
                    : reorderResult;
                reportQueueActionFailure("play", result);
                syncPlayerState(["queue"]);
                return;
            }

            try {
                const result = await Spicetify.Player.next();
                if (result === false) {
                    reportQueueActionFailure("play", { status: "failed", reason: "Spotify rejected the Next action" });
                    syncPlayerState(["queue"]);
                    return;
                }
            } catch (err) {
                console.warn("[MiniPlayer] Could not advance to queued item:", err?.message || "unknown error");
                reportQueueActionFailure("play", { status: "failed", reason: "Spotify couldn't advance to the queued item" });
                syncPlayerState(["queue"]);
                return;
            }
            safeSetTimeout(() => syncPlayerState(["currentTrack", "duration", "queue"]), 400);
            return;
        }

        const data = Spicetify.Player.data;
        const startUri = data?.item?.uri;
        const ctxUri = data?.context?.uri || data?.context_uri || "";
        let ok = false;

        // Tracks from the current playlist/album: restart that context directly at this track, so the
        // rest of the playlist keeps going after it. If the change doesn't land (or the wrong track
        // starts) we bail out immediately and play the track itself instead.
        if (!it.fromQueue && ctxUri) {
            try {
                await SpotifyAdapter.play(ctxUri, {
                    skipTo: {
                        uri: targetParts.uri,
                        uid: targetParts.uid || undefined,
                        trackUri: targetParts.uri,
                        trackUid: targetParts.uid || undefined
                    }
                });
                for (let i = 0; i < 10; i++) {
                    if (!await sleep(150) || !isPiPWindowOpen()) break;
                    const cur = Spicetify.Player.data?.item?.uri;
                    if (cur === it.uri) { ok = true; break; }
                    if (cur && cur !== startUri) break; // something else started: stop waiting
                }
            } catch (err) {
                console.warn("[MiniPlayer] Context queue skip failed:", err?.message || "unknown error");
            }
        }

        // Queued tracks (or if the above didn't land): play the track itself
        if (!ok) {
            try {
                await SpotifyAdapter.play(targetParts.uri);
            } catch (err) {
                console.warn("[MiniPlayer] Could not play queue item:", err?.message || "unknown error");
                Spicetify.showNotification("Couldn't play that track", true);
            }
        }
        safeSetTimeout(() => syncPlayerState(["queue"]), 600);
    }

    async function removeQueueItem(it) {
        try {
            const result = await SpotifyAdapter.removeFromQueue(it);
            if (result.status !== "success") {
                reportQueueActionFailure("remove", result);
                return;
            }
        } catch (err) {
            console.warn("[MiniPlayer] Could not remove queue item:", err?.message || "unknown error");
            Spicetify.showNotification("Couldn't remove that track from the queue", true);
            return;
        }
        safeSetTimeout(() => syncPlayerState(["queue"]), 400);
    }

    async function addQueueItem(it) {
        const result = await SpotifyAdapter.addToQueue(it);
        if (result.status !== "success") {
            syncPlayerState(["queue"]);
            reportQueueActionFailure("add", result);
            return;
        }
        Spicetify.showNotification("Added to queue");
        safeSetTimeout(() => syncPlayerState(["queue"]), 400);
    }

    async function putQueueItemNext(it) {
        try {
            const result = await SpotifyAdapter.moveToNext(it);
            if (result.status === "already-next") {
                Spicetify.showNotification("That track is already next");
                return;
            }
            if (result.status !== "success") {
                reportQueueActionFailure("reorder", result);
                return;
            }
        } catch (err) {
            console.warn("[MiniPlayer] Could not reorder queue item:", err?.message || "unknown error");
            Spicetify.showNotification("Couldn't put that track next", true);
            return;
        }
        safeSetTimeout(() => syncPlayerState(["queue"]), 400);
    }

    async function moveQueueItemToPosition(item, targetItem, placement) {
        try {
            const result = await SpotifyAdapter.moveQueueItem(item, targetItem, placement);
            syncPlayerState(["queue"]);
            if (result.status === "already-positioned") return;
            if (result.status !== "success") reportQueueActionFailure("reorder", result);
        } catch (err) {
            syncPlayerState(["queue"]);
            console.warn("[MiniPlayer] Could not reorder queue item:", err?.message || "unknown error");
            Spicetify.showNotification("Couldn't reorder that queue item", true);
        }
    }

    function clearQueueDrag() {
        const drag = queueDragState;
        queueDragState = null;
        queueDragDisposers.forEach(dispose => dispose?.());
        queueDragDisposers = [];
        if (!drag) return;

        drag.row.classList.remove("queue-item-dragging");
        drag.targetRow?.classList.remove("queue-drop-before", "queue-drop-after");
        if (drag.started) {
            drag.row.dataset.suppressQueuePlayback = "true";
            safeSetTimeout(() => delete drag.row.dataset.suppressQueuePlayback, 300);
        }
        try {
            if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
        } catch (err) {}
    }

    function updateQueueDrag(event) {
        const drag = queueDragState;
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.started) {
            const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
            if (distance < 6) return;
            drag.started = true;
            drag.row.classList.add("queue-item-dragging");
        }
        event.preventDefault();

        const listRect = drag.list.getBoundingClientRect();
        if (event.clientY < listRect.top + 24) drag.list.scrollTop -= 8;
        else if (event.clientY > listRect.bottom - 24) drag.list.scrollTop += 8;

        const hovered = drag.doc.elementFromPoint(event.clientX, event.clientY);
        const targetRow = hovered?.closest?.(".queue-item");
        if (!targetRow || !drag.list.contains(targetRow) || targetRow === drag.row) {
            drag.targetRow?.classList.remove("queue-drop-before", "queue-drop-after");
            drag.targetRow = null;
            drag.targetItem = null;
            return;
        }

        const targetItem = drag.itemsByIdentity.get(targetRow.dataset.queueIdentity);
        if (!targetItem || targetItem.identity === drag.item.identity) {
            drag.targetRow?.classList.remove("queue-drop-before", "queue-drop-after");
            drag.targetRow = null;
            drag.targetItem = null;
            return;
        }
        const placement = event.clientY < targetRow.getBoundingClientRect().top + targetRow.offsetHeight / 2
            ? "before"
            : "after";
        if (drag.targetRow !== targetRow || drag.placement !== placement) {
            drag.targetRow?.classList.remove("queue-drop-before", "queue-drop-after");
            targetRow.classList.remove("queue-drop-before", "queue-drop-after");
            targetRow.classList.add(placement === "before" ? "queue-drop-before" : "queue-drop-after");
        }
        drag.targetRow = targetRow;
        drag.targetItem = targetItem;
        drag.placement = placement;
    }

    function finishQueueDrag(event, cancelled = false) {
        const drag = queueDragState;
        if (!drag || (event && event.pointerId !== drag.pointerId)) return;
        const shouldMove = !cancelled && drag.started && drag.targetItem;
        if (drag.started) {
            event?.preventDefault();
            event?.stopPropagation();
        }
        const { item, targetItem, placement } = drag;
        clearQueueDrag();
        if (shouldMove) moveQueueItemToPosition(item, targetItem, placement);
    }

    function beginQueueDrag(event, item, row, handle, list, itemsByIdentity) {
        if (event.button !== 0 || event.isPrimary === false || queueDragState) return;
        const eligibilityReason = SpotifyAdapter.canMoveToNext(item);
        if (eligibilityReason) return;
        const resolved = SpotifyAdapter.resolveQueueItem(item);
        if (resolved.status !== "success" || queueEntryParts(resolved.entry).source !== "queue") {
            syncPlayerState(["queue"]);
            reportQueueActionFailure("reorder", resolved.status === "success"
                ? { status: "unsupported", reason: "Only manually queued items can be reordered" }
                : resolved);
            return;
        }
        event.stopPropagation();

        const doc = pipWindow.document;
        queueDragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            started: false,
            item,
            row,
            handle,
            list,
            doc,
            itemsByIdentity,
            targetRow: null,
            targetItem: null,
            placement: null
        };
        queueDragDisposers = [
            listenPiP(doc, "pointermove", updateQueueDrag, { capture: true }),
            listenPiP(doc, "pointerup", event => finishQueueDrag(event), { capture: true }),
            listenPiP(doc, "pointercancel", event => finishQueueDrag(event, true), { capture: true }),
            listenPiP(handle, "lostpointercapture", event => finishQueueDrag(event, true)),
            listenPiP(pipWindow, "blur", () => finishQueueDrag(null, true))
        ];
        try {
            handle.setPointerCapture(event.pointerId);
        } catch (err) {}
    }

    async function copyTrackLink(it) {
        const link = shareableSpotifyLink(it.uri);
        if (!link) {
            return;
        }
        try {
            if (Spicetify.Platform?.ClipboardAPI?.copy) await Spicetify.Platform.ClipboardAPI.copy(link);
            else await navigator.clipboard.writeText(link);
            Spicetify.showNotification("Link copied");
        } catch (err) {
            Spicetify.showNotification("Couldn't copy the link", true);
        }
    }

    function canCopySpotifyLink(item) {
        if (!shareableSpotifyLink(item?.uri)) return "No shareable Spotify link is available for this item";
        const hasPlatformClipboard = typeof Spicetify.Platform?.ClipboardAPI?.copy === "function";
        const hasBrowserClipboard = typeof navigator !== "undefined"
            && typeof navigator.clipboard?.writeText === "function";
        return hasPlatformClipboard || hasBrowserClipboard
            ? ""
            : "Clipboard access is unavailable";
    }

    // The three-dots menu on a queue row
    function closeQueueMenu() {
        queueMenuDisposers.forEach(dispose => dispose?.());
        queueMenuDisposers = [];
        const doc = queueMenuEl?.ownerDocument;
        queueMenuEl?.remove();
        queueMenuEl = null;
        doc?.querySelectorAll(".queue-more.active").forEach(b => b.classList.remove("active"));
    }

    function openQueueMenu(it, anchor) {
        closeQueueMenu();
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;

        const menu = doc.createElement("div");
        menu.className = "queue-menu";
        menu.dataset.identity = it.identity;
        const add = (label, handler, disabledReason = "") => {
            const b = doc.createElement("button");
            b.className = "queue-menu-item";
            b.textContent = label;
            b.disabled = !!disabledReason;
            if (disabledReason) b.title = disabledReason;
            queueMenuDisposers.push(listenPiP(b, "click", (e) => {
                if (b.disabled) return;
                e.stopPropagation();
                closeQueueMenu();
                handler();
            }));
            menu.appendChild(b);
        };
        const sep = () => {
            const s = doc.createElement("div");
            s.className = "queue-menu-sep";
            menu.appendChild(s);
        };

        const reorderReason = SpotifyAdapter.canMoveToNext(it);
        add("Add to queue", () => addQueueItem(it), SpotifyAdapter.canAddToQueue(it));
        add("Play next", () => putQueueItemNext(it), reorderReason);
        add("Play now", () => playQueueItem(it), SpotifyAdapter.canPlayNow(it));
        const removeReason = SpotifyAdapter.canRemoveFromQueue(it);
        add("Remove from queue", () => removeQueueItem(it), removeReason);
        if (it.albumUri || it.artistUri) sep();
        // Podcast episodes link to their show, which is both the "album" and the "artist"
        const isShow = (it.albumUri || "").startsWith("spotify:show:");
        if (it.albumUri) {
            const expectedTypes = isShow ? ["show"] : ["album"];
            const reason = SpotifyAdapter.canOpenSpotifyPage(it.albumUri, expectedTypes);
            add(isShow ? "Go to show" : "Go to album", () => openInSpotify(it.albumUri), reason);
        }
        if (it.artistUri && it.artistUri !== it.albumUri) {
            const reason = SpotifyAdapter.canOpenSpotifyPage(it.artistUri, ["artist"]);
            add("Go to artist", () => openInSpotify(it.artistUri), reason);
        }
        sep();
        add("Copy Spotify link", () => copyTrackLink(it), canCopySpotifyLink(it));

        menu.style.maxHeight = `${Math.max(1, pipWindow.innerHeight - 16)}px`;
        doc.body.appendChild(menu);
        anchor.classList.add("active");

        // Keep the menu inside the PiP viewport; scroll it when neither side has enough room.
        const r = anchor.getBoundingClientRect();
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        const W = pipWindow.innerWidth;
        const H = pipWindow.innerHeight;
        let left = r.left - mw - 4;
        if (left < 8) left = Math.min(r.right + 4, W - mw - 8);
        left = Math.max(8, left);
        const fitsBelow = r.bottom + 4 + mh <= H - 8;
        const fitsAbove = r.top - mh - 4 >= 8;
        let top = fitsBelow ? r.bottom + 4 : fitsAbove ? r.top - mh - 4 : 8;
        top = Math.min(Math.max(8, top), Math.max(8, H - mh - 8));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        queueMenuEl = menu;
    }

    function updateQueueSelectionToolbar(doc = pipWindow?.document) {
        const selectButton = doc?.getElementById("queue-select-items");
        const countLabel = doc?.getElementById("queue-selection-count");
        const removeButton = doc?.getElementById("queue-remove-selected");
        const confirmButton = doc?.getElementById("queue-confirm-remove");
        const keepButton = doc?.getElementById("queue-keep-selection");
        const cancelButton = doc?.getElementById("queue-cancel-selection");
        if (!selectButton || !countLabel || !removeButton || !confirmButton || !keepButton || !cancelButton) return;

        const count = queueSelectedItems.size;
        selectButton.hidden = queueSelectionMode;
        countLabel.hidden = !queueSelectionMode;
        countLabel.textContent = queueBulkRemoving
            ? `Removing ${count} item${count === 1 ? "" : "s"}...`
            : queueBulkConfirm
                ? `Remove ${count} selected items?`
                : `${count} selected`;
        removeButton.hidden = !queueSelectionMode || queueBulkConfirm;
        removeButton.disabled = !count || queueBulkRemoving;
        confirmButton.hidden = !queueBulkConfirm;
        confirmButton.disabled = queueBulkRemoving;
        keepButton.hidden = !queueBulkConfirm;
        keepButton.disabled = queueBulkRemoving;
        cancelButton.hidden = !queueSelectionMode;
        cancelButton.disabled = queueBulkRemoving;
    }

    function beginQueueSelectionMode() {
        if (queueBulkRemoving) return;
        queueSelectionMode = true;
        queueSelectedItems.clear();
        queueBulkConfirm = false;
        renderQueuePanel(true);
    }

    function endQueueSelectionMode() {
        if (queueBulkRemoving) return;
        queueSelectionMode = false;
        queueSelectedItems.clear();
        queueBulkConfirm = false;
        renderQueuePanel(true);
    }

    function toggleQueueItemSelection(item, row) {
        if (!queueSelectionMode || !item?.fromQueue || queueBulkRemoving) return;
        const reason = SpotifyAdapter.canBulkRemoveFromQueue(item);
        if (reason) {
            Spicetify.showNotification(reason, true);
            return;
        }

        if (queueSelectedItems.has(item.identity)) queueSelectedItems.delete(item.identity);
        else queueSelectedItems.set(item.identity, item);
        queueBulkConfirm = false;
        const selected = queueSelectedItems.has(item.identity);
        row.classList.toggle("queue-item-selected", selected);
        const control = row.querySelector(".queue-selection-toggle");
        if (control) {
            control.setAttribute("aria-pressed", String(selected));
            control.setAttribute("aria-label", `${selected ? "Deselect" : "Select"} ${item.title} for removal`);
        }
        updateQueueSelectionToolbar();
    }

    function requestBulkQueueRemoval() {
        if (queueBulkRemoving || !queueSelectedItems.size) return;
        if (queueSelectedItems.size > 1) {
            queueBulkConfirm = true;
            updateQueueSelectionToolbar();
            return;
        }
        void removeSelectedQueueItems();
    }

    async function removeSelectedQueueItems() {
        if (queueBulkRemoving || !queueSelectedItems.size) return;
        const selected = Array.from(queueSelectedItems.values());
        queueBulkRemoving = true;
        queueBulkConfirm = false;
        updateQueueSelectionToolbar();

        let result;
        try {
            result = await SpotifyAdapter.removeManyFromQueue(selected);
        } catch (error) {
            console.warn("[MiniPlayer] Bulk queue removal failed:", error?.message || "unknown error");
            result = {
                status: "failed",
                succeeded: 0,
                succeededItems: [],
                failed: [{ reason: "Spotify's bulk removal request failed" }],
                total: selected.length
            };
        }

        for (const item of result.succeededItems || []) queueSelectedItems.delete(item.identity);
        queueBulkRemoving = false;
        queueBulkConfirm = false;
        if (result.status === "success" || !queueSelectedItems.size) {
            queueSelectionMode = false;
            queueSelectedItems.clear();
        }
        if (result.status === "success") {
            Spicetify.showNotification(`Removed ${result.succeeded} item${result.succeeded === 1 ? "" : "s"} from queue`);
        } else if (result.status === "partial") {
            Spicetify.showNotification(
                `Removed ${result.succeeded} of ${result.total} items; ${result.total - result.succeeded} couldn't be removed`,
                true
            );
        } else {
            const reason = result.failed?.[0]?.reason;
            Spicetify.showNotification(reason || "Couldn't remove the selected queue items", true);
        }

        syncPlayerState(["queue"]);
        if (queueSelectionMode && !queueSelectedItems.size) {
            queueSelectionMode = false;
            queueBulkConfirm = false;
        }
        if (queueOpen) renderQueuePanel(true);
    }

    function queueItemVisibleSignature(item) {
        return JSON.stringify([
            item.identity || "",
            item.uri || "",
            item.title || "",
            item.artist || "",
            item.image || "",
            item.albumUri || "",
            item.artistUri || "",
            item.fromQueue ? "queue" : "context"
        ]);
    }

    function updateQueueHeader(doc, items) {
        const queueCount = doc?.getElementById("queue-count");
        const queueSourceNote = doc?.getElementById("queue-source-note");
        const rawQueueLength = Array.isArray(Spicetify.Queue?.nextTracks)
            ? Spicetify.Queue.nextTracks.length
            : items.length;
        const snapshotMayBeTruncated = rawQueueLength >= QUEUE_SNAPSHOT_WARNING_THRESHOLD;
        if (queueCount) {
            queueCount.textContent = items.length >= QUEUE_SNAPSHOT_WARNING_THRESHOLD
                ? `${items.length}+`
                : String(items.length);
            queueCount.title = `${items.length} items are exposed in Spotify's current queue snapshot`;
        }
        if (queueSourceNote) {
            queueSourceNote.textContent = snapshotMayBeTruncated
                ? `Spotify's queue snapshot has reached ${QUEUE_SNAPSHOT_WARNING_THRESHOLD} entries. Its documented API has no pagination, so the full queue may be larger.`
                : `Showing all ${items.length} items exposed by Spotify's current queue snapshot. The documented API has no pagination.`;
        }
    }

    function updateNowPlayingRow(doc) {
        const row = doc?.getElementById("queue-now-playing");
        if (!row || !queueOpen) return;
        const item = playerState.currentTrack;
        row.hidden = !item;
        if (!item) return;

        const metadata = getTrackMetadata();
        const image = row.querySelector(".queue-now-playing-image");
        const title = row.querySelector(".queue-now-playing-title");
        const artist = row.querySelector(".queue-now-playing-artist");
        if (image) {
            if (metadata.cover) image.src = metadata.cover;
            else image.removeAttribute("src");
        }
        if (title) title.textContent = metadata.title;
        if (artist) artist.textContent = metadata.artist;
        row.classList.toggle("is-playing", !!playerState.isPlaying);
        row.setAttribute("aria-label", `Now playing: ${metadata.title} · ${metadata.artist}`);
    }

    function finishQueueHeadRemoval() {
        const pending = queueHeadRemoval;
        if (!pending) return;
        queueHeadRemoval = null;
        pending.animation.cancel();
        pending.row.remove();
    }

    function patchConsumedQueueHead(list, items, key) {
        const previous = renderedQueueItems;
        if (queueSelectionMode || queueBulkRemoving || queueDragState || queueMenuEl
            || !previous?.length || items.length !== previous.length - 1 || !items.length) return false;

        const hasStableIdentity = item => item.uid
            && item.uidOccurrenceCount === 1
            && item.identity === `uid:${item.uid}`;
        if (!previous.every(hasStableIdentity) || !items.every(hasStableIdentity)) return false;
        for (let index = 0; index < items.length; index++) {
            if (previous[index + 1].identity !== items[index].identity
                || queueItemVisibleSignature(previous[index + 1]) !== queueItemVisibleSignature(items[index])) {
                return false;
            }
        }

        const rows = [...list.querySelectorAll(".queue-item")];
        if (rows.length !== previous.length
            || rows.some((row, index) => row.dataset.queueIdentity !== previous[index].identity)) return false;

        const head = rows[0];
        const headDisposers = queueRowDisposers.get(previous[0].identity) || [];
        headDisposers.forEach(dispose => dispose?.());
        queueRowDisposers.delete(previous[0].identity);
        const removedDisposers = new Set(headDisposers);
        queueRenderDisposers = queueRenderDisposers.filter(dispose => !removedDisposers.has(dispose));

        const previousHeading = head.previousElementSibling;
        if (previousHeading?.classList.contains("queue-group")
            && head.nextElementSibling?.classList.contains("queue-group")) {
            previousHeading.remove();
        }

        lastQueueKey = key;
        renderedQueueItems = items.slice();

        const duration = pipWindow.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 140;
        if (typeof head.animate !== "function") {
            head.remove();
            return true;
        }

        head.style.overflow = "hidden";
        head.style.boxSizing = "border-box";
        const height = head.getBoundingClientRect().height;
        const animation = head.animate([
            {
                height: `${height}px`,
                minHeight: `${height}px`,
                paddingTop: "5px",
                paddingBottom: "5px",
                opacity: 1,
                transform: "translateY(0)"
            },
            {
                height: "0px",
                minHeight: "0px",
                paddingTop: "0px",
                paddingBottom: "0px",
                opacity: 0,
                transform: "translateY(-4px)"
            }
        ], { duration, easing: "ease", fill: "forwards" });
        const pending = { row: head, animation };
        queueHeadRemoval = pending;
        animation.finished.then(() => {
            if (queueHeadRemoval !== pending) return;
            head.remove();
            queueHeadRemoval = null;
        }).catch(() => {});
        return true;
    }

    // Rebuilds the list only when the queue actually changed, keeping the scroll position
    function renderQueuePanel(force = false) {
        if (!isPiPWindowOpen() || !queueOpen) return;
        const doc = pipWindow.document;
        const list = doc.getElementById("queue-list");
        if (!list) return;

        const items = playerState.queue;
        const key = playerStateKey("queue", items);
        updateNowPlayingRow(doc);
        updateQueueHeader(doc, items);
        if (!force && key === lastQueueKey) return;
        finishQueueHeadRemoval();
        if (!force && patchConsumedQueueHead(list, items, key)) return;
        lastQueueKey = key;
        if (!queueBulkRemoving) {
            const currentItems = new Map(items.filter(item => item.fromQueue).map(item => [item.identity, item]));
            for (const [identity, selected] of queueSelectedItems) {
                const current = currentItems.get(identity);
                if (!current || current.uri !== selected.uri || current.uid !== selected.uid
                    || (!current.uid && current.queueSnapshotSignature !== selected.queueSnapshotSignature)) {
                    queueSelectedItems.delete(identity);
                } else {
                    queueSelectedItems.set(identity, current);
                }
            }
            if (queueSelectedItems.size < 2) queueBulkConfirm = false;
        }
        updateQueueSelectionToolbar(doc);
        closeQueueMenu(); // the row it belonged to is about to be rebuilt
        const hasQueuedItems = items.some(item => item.fromQueue);
        const itemsByIdentity = new Map(items.map(item => [item.identity, item]));

        const scrollTop = list.scrollTop;
        clearQueueDrag();
        queueRenderDisposers.forEach(dispose => dispose?.());
        queueRenderDisposers = [];
        queueRowDisposers.clear();
        renderedQueueItems = null;
        list.textContent = "";
        const generation = ++queueRenderGeneration;

        if (!items.length) {
            const empty = doc.createElement("div");
            empty.className = "queue-empty";
            empty.textContent = "Nothing in the queue";
            list.appendChild(empty);
            renderedQueueItems = [];
            return;
        }

        let lastGroup = null;
        let index = 0;
        const renderBatch = () => {
            if (generation !== queueRenderGeneration || !isPiPWindowOpen() || !queueOpen) return;
            const fragment = doc.createDocumentFragment();
            const end = Math.min(index + 20, items.length);
            for (; index < end; index++) {
                const it = items[index];
                const group = it.fromQueue ? "Next in queue" : "Next up";
                if (currentMode === "standard" && group !== lastGroup
                    && (group !== "Next up" || hasQueuedItems)) {
                    const heading = doc.createElement("div");
                    heading.className = "queue-group";
                    heading.setAttribute("role", "heading");
                    heading.setAttribute("aria-level", "3");
                    heading.textContent = group;
                    fragment.appendChild(heading);
                }
                lastGroup = group;
                const row = doc.createElement("div");
                const rowDisposers = [];
                const listenRow = (target, type, handler) => {
                    const dispose = listenPiP(target, type, handler);
                    queueRenderDisposers.push(dispose);
                    rowDisposers.push(dispose);
                };
                row.className = "queue-item";
                const itemLabel = `${it.title}${it.artist ? ` · ${it.artist}` : ""}`;
                const itemType = it.uri.startsWith("spotify:episode:") ? "episode" : "track";
                row.setAttribute("role", "listitem");
                row.setAttribute("aria-label", `${itemLabel}, ${itemType}${it.fromQueue ? ", manually queued" : ""}`);
                row.tabIndex = 0;
                row.title = queueSelectionMode
                    ? it.fromQueue
                        ? `Click to select ${itemLabel} for removal`
                        : `Only manually queued items can be selected for removal: ${itemLabel}`
                    : `Play ${itemType}: ${itemLabel}`;
                row.dataset.queueIdentity = it.identity;
                if (queueSelectionMode) {
                    row.classList.add("queue-selection-active");
                    if (it.fromQueue) {
                        const removeReason = SpotifyAdapter.canRemoveFromQueue(it);
                        const selected = queueSelectedItems.has(it.identity);
                        const selectionToggle = doc.createElement("button");
                        selectionToggle.type = "button";
                        selectionToggle.className = "queue-selection-toggle";
                        selectionToggle.disabled = !!removeReason;
                        selectionToggle.title = removeReason || (selected ? "Deselect item" : "Select for bulk removal");
                        selectionToggle.setAttribute("aria-label", `${selected ? "Deselect" : "Select"} ${it.title} for removal`);
                        selectionToggle.setAttribute("aria-pressed", String(selected));
                        row.classList.toggle("queue-item-selected", selected);
                        listenRow(selectionToggle, "click", event => {
                            event.stopPropagation();
                            toggleQueueItemSelection(it, row);
                        });
                        row.appendChild(selectionToggle);
                    } else {
                        row.classList.add("queue-selection-disabled");
                    }
                }

                const img = doc.createElement("img");
                img.className = "queue-img";
                img.alt = "";
                img.draggable = false;
                img.loading = "lazy";
                if (it.image) img.src = it.image;
                row.appendChild(img);

                const text = doc.createElement("div");
                text.className = "queue-text";
                const name = doc.createElement("div");
                name.className = "queue-name";
                name.textContent = it.title;
                const artist = doc.createElement("div");
                artist.className = "queue-artist";
                artist.textContent = it.artist;
                text.appendChild(name);
                text.appendChild(artist);
                row.appendChild(text);

                if (it.fromQueue && currentMode !== "standard") {
                    const sourceBadge = doc.createElement("span");
                    sourceBadge.className = "queue-source-badge";
                    sourceBadge.textContent = "Queued";
                    sourceBadge.title = "Manually added to queue";
                    sourceBadge.setAttribute("aria-hidden", "true");
                    row.appendChild(sourceBadge);
                }

                if (!queueSelectionMode && !SpotifyAdapter.canMoveToNext(it)) {
                    const dragHandle = doc.createElement("span");
                    dragHandle.className = "queue-drag-handle";
                    dragHandle.title = "Drag to reorder";
                    dragHandle.setAttribute("aria-hidden", "true");
                    listenRow(dragHandle, "pointerdown", event => {
                        beginQueueDrag(event, it, row, dragHandle, list, itemsByIdentity);
                    });
                    listenRow(dragHandle, "dragstart", event => event.preventDefault());
                    row.appendChild(dragHandle);
                }

                const more = doc.createElement("button");
                more.className = "queue-more";
                more.title = "More";
                more.innerHTML = ICONS.more;
                listenRow(more, "click", (e) => {
                    e.stopPropagation();
                    if (queueMenuEl && queueMenuEl.dataset.identity === it.identity) {
                        closeQueueMenu();
                        return;
                    }
                    openQueueMenu(it, more);
                });
                row.appendChild(more);
                listenRow(row, "click", event => {
                    if (event.target?.closest?.(".queue-drag-handle") || row.dataset.suppressQueuePlayback === "true") {
                        delete row.dataset.suppressQueuePlayback;
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                    }
                    if (queueSelectionMode) {
                        if (it.fromQueue) toggleQueueItemSelection(it, row);
                        return;
                    }
                    playQueueItem(it);
                });
                listenRow(row, "keydown", event => {
                    if (event.target !== row) return;
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        const rows = [...list.querySelectorAll(".queue-item")];
                        const rowIndex = rows.indexOf(row);
                        const nextRow = rows[rowIndex + (event.key === "ArrowUp" ? -1 : 1)];
                        if (nextRow) {
                            event.preventDefault();
                            nextRow.focus();
                        }
                        return;
                    }

                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (queueSelectionMode) {
                            if (it.fromQueue) toggleQueueItemSelection(it, row);
                        } else {
                            playQueueItem(it);
                        }
                        return;
                    }

                    if (event.key !== "Delete" || event.repeat) return;
                    event.preventDefault();
                    if (queueSelectionMode) {
                        if (it.fromQueue) {
                            if (queueSelectedItems.has(it.identity)) requestBulkQueueRemoval();
                            else toggleQueueItemSelection(it, row);
                        }
                        return;
                    }

                    const removeReason = SpotifyAdapter.canRemoveFromQueue(it);
                    if (removeReason) {
                        reportQueueActionFailure("remove", { status: "unsupported", reason: removeReason });
                    } else {
                        void removeQueueItem(it);
                    }
                });
                queueRowDisposers.set(it.identity, rowDisposers);
                fragment.appendChild(row);
            }
            list.appendChild(fragment);
            if (index < items.length) pipResources?.requestAnimationFrame(renderBatch);
            else {
                list.scrollTop = scrollTop;
                renderedQueueItems = items.slice();
            }
        };
        renderBatch();
    }

    // Expand compact queue windows while open, then restore their mode dimensions.
    function applyQueueLayout() {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        closeQueueMenu();
        if (!queueOpen) {
            finishQueueHeadRemoval();
            queueRenderGeneration++;
            queueRenderDisposers.forEach(dispose => dispose?.());
            queueRenderDisposers = [];
            queueRowDisposers.clear();
            renderedQueueItems = null;
        }
        doc.body.classList.toggle("queue-open", queueOpen);
        doc.getElementById("btn-queue")?.classList.toggle("active", queueOpen);
        resizePiPWindowToMode();

        lastQueueKey = null;
        renderQueuePanel(true);
    }

    // Opens an album/artist page in the main Spotify window
    function openInSpotify(uri) {
        const resource = parseSpotifyResource(uri);
        const history = Spicetify.Platform?.History;
        if (!resource || typeof history?.push !== "function") return false;
        try {
            history.push(`/${resource.type}/${resource.id}`);
            window.focus();
            return true;
        } catch (err) {
            console.warn("[MiniPlayer] Could not open page in Spotify:", err);
            return false;
        }
    }

    function restoreWindowPosition() {
        if (!isPiPWindowOpen() || !settings.rememberPosition) return;
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
        saveWindowSize();
        if (!isPiPWindowOpen() || !settings.rememberPosition) return;
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
        if (isPiPWindowOpen()) {
            try { pipWindow.focus?.(); } catch (e) {}
            return;
        }

        if (!("documentPictureInPicture" in window)) {
            Spicetify.showNotification("Document Picture-in-Picture is not supported in this client build.", true);
            return;
        }

        isOpening = true;
        cleanupPiPResources();

        try {
            queueOpen = false;
            const { width, height } = getOpenSize();

            // Request floating document PiP window
            // @ts-ignore
            pipWindow = await window.documentPictureInPicture.requestWindow({
                width,
                height
            });
            pipResources = createPiPResourceRegistry(pipWindow);
            syncPlayerState();
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

            // Bind Event Listeners
            bindMiniPlayerEvents();

            // Recalculate text overflow/marquee on window resize without illegal resizeTo() calls
            let resizeFrame = null;
            listenPiP(pipWindow, "resize", () => {
                // One layout pass per frame while a window edge is being dragged
                if (resizeFrame !== null || !pipResources) return;
                resizeFrame = pipResources.requestAnimationFrame(() => {
                    resizeFrame = null;
                    applyFluidLayout();
                    updateMarqueeEffect(true);
                });
            });

            // Smooth requestAnimationFrame loop for active visual progress updates
            startProgressLoop();

            // Player state sync is separate from the queue and window-position polling.
            pipResources.setInterval(syncPlayerStateTick, PLAYER_STATE_SYNC_MS);
            pipResources.setInterval(() => {
                if (!pipWindow.document.hidden) syncEpisodeVideo();
            }, EPISODE_VIDEO_SYNC_MS);
            // Queue polling: the top bar only needs the first item, and podcast shows can have thousands of
            // queued episodes, so poll less often for them (and not at all while the window is hidden)
            let queueTick = 0;
            pipResources.setInterval(() => {
                if (!(settings.showUpcoming || queueOpen)) return;
                if (!queueOpen && pipWindow?.document?.hidden) return;
                const onEpisode = (playerState.currentTrack?.uri || "").startsWith("spotify:episode:");
                if (onEpisode && (queueTick++ % 3) !== 0) return;
                syncPlayerState(["queue"]);
            }, QUEUE_STATE_SYNC_MS);
            pipResources.setInterval(saveWindowPosition, WINDOW_POSITION_SYNC_MS);

            // Handle PiP Window Close
            const win = pipWindow;
            listenPiP(win, "pagehide", () => {
                if (pipWindow !== win) return;
                saveWindowPosition();
                cleanupPiPResources();
                pipWindow = null;
                updateButtonStates(false);
            });

            updateButtonStates(true);
        } catch (err) {
            console.error("[MiniPlayer] Failed to open Document PiP window:", err);
            Spicetify.showNotification("Failed to open Mini Player window.", true);
            cleanupPiPResources();
            pipWindow = null;
            updateButtonStates(false);
        } finally {
            isOpening = false;
        }
    }

    function closeMiniPlayer() {
        if (isPiPWindowOpen()) saveWindowPosition();
        cleanupPiPResources();
        if (isPiPWindowOpen()) {
            try { pipWindow.close(); } catch (e) {}
        }
        pipWindow = null;
        updateButtonStates(false);
    }

    function toggleMiniPlayer() {
        if (isOpening) return;
        if (isPiPWindowOpen()) {
            closeMiniPlayer();
        } else {
            openMiniPlayer();
        }
    }

    function updateButtonStates(isActive, natives = null) {
        const domPlaybarBtn = document.getElementById("miniplayer-playbar-btn");
        if (domPlaybarBtn) {
            domPlaybarBtn.style.color = isActive ? "#1db954" : "#b3b3b3";
        }
        // Spotify's own button (when we've taken it over) lights up green while our player is open
        (natives || findNativeMiniplayerButtons()).forEach((el) => {
            if (settings.replaceNative && isActive) el.setAttribute("data-mp-active", "true");
            else el.removeAttribute("data-mp-active");
        });
    }

    // ---------- Taking over Spotify's own mini player button ----------
    // We find Spotify's button by its test id or its exact label. If Spotify renames either (or the
    // label is translated), nothing matches and we simply fall back to our own playbar button.
    const NATIVE_MINIPLAYER_TESTIDS = ["pip-toggle-button", "control-button-pip", "miniplayer-button", "mini-player-button"];
    const NATIVE_MINIPLAYER_LABELS = ["miniplayer"]; // compared lowercase with spaces/dashes removed

    function isNativeMiniplayerButton(el) {
        if (!el || el.id === "miniplayer-playbar-btn") return false;
        const testId = (el.getAttribute("data-testid") || "").toLowerCase();
        if (testId && NATIVE_MINIPLAYER_TESTIDS.includes(testId)) return true;
        // Exact match only, so our own shortcut label and settings button never count
        const label = (el.getAttribute("aria-label") || "").toLowerCase().replace(/[\s_-]+/g, "");
        return !!label && NATIVE_MINIPLAYER_LABELS.includes(label);
    }

    function isOpenMiniplayerButton(el) {
        if (!el) return false;
        const labels = [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.getAttribute("data-tooltip"),
            el.textContent
        ];
        return labels.some(value => {
            const label = (value || "").toLowerCase().replace(/[^a-z]/g, "");
            return label === "openinminiplayer" || label === "openinminplayer";
        });
    }

    function findNativeMiniplayerButtons(scope = null) {
        try {
            // Never fall back to document: episode pages can contain hundreds of unrelated playback controls.
            const playbackBar = scope || document.querySelector(
                ".main-nowPlayingBar-container, [data-testid='now-playing-bar'], .main-nowPlayingBar-right, [data-testid='now-playing-bar-right']"
            );
            if (!playbackBar) return [];
            return Array.from(playbackBar.querySelectorAll("button[data-testid], button[aria-label], [role='button'][aria-label]"))
                .filter(isNativeMiniplayerButton);
        } catch (e) {
            return [];
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
            /* Top bar, card and queue stay in normal flow (top-aligned) so opening/closing the queue
               doesn't redistribute free space. */
            body {
                flex-direction: column;
                justify-content: flex-start;
                position: relative;
            }
            .player-surface {
                position: relative;
                z-index: 1;
                display: flex;
                flex: 0 0 100%;
                flex-direction: column;
                align-items: center;
                width: 100%;
                height: 100%;
                overflow: hidden;
            }
            /* Top bar above the card: queue button and optional next-track text */
            .upcoming-bar {
                display: flex;
                position: relative;
                z-index: 6;
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
            /* Queue button, pinned to the right end of the top bar */
            .queue-btn {
                margin-left: auto;
                flex-shrink: 0;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 20px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: #b3b3b3;
                transition: color 0.15s ease, background 0.15s ease;
            }
            .queue-btn:hover {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.12);
            }
            .queue-btn.active {
                color: #1ed760;
            }
            /* When "Show next song" is off, the bar only holds the queue button */
            .upcoming-bar.no-next .upcoming-label,
            .upcoming-bar.no-next .upcoming-text {
                display: none;
            }
            /* Queue panel */
            .queue-panel {
                display: none;
                position: absolute;
                z-index: 5;
                left: 0;
                top: ${UPCOMING_BAR_HEIGHT}px;
                flex: 0 0 auto;
                height: ${QUEUE_PANEL_HEIGHT}px;
                width: 100%;
                min-width: 100%;
                max-width: 100%;
                min-height: 0;
                max-height: calc(100% - ${UPCOMING_BAR_HEIGHT}px);
                flex-direction: column;
                overflow: hidden;
                resize: none;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                background: rgba(0, 0, 0, 0.28);
                backdrop-filter: blur(18px);
                -webkit-app-region: no-drag;
            }
            .queue-panel * {
                -webkit-app-region: no-drag;
            }
            body.queue-open .queue-panel {
                display: flex;
            }
            body.queue-open .miniplayer-card {
                visibility: hidden;
                pointer-events: none;
            }
            /* Header: title + count on the left, "Select" on the right. While selecting, the toolbar takes the row. */
            .queue-header {
                display: flex;
                flex: 0 0 auto;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                min-height: 40px;
                padding: 8px 10px 4px 14px;
            }
            .queue-heading {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
            }
            .queue-title {
                color: #ffffff;
                font-size: 15px;
                font-weight: 700;
                letter-spacing: -0.01em;
            }
            .queue-count {
                padding: 1px 7px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.1);
                color: #b3b3b3;
                font-size: 10px;
                font-weight: 700;
                font-variant-numeric: tabular-nums;
            }
            .queue-header:has(#queue-cancel-selection:not([hidden])) .queue-heading {
                display: none;
            }
            .queue-header:has(#queue-cancel-selection:not([hidden])) .queue-selection-toolbar {
                flex: 1 1 auto;
            }
            .queue-selection-toolbar {
                display: flex;
                flex: 0 1 auto;
                align-items: center;
                justify-content: flex-end;
                gap: 6px;
                min-width: 0;
            }
            .queue-selection-toolbar [hidden] {
                display: none !important;
            }
            .queue-selection-toolbar button {
                flex: 0 0 auto;
                padding: 4px 12px;
                border: 1px solid transparent;
                border-radius: 999px;
                background: transparent;
                color: #b3b3b3;
                font-family: inherit;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                transition: color 0.12s ease, background 0.12s ease, border-color 0.12s ease, transform 0.1s ease;
            }
            .queue-selection-toolbar button:hover:not(:disabled) {
                color: #ffffff;
                transform: scale(1.04);
            }
            .queue-selection-toolbar button:disabled {
                opacity: 0.4;
                cursor: default;
            }
            #queue-select-items {
                background: rgba(255, 255, 255, 0.08);
                color: #ffffff;
            }
            #queue-select-items:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.14);
            }
            #queue-remove-selected {
                border-color: #727272;
                color: #ffffff;
            }
            #queue-remove-selected:hover:not(:disabled) {
                border-color: #ffffff;
            }
            #queue-confirm-remove {
                background: #ffffff;
                color: #000000;
            }
            .queue-selection-count {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                color: #ffffff;
                font-size: 12px;
                font-weight: 700;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            /* "Now playing" card, like Spotify's own queue */
            .queue-now-playing {
                display: flex;
                flex: 0 0 auto;
                align-items: center;
                gap: 12px;
                margin: 2px 8px 6px;
                padding: 8px 10px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.06);
                user-select: none;
                -webkit-user-select: none;
            }
            .queue-now-playing[hidden] { display: none; }
            .queue-now-label {
                margin-bottom: 1px;
                color: #1ed760;
                font-size: 9px;
                font-weight: 700;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }
            .queue-now-playing .queue-name { color: #1ed760; }
            .queue-playing-bars {
                display: flex;
                flex: 0 0 14px;
                align-items: flex-end;
                justify-content: center;
                gap: 2px;
                width: 14px;
                height: 16px;
            }
            .queue-playing-bars i {
                width: 2px;
                border-radius: 2px;
                background: #1ed760;
                transform: scaleY(0.55);
                transform-origin: bottom;
            }
            .queue-playing-bars i:nth-child(1) { height: 7px; }
            .queue-playing-bars i:nth-child(2) { height: 13px; }
            .queue-playing-bars i:nth-child(3) { height: 9px; }
            .queue-playing-bars i:nth-child(4) { height: 5px; }
            .queue-now-playing.is-playing .queue-playing-bars i {
                animation: queue-playing-bars 0.7s ease-in-out infinite alternate;
            }
            .queue-now-playing.is-playing .queue-playing-bars i:nth-child(2) { animation-delay: 0.18s; }
            .queue-now-playing.is-playing .queue-playing-bars i:nth-child(3) { animation-delay: 0.32s; }
            .queue-now-playing.is-playing .queue-playing-bars i:nth-child(4) { animation-delay: 0.1s; }
            @keyframes queue-playing-bars {
                to { transform: scaleY(1); }
            }
            @media (prefers-reduced-motion: reduce) {
                .queue-now-playing.is-playing .queue-playing-bars i { animation: none; }
            }
            .queue-source-note {
                flex: 0 0 auto;
                padding: 7px 14px 9px;
                border-top: 1px solid rgba(255, 255, 255, 0.06);
                color: rgba(255, 255, 255, 0.4);
                font-size: 10px;
                line-height: 1.35;
            }
            .queue-list {
                flex: 1 1 auto;
                min-height: 0;
                overflow-x: hidden;
                overflow-y: auto;
                padding: 0 2px 8px 8px;
                overscroll-behavior-y: contain;
                touch-action: pan-y;
            }
            /* Same slim, hover-only, Spotify-style scrollbar as the settings panel */
            .queue-list::-webkit-scrollbar { width: 12px; }
            .queue-list::-webkit-scrollbar-button { display: none !important; }
            .queue-list::-webkit-scrollbar-track { background: transparent; }
            .queue-list::-webkit-scrollbar-thumb {
                min-height: 40px;
                background-color: rgba(255, 255, 255, 0);
                border: 3px solid transparent;
                border-radius: 999px;
                background-clip: padding-box;
                transition: background-color 0.15s ease;
            }
            .queue-list:hover::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.3); }
            .queue-list::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.55); }
            /* Section headings stay pinned while you scroll their rows */
            .queue-group {
                position: sticky;
                top: 0;
                z-index: 2;
                padding: 10px 8px 6px;
                background: linear-gradient(rgba(18, 18, 18, 0.97), rgba(18, 18, 18, 0.9));
                color: #ffffff;
                font-size: 12px;
                font-weight: 700;
            }
            .queue-item {
                display: flex;
                position: relative;
                align-items: center;
                gap: 12px;
                padding: 6px 8px;
                min-height: 52px;
                border-radius: 6px;
                cursor: pointer;
                user-select: none;
                -webkit-user-select: none;
                content-visibility: auto;
                contain-intrinsic-size: auto 52px;
                transition: background 0.12s ease;
            }
            .queue-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .queue-item:hover .queue-artist {
                color: #ffffff;
            }
            .queue-item:focus-visible {
                outline: 2px solid #1ed760;
                outline-offset: -2px;
            }
            .queue-item.queue-selection-active {
                cursor: pointer;
            }
            .queue-item.queue-selection-disabled {
                cursor: default;
                opacity: 0.55;
            }
            .queue-item.queue-item-selected {
                background: rgba(30, 215, 96, 0.12);
                box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.3);
            }
            .queue-selection-toggle {
                display: flex;
                flex: 0 0 18px;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                padding: 0;
                border: 1.5px solid rgba(255, 255, 255, 0.5);
                border-radius: 50%;
                background: transparent;
                cursor: pointer;
                transition: border-color 0.12s ease, background 0.12s ease;
            }
            .queue-selection-toggle:hover:not(:disabled) {
                border-color: #ffffff;
            }
            .queue-selection-toggle[aria-pressed="true"] {
                border-color: #1ed760;
                background: #1ed760;
            }
            .queue-selection-toggle[aria-pressed="true"]::after {
                width: 4px;
                height: 8px;
                border: solid #121212;
                border-width: 0 2px 2px 0;
                content: "";
                transform: rotate(45deg);
                margin-top: -2px;
            }
            .queue-selection-toggle:disabled {
                opacity: 0.35;
                cursor: default;
            }
            .queue-item-dragging {
                opacity: 0.5;
                background: rgba(255, 255, 255, 0.1);
            }
            .queue-item.queue-drop-before::before,
            .queue-item.queue-drop-after::after {
                content: "";
                position: absolute;
                z-index: 1;
                left: 8px;
                right: 8px;
                height: 2px;
                border-radius: 2px;
                background: #1ed760;
                box-shadow: 0 0 7px rgba(30, 215, 96, 0.55);
                pointer-events: none;
            }
            .queue-item.queue-drop-before::before { top: -1px; }
            .queue-item.queue-drop-after::after { bottom: -1px; }
            /* Grip appears on hover so the list stays clean at rest */
            .queue-drag-handle {
                flex: 0 0 12px;
                width: 12px;
                height: 28px;
                margin-right: -4px;
                padding: 0;
                border: 0;
                border-radius: 3px;
                background-color: transparent;
                background-image: radial-gradient(circle, rgba(167, 167, 167, 0.78) 1px, transparent 1.4px);
                background-position: center;
                background-size: 4px 5px;
                opacity: 0;
                cursor: grab;
                touch-action: none;
                user-select: none;
                -webkit-user-select: none;
                transition: opacity 0.12s ease;
            }
            .queue-item:hover .queue-drag-handle,
            .queue-item-dragging .queue-drag-handle {
                opacity: 1;
            }
            .queue-drag-handle:hover {
                background-image: radial-gradient(circle, rgba(255, 255, 255, 0.95) 1px, transparent 1.4px);
            }
            .queue-drag-handle:active { cursor: grabbing; }
            .queue-img {
                width: 40px;
                height: 40px;
                flex-shrink: 0;
                border-radius: 4px;
                object-fit: cover;
                background: #282828;
            }
            .queue-source-badge {
                flex: 0 0 auto;
                padding: 2px 8px;
                border-radius: 999px;
                background: rgba(30, 215, 96, 0.14);
                color: #1ed760;
                font-size: 10px;
                font-weight: 700;
                line-height: 1.3;
                white-space: nowrap;
            }
            .queue-text {
                min-width: 0;
                flex: 1;
            }
            .queue-name {
                font-size: 13px;
                font-weight: 500;
                color: #ffffff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .queue-artist {
                margin-top: 2px;
                font-size: 12px;
                color: #a7a7a7;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                transition: color 0.12s ease;
            }
            /* Three dots on each row: shown on hover, or while its menu is open */
            .queue-more {
                flex-shrink: 0;
                width: 24px;
                height: 24px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: #b3b3b3;
                opacity: 0;
                transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
            }
            .queue-item:hover .queue-more,
            .queue-more.active {
                opacity: 1;
            }
            .queue-more:hover,
            .queue-more.active {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.12);
            }
            /* Context menu opened by the three dots */
            .queue-menu {
                position: fixed;
                z-index: 30;
                min-width: 160px;
                max-height: calc(100vh - 16px);
                overflow-y: auto;
                overscroll-behavior: contain;
                scrollbar-width: thin;
                scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
                padding: 4px;
                border-radius: 6px;
                background: #282828;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.08);
                -webkit-app-region: no-drag !important;
            }
            .queue-menu::-webkit-scrollbar { width: 8px; }
            .queue-menu::-webkit-scrollbar-button { display: none !important; }
            .queue-menu::-webkit-scrollbar-track { background: transparent; }
            .queue-menu::-webkit-scrollbar-thumb {
                min-height: 32px;
                background-color: rgba(255, 255, 255, 0.24);
                border: 2px solid transparent;
                border-radius: 999px;
                background-clip: padding-box;
            }
            .queue-menu:hover::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.4); }
            .queue-menu::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.56); }
            .queue-menu * {
                -webkit-app-region: no-drag !important;
            }
            .queue-menu-item {
                display: block;
                width: 100%;
                padding: 9px 12px;
                border: none;
                border-radius: 3px;
                background: transparent;
                color: #e6e6e6;
                font-size: 13px;
                font-weight: 500;
                text-align: left;
                white-space: nowrap;
            }
            .queue-menu-item:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #ffffff;
            }
            .queue-menu-item:disabled {
                opacity: 0.48;
                cursor: default;
            }
            .queue-menu-sep {
                height: 1px;
                margin: 4px 6px;
                background: rgba(255, 255, 255, 0.1);
            }
            .queue-empty {
                padding: 36px 16px;
                text-align: center;
                font-size: 13px;
                font-weight: 700;
                color: #ffffff;
            }
            .queue-empty::after {
                content: "Songs you add will show up here";
                display: block;
                margin-top: 4px;
                color: #a7a7a7;
                font-size: 11px;
                font-weight: 400;
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
            /* Fade overlapping player and queue content as one layer. */
            .player-surface {
                transition: opacity 0.35s ease;
            }
            body.idle .player-surface {
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
            .icon-btn.repeat-one {
                position: relative;
            }
            .icon-btn.repeat-one::after {
                content: "1";
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                padding: 0 1px;
                border-radius: 2px;
                background: #121212;
                color: currentColor;
                font-size: 7px;
                font-weight: 700;
                line-height: 1;
                pointer-events: none;
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
                /* Clicking the album art switches player mode. */
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
            .episode-video {
                display: none;
                position: absolute;
                z-index: 1;
                inset: 0;
                width: 100%;
                height: 100%;
                object-fit: cover;
                background: #000000;
                pointer-events: none;
            }
            .cover-container.video-active .episode-video { display: block; }
            .cover-container.video-active .cover-art { visibility: hidden; }
            /* Hover overlay on the cover: dims the art and shows the mode-switch icon */
            .cover-overlay {
                position: absolute;
                z-index: 2;
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
            .lyrics-display {
                display: none;
                flex: 1 1 0;
                min-width: 0;
                max-height: 52px;
                flex-direction: column;
                justify-content: center;
                gap: 8px;
                overflow: hidden;
                text-align: left;
                pointer-events: none;
            }
            .lyrics-action-group {
                display: flex;
                align-items: center;
                gap: 2px;
            }
            .lyrics-text-mode {
                display: none;
                align-items: center;
                justify-content: center;
                height: 20px;
                padding: 0 5px;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.72);
                font-size: 8.5px;
                font-weight: 700;
                line-height: 1;
                white-space: nowrap;
            }
            body.lyrics-mode .lyrics-text-mode {
                display: inline-flex;
            }
            .lyrics-text-mode.unavailable {
                display: none !important;
            }
            .lyrics-text-mode:hover {
                background: rgba(255, 255, 255, 0.18);
                color: #ffffff;
            }
            .lyrics-text-mode:disabled {
                opacity: 0.5;
                cursor: default;
            }
            .lyrics-current,
            .lyrics-next {
                display: -webkit-box;
                -webkit-box-orient: vertical;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .lyrics-current {
                color: #ffffff;
                font-size: 13px;
                font-weight: 600;
                line-height: 16px;
                padding-right: 22px;
                -webkit-line-clamp: 2;
            }
            .lyrics-next {
                display: none;
                color: rgba(255, 255, 255, 0.58);
                font-size: 10px;
                line-height: 12px;
                -webkit-line-clamp: 1;
            }
            .lyrics-next.is-empty {
                display: none;
            }
            body.lyrics-mode .cover-container,
            body.lyrics-mode .meta-container {
                display: none !important;
            }
            body.lyrics-mode .lyrics-display {
                display: flex;
            }
            .lyrics-source {
                display: inline-flex;
                width: 70px;
                align-items: center;
                overflow: hidden;
                color: rgba(255, 255, 255, 0.42);
                font-size: 7.5px;
                font-weight: 600;
                line-height: 1;
                letter-spacing: 0.15px;
                white-space: nowrap;
                visibility: hidden;
                pointer-events: none;
            }
            body.lyrics-mode .lyrics-source {
                visibility: visible;
            }
            @media (min-height: 240px) {
                body:not(.compact-mode).lyrics-mode.lyrics-both .lyrics-next:not(.is-empty) {
                    display: -webkit-box;
                }
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
            .track-title-text.linkable,
            .artist-link.linkable {
                -webkit-app-region: no-drag !important;
                cursor: pointer;
            }
            .track-title-text.linkable:hover {
                text-decoration: underline;
            }
            .artist-link.linkable:hover {
                color: #ffffff;
                text-decoration: underline;
            }
            /* Settings: "Click title / artist to open" turned off -> behave like plain, draggable text */
            body.links-off .track-title-text.linkable,
            body.links-off .artist-link.linkable {
                -webkit-app-region: drag !important;
                cursor: inherit;
            }
            body.links-off .track-title-text.linkable:hover,
            body.links-off .artist-link.linkable:hover {
                text-decoration: none;
                color: inherit;
            }
            /* Progress Scrubber (Standard Mode) */
            .progress-section {
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 2px 0 2px 0;
            }
            body.fluid.podcast-video-wide:not(.compact-mode):not(.mini-mode) .progress-section {
                margin-top: 10px;
            }
            body.fluid.art-layout:not(.podcast-video-wide) .progress-section {
                transform: translateY(-8px);
            }
            .time-label {
                font-size: 10px;
                color: #a7a7a7;
                font-variant-numeric: tabular-nums;
                white-space: nowrap; /* long-form audio: never wrap 1:23:45 */
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
            body.compact-mode .lyrics-action-group,
            body.compact-mode .controls-section {
                display: none !important;
            }
            /* Show compact cluster only in compact mode */
            body.compact-mode .compact-actions-cluster {
                display: contents !important;
            }
            /* Keep the close button at the far right. */
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
            body.compact-mode .lyrics-display {
                max-height: 42px;
                gap: 2px;
            }
            body.compact-mode .lyrics-current {
                font-size: 11px;
                line-height: 13px;
            }
            body.compact-mode .lyrics-next {
                font-size: 9px;
                line-height: 10px;
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
                transition: opacity 0.22s ease;
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
            body.mini-mode .track-artist,
            body.compact-mode.mini-mode .progress-section,
            body.mini-mode .volume-popup,
            body.mini-mode #btn-volume-compact {
                display: none !important;
            }
            body.mini-mode:not(.podcast-track) .cover-container {
                display: none !important;
            }
            body.mini-mode.podcast-track .cover-container {
                display: block !important;
                width: 24px;
                height: 24px;
                border-radius: 4px;
            }
            body.mini-mode .lyrics-display {
                max-height: 20px;
            }
            body.mini-mode .lyrics-next {
                display: none;
            }
            body.mini-mode .lyrics-current {
                -webkit-line-clamp: 1;
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
            body.mini-mode .queue-list {
                padding-bottom: 0;
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
            /* ======================================================== */
            /* FLUID (experimental dynamic resizing)                     */
            /* The card fills the window. JS picks the layout from the   */
            /* window size and sets --s (scale) and --art (cover size).  */
            /* ======================================================== */
            body.fluid .miniplayer-card {
                width: 100%;
                max-width: none;
                min-width: 0;
                height: auto;
                min-height: 0;
                max-height: none;
                flex: 1 1 auto;
            }
            /* The queue fills whatever window it has */
            body.fluid .queue-panel {
                height: auto;
                max-height: none;
                bottom: 0;
            }
            body.fluid .cover-container { width: calc(52px * var(--s, 1)); height: calc(52px * var(--s, 1)); }
            body.fluid.compact-mode .cover-container { width: calc(42px * var(--s, 1)); height: calc(42px * var(--s, 1)); }
            body.fluid .track-title { font-size: calc(13.5px * var(--s, 1)); }
            body.fluid.compact-mode .track-title { font-size: calc(12.5px * var(--s, 1)); }
            body.fluid .track-artist { font-size: calc(11.5px * var(--s, 1)); }
            body.fluid.compact-mode .track-artist { font-size: calc(10.5px * var(--s, 1)); }
            body.fluid .lyrics-display {
                max-height: calc(52px * var(--lyrics-s, 1));
                gap: calc(8px * var(--lyrics-s, 1));
            }
            body.fluid .lyrics-current {
                font-size: calc(13px * var(--lyrics-s, 1));
                line-height: calc(16px * var(--lyrics-s, 1));
            }
            body.fluid .lyrics-next {
                font-size: calc(10px * var(--lyrics-s, 1));
                line-height: calc(12px * var(--lyrics-s, 1));
            }
            body.fluid .lyrics-text-mode {
                height: calc(20px * var(--s, 1));
                padding: 0 calc(5px * var(--s, 1));
                font-size: calc(8.5px * var(--s, 1));
            }
            body.fluid.compact-mode .lyrics-display {
                max-height: calc(42px * var(--lyrics-s, 1));
                gap: calc(2px * var(--s, 1));
            }
            body.fluid.compact-mode .lyrics-current {
                font-size: calc(11px * var(--lyrics-s, 1));
                line-height: calc(13px * var(--lyrics-s, 1));
            }
            body.fluid.compact-mode .lyrics-next {
                font-size: calc(9px * var(--lyrics-s, 1));
                line-height: calc(10px * var(--lyrics-s, 1));
            }
            body.fluid.mini-mode .lyrics-display {
                max-height: calc(20px * var(--s, 1));
            }
            body.fluid .time-label { font-size: calc(10px * var(--s, 1)); min-width: calc(26px * var(--s, 1)); }
            body.fluid.compact-mode .time-label { font-size: calc(9.5px * var(--s, 1)); min-width: calc(24px * var(--s, 1)); }
            body.fluid .icon-btn { width: calc(22px * var(--s, 1)); height: calc(22px * var(--s, 1)); }
            body.fluid .icon-btn svg,
            body.fluid .play-pause-btn svg { scale: var(--s, 1); }
            body.fluid .play-pause-btn { width: calc(32px * var(--s, 1)); height: calc(32px * var(--s, 1)); }
            body.fluid:not(.compact-mode) .playback-controls { gap: calc(12px * var(--s, 1)); }
            body.fluid .controls-spacer,
            body.fluid .volume-section { width: auto; }
            body.fluid .volume-section .volume-slider { width: var(--vol-w, calc(48px * var(--s, 1))); }
            body.fluid.vol-icon-only .volume-section .volume-slider { display: none; }
            /* Standard / art: three equal-sided columns keep the transport row exactly centered,
               whatever the volume section needs; volume sits at the right edge */
            body.fluid .controls-section {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
                align-items: center;
            }
            body.fluid .controls-spacer { grid-column: 1; }
            body.fluid .controls-section .playback-controls { grid-column: 2; justify-self: center; }
            body.fluid .volume-section { grid-column: 3; justify-self: end; }
            /* Compact, wide enough: cover + title left, controls dead center, close right */
            body.fluid.ctr-controls.compact-mode:not(.mini-mode) .track-section {
                display: grid;
                grid-template-columns: calc(42px * var(--s, 1)) minmax(0, 1fr) auto minmax(0, 1fr) calc(42px * var(--s, 1));
                column-gap: calc(10px * var(--s, 1));
                align-items: center;
            }
            body.fluid.ctr-controls.compact-mode:not(.mini-mode) .cover-container { grid-column: 1; grid-row: 1; }
            body.fluid.ctr-controls.compact-mode:not(.mini-mode) .meta-container { grid-column: 2; grid-row: 1; }
            body.fluid.ctr-controls.compact-mode:not(.mini-mode) .compact-actions-cluster .playback-controls { grid-column: 3; grid-row: 1; margin: 0; }
            body.fluid.ctr-controls.compact-mode:not(.mini-mode) .compact-actions-cluster .window-actions { grid-column: 5; grid-row: 1; justify-self: end; }
            /* Mini, wide enough: title left, controls dead center, mode + close right */
            body.fluid.ctr-controls.mini-mode .track-section {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
                column-gap: calc(10px * var(--s, 1));
                align-items: center;
            }
            /* Keep podcast art out of grid auto-placement so it can't create a second row. */
            body.fluid.ctr-controls.mini-mode.podcast-track .track-section { position: relative; }
            body.fluid.ctr-controls.mini-mode.podcast-track .cover-container {
                position: absolute;
                z-index: 1;
                left: 0;
                top: 50%;
                transform: translateY(-50%);
            }
            body.fluid.ctr-controls.mini-mode .meta-container { grid-column: 1; grid-row: 1; }
            body.fluid.ctr-controls.mini-mode.podcast-track .meta-container { margin-left: calc(30px * var(--s, 1)); }
            body.fluid.ctr-controls.mini-mode .compact-actions-cluster .playback-controls { grid-column: 2; grid-row: 1; margin: 0; }
            body.fluid.ctr-controls.mini-mode .compact-actions-cluster .window-actions { grid-column: 3; grid-row: 1; justify-self: end; }
            /* Narrow Standard / art layout: the speaker opens the same volume row as Compact, in place of the controls */
            body.fluid:not(.compact-mode) .controls-section { transition: opacity 0.22s ease; }
            body.fluid.vol-icon-only:not(.compact-mode) .volume-popup {
                display: flex;
                left: 14px;
                right: 14px;
                bottom: 12px;
                height: calc(32px * var(--s, 1));
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                transform: translateY(3px);
                transition: opacity 0.22s ease, transform 0.22s ease, visibility 0s linear 0.22s;
            }
            body.fluid.vol-icon-only:not(.compact-mode) .volume-popup.open {
                opacity: 1;
                visibility: visible;
                pointer-events: auto;
                transform: none;
                transition: opacity 0.22s ease, transform 0.22s ease, visibility 0s;
            }
            body.fluid.vol-icon-only:not(.compact-mode).volume-open .controls-section {
                opacity: 0;
                pointer-events: none;
            }
            /* Narrow Mini: show the speaker button too; its volume row replaces the title row while open */
            body.fluid.mini-vol.mini-mode #btn-volume-compact { display: flex !important; }
            body.fluid.mini-vol.mini-mode .volume-popup { display: flex !important; top: calc(50% - 9px); bottom: auto; }
            body.fluid.mini-vol.mini-mode .track-section { transition: opacity 0.22s ease; }
            body.fluid.mini-vol.mini-mode.volume-open .track-section { opacity: 0; pointer-events: none; }
            /* Long-form audio (episodes, audiobooks): widen the labels for 1:23:45 */
            body .miniplayer-card.long-form .time-label { min-width: calc(40px * var(--s, 1)); }
            /* Shrink button (top bar): only while the window is much bigger than the biggest enabled mode */
            .shrink-btn { display: none; margin-left: auto; }
            body.fluid.can-shrink .shrink-btn { display: inline-flex; }
            body.fluid.can-shrink .shrink-btn + .queue-btn { margin-left: 0; }
            /* Slim (window under 74px tall): the top bar steps aside so the card gets the whole height */
            body.fluid.slim .upcoming-bar { display: none; }
            /* Tiny (Mini under 300px wide): shuffle/repeat drop out, padding tightens, volume stays */
            body.fluid.tiny #btn-shuffle-compact,
            body.fluid.tiny #btn-repeat-compact { display: none !important; }
            body.fluid.tiny.mini-mode .miniplayer-card { padding: 8px; }
            body.fluid.tiny.mini-mode .track-section { gap: 6px; }
            /* The compact volume popup keeps its own fixed sizing */
            body.fluid .volume-popup .icon-btn { width: 18px; height: 18px; }
            body.fluid .volume-popup .icon-btn svg { scale: 1; }
            /* Compact / Mini row: buttons scale, the title takes all the extra width */
            body.fluid.compact-mode #btn-shuffle-compact,
            body.fluid.compact-mode #btn-repeat-compact,
            body.fluid.compact-mode #btn-volume-compact { width: calc(24px * var(--s, 1)); height: calc(24px * var(--s, 1)); }
            body.fluid.compact-mode #btn-prev-compact,
            body.fluid.compact-mode #btn-next-compact { width: calc(26px * var(--s, 1)); height: calc(26px * var(--s, 1)); }
            body.fluid.compact-mode .compact-actions-cluster .window-actions .icon-btn { width: calc(20px * var(--s, 1)); height: calc(20px * var(--s, 1)); }
            body.fluid.compact-mode .meta-container,
            body.fluid.mini-mode .meta-container { max-width: none; }
            /* Tall window: big album art on top, title and artist centered under it */
            body.fluid.art-layout .track-section {
                flex: 1 1 auto;
                min-height: 0;
                flex-direction: column;
                justify-content: center;
                gap: calc(8px * var(--s, 1));
            }
            body.fluid.art-layout .cover-container {
                width: var(--art, 120px);
                height: var(--art, 120px);
                border-radius: 10px;
            }
            body.fluid.art-layout .meta-container {
                flex: 0 0 auto;
                width: 100%;
                align-items: center;
                text-align: center;
            }
            body.fluid.art-layout .meta-row { width: 100%; }
            body.fluid.art-layout .track-title-wrapper { text-align: center; }
            body.fluid.art-layout .track-artist { max-width: 100%; }
            /* Active podcast video gets a larger landscape frame; regular cover art stays square.
               Video is only captured in Standard mode (see syncEpisodeVideo), so Compact and Mini keep their
               normal cover size, including the moment right after a mode switch. */
            .cover-container.video-active { width: 110px; height: 62px; }
            body.fluid .cover-container.video-active {
                width: calc(110px * var(--s, 1));
                height: calc(62px * var(--s, 1));
            }
            body.fluid.art-layout .cover-container.video-active {
                width: calc(var(--art, 120px) * 2.14);
                height: calc(var(--art, 120px) * 1.2);
            }
            body.compact-mode:not(.mini-mode) .cover-container.video-active { width: 42px; height: 42px; }
            body.fluid.compact-mode:not(.mini-mode) .cover-container.video-active {
                width: calc(42px * var(--s, 1));
                height: calc(42px * var(--s, 1));
            }
            body.compact-mode .cover-container.video-active .episode-video,
            body.mini-mode .cover-container.video-active .episode-video { display: none !important; }
            body.compact-mode .cover-container.video-active .cover-art,
            body.mini-mode .cover-container.video-active .cover-art { visibility: visible !important; }
            body.fluid.mini-mode.podcast-track .cover-container {
                width: calc(24px * var(--s, 1));
                height: calc(24px * var(--s, 1));
            }
            .cover-container.video-active ~ .meta-container { margin-top: calc(3px * var(--s, 1)); }
            .cover-container.video-active ~ .meta-container .track-title { font-size: calc(11.5px * var(--s, 1)); }
            .cover-container.video-active ~ .meta-container .track-artist { font-size: calc(9.5px * var(--s, 1)); }
            body.fluid.art-layout .cover-container.video-active ~ .meta-container {
                margin-top: calc(6px * var(--s, 1));
            }
            @media (max-width: 689px), (max-height: 419px) {
                body.podcast-video-active .cover-container.video-active .episode-video { display: none !important; }
                body.podcast-video-active .cover-container.video-active .cover-art { visibility: visible !important; }
                body.podcast-video-active .cover-container.video-active { width: 52px; height: 52px; }
                body.podcast-video-active.compact-mode .cover-container.video-active { width: 42px; height: 42px; }
                body.podcast-video-active.mini-mode.podcast-track .cover-container.video-active { width: 24px; height: 24px; }
                body.podcast-video-active.fluid .cover-container.video-active {
                    width: calc(52px * var(--s, 1));
                    height: calc(52px * var(--s, 1));
                }
                body.podcast-video-active.fluid.compact-mode .cover-container.video-active {
                    width: calc(42px * var(--s, 1));
                    height: calc(42px * var(--s, 1));
                }
                body.podcast-video-active.fluid.mini-mode.podcast-track .cover-container.video-active {
                    width: calc(24px * var(--s, 1));
                    height: calc(24px * var(--s, 1));
                }
                body.podcast-video-active.fluid.art-layout .cover-container.video-active {
                    width: var(--art, 120px);
                    height: var(--art, 120px);
                }
                body.podcast-video-active.fluid.ctr-controls.compact-mode:not(.mini-mode) .track-section {
                    grid-template-columns: calc(42px * var(--s, 1)) minmax(0, 1fr) auto minmax(0, 1fr) calc(42px * var(--s, 1));
                }
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
            <div class="player-surface" id="player-surface">
            <!-- Queue list overlays the player window from the top bar's queue button -->
            <div class="queue-panel" id="queue-panel">
                <div class="queue-header">
                    <div class="queue-heading">
                        <span class="queue-title">Queue</span>
                        <span class="queue-count" id="queue-count" aria-live="polite">0</span>
                    </div>
                    <div class="queue-selection-toolbar" id="queue-selection-toolbar">
                        <button id="queue-select-items" type="button">Select</button>
                        <span class="queue-selection-count" id="queue-selection-count" aria-live="polite" hidden></span>
                        <button id="queue-remove-selected" type="button" hidden disabled>Remove</button>
                        <button id="queue-confirm-remove" type="button" hidden>Confirm</button>
                        <button id="queue-keep-selection" type="button" hidden>Keep</button>
                        <button id="queue-cancel-selection" type="button" hidden>Cancel</button>
                    </div>
                </div>
                <div class="queue-now-playing" id="queue-now-playing" role="status" hidden>
                    <img class="queue-img queue-now-playing-image" alt="" draggable="false">
                    <div class="queue-text">
                        <div class="queue-now-label">Now playing</div>
                        <div class="queue-name queue-now-playing-title"></div>
                        <div class="queue-artist queue-now-playing-artist"></div>
                    </div>
                    <span class="queue-playing-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                </div>
                <div class="queue-list" id="queue-list" role="list" aria-label="Queue"></div>
                <div class="queue-source-note" id="queue-source-note"></div>
            </div>
            <!-- Top bar: queue button always; next-song text is optional -->
            <div class="upcoming-bar" id="upcoming-bar">
                <span class="upcoming-label"><span class="upcoming-dot"></span>Next</span>
                <span class="upcoming-text" id="upcoming-text"><span id="upcoming-title" class="upcoming-title"></span><span id="upcoming-artist" class="upcoming-artist"></span></span>
                <button class="queue-btn shrink-btn" id="btn-shrink" title="Shrink">${ICONS.shrink}</button>
                <button class="queue-btn" id="btn-queue" title="Queue">${ICONS.queue}</button>
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
                        <div class="lyrics-action-group">
                            <span class="lyrics-source" id="lyrics-source"></span>
                            <button class="lyrics-text-mode" id="btn-lyrics-text-mode" title="Lyrics text: Original (click to cycle)" aria-label="Lyrics text: Original (click to cycle)">Original</button>
                            <button class="icon-btn" id="btn-lyrics" title="Show SpicyLyrics" aria-label="Show SpicyLyrics" aria-pressed="false">
                                ${ICONS.lyrics}
                            </button>
                        </div>
                        <button class="icon-btn" id="btn-close" title="Close Mini Player">
                            ${ICONS.close}
                        </button>
                    </div>
                </div>

                <!-- Track Info & Controls Row -->
                <div class="track-section">
                    <div class="cover-container" title="Switch mode">
                        <img id="cover-img" class="cover-art" src="" alt="Album Art" />
                        <video id="episode-video" class="episode-video" muted playsinline aria-hidden="true"></video>
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
                    <div class="lyrics-display" id="lyrics-display" aria-live="off">
                        <div class="lyrics-current" id="lyrics-current">Open SpicyLyrics to mirror its lyrics</div>
                        <div class="lyrics-next" id="lyrics-next"></div>
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
                            <div class="lyrics-action-group">
                                <button class="icon-btn" id="btn-lyrics-compact" title="Show SpicyLyrics" aria-label="Show SpicyLyrics" aria-pressed="false">
                                    ${ICONS.lyrics}
                                </button>
                            </div>
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
                        <input type="range" id="progress-slider" class="progress-slider" min="0" max="10000" value="0" />
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
            </div>
        `;
    }

    function bindMiniPlayerEvents() {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        subscribePlayerState((state, changedKeys) => {
            if (changedKeys.has("currentTrack") || changedKeys.has("duration")) {
                renderFullUI();
            }
            if (changedKeys.has("currentTrack") || changedKeys.has("isPlaying")) {
                updateNowPlayingRow(doc);
            }
            if (changedKeys.has("isPlaying")) {
                updatePlayPauseButton();
                if (state.isPlaying) startProgressLoop();
            }
            if ((changedKeys.has("progress") || changedKeys.has("duration")) && !isUserSeeking) {
                renderProgressUI();
            }
            if (changedKeys.has("volume") && !isAdjustingVolume) updateVolumeUI();
            if (changedKeys.has("shuffle") || changedKeys.has("repeat")) updateShuffleRepeatState();
            if (changedKeys.has("queue")) {
                updateUpcomingBar();
                renderQueuePanel();
            }
        });

        // Manual window-drag fallback for the card and top bar.
        let isDragging = false;
        let startX = 0, startY = 0;
        const card = doc.getElementById("miniplayer-card");
        const upcomingBar = doc.getElementById("upcoming-bar");
        const dragRoots = [card, upcomingBar].filter(Boolean);

        if (dragRoots.length) {
            dragRoots.forEach(root => listenPiP(root, "mousedown", (e) => {
                if (e.button !== 0) return;
                if (/** @type {HTMLElement} */(e.target).closest("button, input, a, .progress-bar-container")) return;
                isDragging = true;
                startX = e.screenX;
                startY = e.screenY;
            }));

            listenPiP(pipWindow, "mousemove", (e) => {
                if (!isDragging) return;
                const dx = e.screenX - startX;
                const dy = e.screenY - startY;
                startX = e.screenX;
                startY = e.screenY;
                try {
                    pipWindow.moveBy(dx, dy);
                } catch (err) {}
            });

            listenPiP(pipWindow, "mouseup", () => {
                isDragging = false;
            });
        }

        // Mode Toggles
        const toggleMode = () => {
            if (settings.dynamicResize) return; // the window size picks the layout
            const next = nextMode();
            if (next === currentMode) return; // only one usable mode
            currentMode = next;
            saveMode(currentMode);
            applyModeLayout();
        };
        // Mini mode has no cover, so it gets its own small mode button
        listenPiP(doc.getElementById("btn-mode-mini"), "click", toggleMode);

        // Click the album art to switch modes (ignore clicks that were really a window drag)
        const coverContainer = doc.querySelector(".cover-container");
        let coverDownX = 0;
        let coverDownY = 0;
        listenPiP(coverContainer, "mousedown", (e) => {
            coverDownX = e.screenX;
            coverDownY = e.screenY;
        });
        listenPiP(coverContainer, "click", (e) => {
            if (Math.abs(e.screenX - coverDownX) > 4 || Math.abs(e.screenY - coverDownY) > 4) return;
            if (expandPodcastVideoPreview()) return;
            toggleMode();
        });

        const lyricsButtons = [
            doc.getElementById("btn-lyrics"),
            doc.getElementById("btn-lyrics-compact")
        ].filter(Boolean);
        const lyricsTextModeButtons = [
            doc.getElementById("btn-lyrics-text-mode")
        ].filter(Boolean);
        syncLyricsTextModeButton();
        lyricsTextModeButtons.forEach(button => listenPiP(button, "click", () => {
            if (currentMode !== "standard" || !lyricsRomanizationAvailable) return;
            const index = LYRICS_TEXT_MODES.indexOf(lyricsTextMode);
            lyricsTextMode = LYRICS_TEXT_MODES[(index + 1) % LYRICS_TEXT_MODES.length];
            doc.body.classList.toggle("lyrics-both", lyricsTextMode === "both");
            syncLyricsTextModeButton();
            refreshLyricsAdapter();
        }));
        const setLyricsMode = (enabled) => {
            doc.body.classList.toggle("lyrics-mode", enabled);
            doc.body.classList.toggle("lyrics-both", lyricsTextMode === "both");
            for (const button of lyricsButtons) {
                button.classList.toggle("active", enabled);
                button.setAttribute("aria-pressed", String(enabled));
                button.title = enabled ? "Hide SpicyLyrics" : "Show SpicyLyrics";
                button.setAttribute("aria-label", button.title);
            }
            if (enabled) startLyricsAdapter();
            else stopLyricsAdapter();
        };
        lyricsButtons.forEach(button => listenPiP(button, "click", () => {
            setLyricsMode(!doc.body.classList.contains("lyrics-mode"));
        }));

        // Click the title -> album page, click an artist name -> that artist's page.
        // Clicks that were really a window drag are ignored.
        const bindLink = (root, selector, getUri) => {
            let downX = 0;
            let downY = 0;
            listenPiP(root, "mousedown", (e) => {
                downX = e.screenX;
                downY = e.screenY;
            });
            listenPiP(root, "click", (e) => {
                if (!settings.clickToOpen) return;
                if (Math.abs(e.screenX - downX) > 4 || Math.abs(e.screenY - downY) > 4) return;
                const el = /** @type {HTMLElement} */ (e.target).closest(selector);
                const uri = el ? getUri(el) : "";
                if (uri) openInSpotify(uri);
            });
        };
        bindLink(doc.getElementById("title-wrapper"), ".track-title-text.linkable", () => currentAlbumUri);
        bindLink(doc.getElementById("title-wrapper"), ".artist-link.linkable", (el) => el.dataset.uri || "");
        bindLink(doc.getElementById("track-artist"), ".artist-link.linkable", (el) => el.dataset.uri || "");

        // Shrink button (large window): back to the biggest mode that's enabled in settings
        listenPiP(doc.getElementById("btn-shrink"), "click", shrinkToBiggestMode);

        // Queue button in the top bar: show/hide the queue list.
        const queueButton = doc.getElementById("btn-queue");
        listenPiP(queueButton, "click", () => {
            if (queueBulkRemoving) return;
            queueOpen = !queueOpen;
            if (!queueOpen) {
                queueSelectionMode = false;
                queueSelectedItems.clear();
                queueBulkConfirm = false;
            }
            applyQueueLayout();
            if (queueOpen) safeSetTimeout(() => syncPlayerState(["queue"]), 50);
        });
        listenPiP(doc.getElementById("queue-select-items"), "click", beginQueueSelectionMode);
        listenPiP(doc.getElementById("queue-remove-selected"), "click", requestBulkQueueRemoval);
        listenPiP(doc.getElementById("queue-confirm-remove"), "click", removeSelectedQueueItems);
        listenPiP(doc.getElementById("queue-keep-selection"), "click", () => {
            queueBulkConfirm = false;
            updateQueueSelectionToolbar(doc);
        });
        listenPiP(doc.getElementById("queue-cancel-selection"), "click", endQueueSelectionMode);
        listenPiP(queueButton, "keydown", (e) => {
            if (e.code === "Space" || e.key === " ") e.preventDefault();
        });
        listenPiP(queueButton, "keyup", (e) => {
            if (e.code === "Space" || e.key === " ") e.preventDefault();
        });
        listenPiP(doc.getElementById("queue-panel"), "contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        const scrollQueueFromWheel = (e) => {
            if (e.deltaY === 0) return;
            const menu = queueMenuEl && queueMenuEl.contains(e.target) ? queueMenuEl : null;
            if (menu) {
                const lineHeight = parseFloat(pipWindow.getComputedStyle(menu).lineHeight) || 16;
                const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE
                    ? e.deltaY * lineHeight
                    : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
                        ? e.deltaY * menu.clientHeight
                        : e.deltaY;
                menu.scrollTop += delta;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (!queueOpen) return;
            const list = doc.getElementById("queue-list");
            if (!list) return;

            const lineHeight = parseFloat(pipWindow.getComputedStyle(list).lineHeight) || 16;
            const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE
                ? e.deltaY * lineHeight
                : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
                    ? e.deltaY * list.clientHeight
                    : e.deltaY;
            list.scrollTop += delta;
            e.preventDefault();
            e.stopPropagation();
        };
        listenPiP(upcomingBar, "wheel", scrollQueueFromWheel, { passive: false });
        listenPiP(pipWindow, "wheel", (e) => {
            if (upcomingBar?.contains(e.target)) return;
            scrollQueueFromWheel(e);
        }, { capture: true, passive: false });

        // Close the queue's three-dots menu on an outside click, Escape, or scrolling the list
        listenPiP(doc, "mousedown", (e) => {
            if (!queueMenuEl) return;
            if (/** @type {HTMLElement} */ (e.target).closest(".queue-menu, .queue-more")) return;
            closeQueueMenu();
        });
        listenPiP(doc, "keydown", (e) => {
            if (e.key === "Escape") closeQueueMenu();
        });
        listenPiP(doc.getElementById("queue-list"), "scroll", closeQueueMenu);

        // Close Buttons
        listenPiP(doc.getElementById("btn-close"), "click", () => closeMiniPlayer());
        listenPiP(doc.getElementById("btn-close-compact"), "click", () => closeMiniPlayer());

        // Play / Pause
        const handlePlayPause = () => Spicetify.Player.togglePlay();
        listenPiP(doc.getElementById("btn-play-pause"), "click", handlePlayPause);
        listenPiP(doc.getElementById("btn-play-pause-compact"), "click", handlePlayPause);

        // Prev & Next
        const handlePrev = () => Spicetify.Player.back();
        const handleNext = () => Spicetify.Player.next();
        listenPiP(doc.getElementById("btn-prev"), "click", handlePrev);
        listenPiP(doc.getElementById("btn-prev-compact"), "click", handlePrev);
        listenPiP(doc.getElementById("btn-next"), "click", handleNext);
        listenPiP(doc.getElementById("btn-next-compact"), "click", handleNext);

        // Shuffle & Repeat (standard + compact buttons)
        ["btn-shuffle", "btn-shuffle-compact"].forEach(id => {
            listenPiP(doc.getElementById(id), "click", () => {
                Spicetify.Player.toggleShuffle();
                safeSetTimeout(() => syncPlayerState(["shuffle"]), 100);
            });
        });
        ["btn-repeat", "btn-repeat-compact"].forEach(id => {
            listenPiP(doc.getElementById(id), "click", () => {
                Spicetify.Player.toggleRepeat();
                safeSetTimeout(() => syncPlayerState(["repeat"]), 100);
            });
        });

        // Progress Scrubber
        const progressSlider = doc.getElementById("progress-slider");
        if (progressSlider) {
            const resetUserSeeking = () => {
                if (!isUserSeeking) return;
                isUserSeeking = false;
                startProgressLoop();
            };
            listenPiP(progressSlider, "pointerdown", (e) => {
                isUserSeeking = true;
                try { progressSlider.setPointerCapture(e.pointerId); } catch (err) {}
            });
            listenPiP(progressSlider, "pointerup", resetUserSeeking);
            listenPiP(progressSlider, "pointercancel", resetUserSeeking);
            listenPiP(progressSlider, "lostpointercapture", resetUserSeeking);
            listenPiP(progressSlider, "blur", resetUserSeeking);
            listenPiP(doc, "pointerup", resetUserSeeking);
            listenPiP(doc, "pointercancel", resetUserSeeking);
            listenPiP(pipWindow, "blur", resetUserSeeking);
            listenPiP(progressSlider, "input", (e) => {
                const duration = playerState.duration;
                // @ts-ignore
                const pct = (e.target.value / PROGRESS_STEPS);
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
            listenPiP(progressSlider, "change", (e) => {
                // @ts-ignore
                const pct = (e.target.value / PROGRESS_STEPS);
                seekToMs(pct * playerState.duration);
                isUserSeeking = false;
                updatePlayerState({ progress: pct * playerState.duration });
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
            doc.getElementById("btn-volume-icon")?.classList.toggle("active", open);
            if (open) {
                updateVolumeUI();
                resetVolumePopupTimer();
            } else {
                safeClearTimeout(volumePopupTimer);
            }
        };

        listenPiP(volumeTrigger, "click", () => setVolumePopup(!isVolumePopupOpen()));

        // Any interaction inside the popup counts as activity and restarts the 2s timer
        listenPiP(volumePopup, "pointermove", () => {
            if (isVolumePopupOpen()) resetVolumePopupTimer();
        });

        // Clicking anywhere outside the popup closes it
        listenPiP(doc, "mousedown", (e) => {
            if (!isVolumePopupOpen()) return;
            const target = /** @type {HTMLElement} */ (e.target);
            if (target.closest("#volume-popup, #btn-volume-compact, #btn-volume-icon")) return;
            setVolumePopup(false);
        });

        ["volume-slider", "volume-slider-compact"].forEach(id => {
            const slider = doc.getElementById(id);
            if (!slider) return;
            listenPiP(slider, "pointerdown", (e) => {
                isAdjustingVolume = true;
                try { slider.setPointerCapture(e.pointerId); } catch (err) {}
            });
            const endVolumeAdjustment = () => { isAdjustingVolume = false; };
            listenPiP(slider, "pointerup", endVolumeAdjustment);
            listenPiP(slider, "pointercancel", endVolumeAdjustment);
            listenPiP(slider, "lostpointercapture", endVolumeAdjustment);
            listenPiP(slider, "input", (e) => {
                // @ts-ignore
                const val = parseFloat(e.target.value) / 100;
                Spicetify.Player.setVolume(val);
                updatePlayerState({ volume: val });
                updateVolumeUI();
                if (isVolumePopupOpen()) resetVolumePopupTimer();
            });
        });
        listenPiP(doc, "pointerup", () => { isAdjustingVolume = false; });
        listenPiP(doc, "pointercancel", () => { isAdjustingVolume = false; });
        listenPiP(pipWindow, "blur", () => { isAdjustingVolume = false; });

        ["btn-volume-icon", "btn-volume-icon-compact"].forEach(id => {
            listenPiP(doc.getElementById(id), "click", () => {
                // Narrow window: the speaker opens the volume row (like Compact) instead of muting
                if (id === "btn-volume-icon" && doc.body.classList.contains("vol-icon-only")) {
                    setVolumePopup(!isVolumePopupOpen());
                    return;
                }
                Spicetify.Player.toggleMute();
                if (isVolumePopupOpen()) resetVolumePopupTimer();
                safeSetTimeout(() => syncPlayerState(["volume"]), 100);
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
            listenPiP(card, "wheel", (e) => {
                if (!settings.scrollAdjust) return;
                e.preventDefault();
                if (e.deltaY === 0) return;
                const dir = e.deltaY < 0 ? 1 : -1;
                const target = /** @type {HTMLElement} */ (e.target);

                if (target.closest("#progress-section")) {
                    const duration = playerState.duration;
                    if (!duration) return;
                    const now = Date.now();
                    // Chain rapid scrolls from the last target so steps stack up before the seek lands
                    const base = (lastWheelSeekMs !== null && now - lastWheelSeekAt < 600)
                        ? lastWheelSeekMs
                        : playerState.progress;
                    const next = Math.min(Math.max(duration - 1000, 0), Math.max(0, base + dir * settings.seekStep * 1000));
                    lastWheelSeekMs = next;
                    lastWheelSeekAt = now;
                    seekToMs(next);
                    updatePlayerState({ progress: next });

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
                        slider.value = String(Math.round((next / duration) * PROGRESS_STEPS));
                        updateSliderFill(slider, (next / duration) * 100);
                    }
                } else {
                    const current = playerState.volume || 0;
                    const next = Math.min(1, Math.max(0, Math.round((current + dir * settings.volumeStep / 100) * 100) / 100));
                    Spicetify.Player.setVolume(next);
                    updatePlayerState({ volume: next });
                    // Compact has no visible slider, so show the volume row; Mini shows a brief readout
                    if (currentMode === "compact" || doc.body.classList.contains("vol-icon-only") || doc.body.classList.contains("mini-vol")) {
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
            listenPiP(root, "mouseenter", wake);
            // Safety net: any movement over the window counts as hovering, even if mouseenter was missed
            listenPiP(doc, "mousemove", () => {
                if (!mouseInside || doc.body.classList.contains("idle")) wake();
            });
            listenPiP(root, "mouseleave", (e) => {
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
        listenPiP(pipWindow, "mouseup", saveWindowPosition);
        listenPiP(pipWindow, "blur", saveWindowPosition);

        // Resume visual progress loop immediately when PiP document becomes visible
        listenPiP(doc, "visibilitychange", () => {
            if (!doc.hidden) {
                updateProgressVisuals();
                if (playerState.isPlaying) {
                    startProgressLoop();
                }
            }
        });

        applyModeLayout();
    }

    function applyModeLayout() {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        if (currentMode !== "standard") {
            if (lyricsTextMode === "both") lyricsTextMode = "original";
            doc.body.classList.remove("lyrics-mode", "lyrics-both");
            for (const button of doc.querySelectorAll("#btn-lyrics, #btn-lyrics-compact")) {
                button.classList.remove("active");
                button.setAttribute("aria-pressed", "false");
                button.title = "Show SpicyLyrics";
                button.setAttribute("aria-label", button.title);
            }
            stopLyricsAdapter();
        }
        // Popup only exists in compact mode; close it when the layout changes
        doc.getElementById("volume-popup")?.classList.remove("open");
        doc.body.classList.remove("volume-open");
        doc.getElementById("btn-volume-compact")?.classList.remove("active");
        // Compact and Mini share the compact layout; Mini then strips it down further
        doc.body.classList.toggle("compact-mode", currentMode !== "standard");
        doc.body.classList.toggle("mini-mode", currentMode === "mini");
        lastUpcomingKey = null;
        updateUpcomingBar();
        // The cover's hover icon / Mini button show the mode you'd switch to
        refreshModeUi();
        resizePiPWindowToMode();
        renderFullUI();
        safeSetTimeout(updateMarqueeEffect, 100);
    }

    function resizePiPWindowToMode() {
        if (!isPiPWindowOpen()) return;

        // Dynamic resizing: the window size belongs to the user. The one exception is the queue, which
        // needs some height, so the window grows while it's open and returns to its old size afterwards.
        if (settings.dynamicResize) {
            const state = fluidState();
            const iw = pipWindow.innerWidth;
            const ih = pipWindow.innerHeight;
            try {
                if (queueOpen) {
                    if (!state.prevSize) state.prevSize = { w: iw, h: ih };
                    if (ih < FLUID_QUEUE_MIN_HEIGHT) {
                        pipWindow.resizeTo(iw + pipWindowFrameWidth, FLUID_QUEUE_MIN_HEIGHT + pipWindowFrameHeight);
                    }
                } else if (state.prevSize) {
                    const prev = state.prevSize;
                    state.prevSize = null;
                    // Only restore if the user didn't resize the window themselves while the queue was open
                    if (Math.abs(ih - FLUID_QUEUE_MIN_HEIGHT) <= 2) {
                        pipWindow.resizeTo(prev.w + pipWindowFrameWidth, prev.h + pipWindowFrameHeight);
                    }
                }
            } catch (err) {
                console.warn("[MiniPlayer] Unable to resize the window:", err);
            }
            if (!queueOpen) applyFluidLayout(true);
            return;
        }

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
        if (!isPiPWindowOpen()) return;
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
            const clone = /** @type {HTMLElement} */ (titleEl.cloneNode(true));
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

    // Artist names as individual links (one per artist), or plain text when there are no artist URIs
    function appendArtistLinks(doc, parent, meta) {
        if (!meta.artistList.length) {
            parent.appendChild(doc.createTextNode(meta.artist));
            return;
        }
        meta.artistList.forEach((a, i) => {
            if (i > 0) parent.appendChild(doc.createTextNode(", "));
            const span = doc.createElement("span");
            span.className = "artist-link" + (a.uri ? " linkable" : "");
            span.textContent = a.name;
            if (a.uri) span.dataset.uri = a.uri;
            parent.appendChild(span);
        });
    }

    function renderFullUI() {
        if (!isPiPWindowOpen()) return;
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

            // In Mini Mode, combine Title and Artist on the same line.
            if (currentMode === "mini" && meta.artist) {
                const artistInline = doc.createElement("span");
                artistInline.className = "track-artist-inline";
                artistInline.appendChild(doc.createTextNode(" \u00b7 "));
                appendArtistLinks(doc, artistInline, meta);
                titleEl.appendChild(artistInline);
            }
        }
        if (artistEl) {
            artistEl.title = meta.artist;
            artistEl.textContent = "";
            appendArtistLinks(doc, artistEl, meta);
        }

        updateMarqueeEffect();

        // Cover Art & Ambient BG
        const coverEl = doc.getElementById("cover-img");
        const ambientBg = doc.getElementById("ambient-bg");
        const coverUrl = meta.cover || "";
        if (coverEl && coverEl.dataset.src !== coverUrl) {
            coverEl.dataset.src = coverUrl;
            if (coverUrl) {
                // @ts-ignore
                coverEl.src = coverUrl;
            } else {
                coverEl.removeAttribute("src");
            }
        }
        if (ambientBg && ambientBg.dataset.src !== coverUrl) {
            ambientBg.dataset.src = coverUrl;
            ambientBg.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : "none";
        }

        // Duration Label
        const durationEl = doc.getElementById("time-duration");
        if (durationEl) {
            durationEl.textContent = formatTime(meta.duration);
            // Hour-long audio needs wider time labels (1:23:45), or the scrubber resizes as the time ticks over
            doc.getElementById("miniplayer-card")?.classList.toggle("long-form", meta.duration >= 3600000);
        }
        renderProgressUI();

        // Controls
        updatePlayPauseButton();
        updateShuffleRepeatState();

        // Volume
        updateVolumeUI();
        syncEpisodeVideo();
    }

    function stopLyricsAdapter() {
        if (lyricsPollTimerId !== null) {
            window.clearInterval(lyricsPollTimerId);
            lyricsPollTimerId = null;
        }
        if (lyricsRefreshTimerId !== null) {
            window.clearTimeout(lyricsRefreshTimerId);
            lyricsRefreshTimerId = null;
        }
        lyricsObserver?.disconnect();
        lyricsObserver = null;
        lyricsSource = null;
        lastLyricsSnapshotKey = "";
        lyricsTrackUri = "";
        lyricsStaleSig = "";
        lyricsStaleUntil = 0;
        lyricsRomanizationAvailable = false;
        syncLyricsTextModeButton();
        setLyricsSourceLabel("");
    }

    function syncLyricsTextModeButton() {
        if (!isPiPWindowOpen()) return;
        const label = LYRICS_TEXT_MODE_LABELS[lyricsTextMode];
        const text = lyricsRomanizationAvailable ? label : "";
        const title = lyricsRomanizationAvailable
            ? `Lyrics text: ${label} (click to cycle)`
            : "Showing SpicyLyrics' selected text; choose Under each line in SpicyLyrics to switch variants";
        for (const button of pipWindow.document.querySelectorAll("#btn-lyrics-text-mode")) {
            button.disabled = !lyricsRomanizationAvailable;
            button.classList.toggle("unavailable", !lyricsRomanizationAvailable);
            button.textContent = text;
            button.title = title;
            button.setAttribute("aria-label", title);
        }
    }

    function renderLyricsSnapshot(status, current = "", next = "") {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        const currentEl = doc.getElementById("lyrics-current");
        const nextEl = doc.getElementById("lyrics-next");
        if (!currentEl || !nextEl) return;

        const key = [status, current, next].join("\u0000");
        if (key === lastLyricsSnapshotKey) return;
        lastLyricsSnapshotKey = key;
        currentEl.textContent = current || status;
        nextEl.textContent = next;
        nextEl.classList.toggle("is-empty", !next);
    }

    function setLyricsSourceLabel(source = "") {
        if (!isPiPWindowOpen()) return;
        const label = pipWindow.document.getElementById("lyrics-source");
        if (label) label.textContent = source ? `Source: ${source}` : "";
    }

    function normalizeLyricsText(text) {
        return text
            .replace(/\s+/g, " ")
            .replace(/\s+([,.;!?…:;])/g, "$1")
            .replace(/([([{“‘])\s+/g, "$1")
            .trim();
    }

    function getSpicyLyricsLineText(line) {
        const primaryLine = line.cloneNode(true);
        primaryLine.querySelectorAll(".RomanizedRow").forEach(row => row.remove());
        const words = Array.from(primaryLine.children)
            .filter(element =>
                element.matches(".word, .word-group, .letterGroup")
                && !element.classList.contains("dot")
            )
            .map(element => element.textContent.replace(/\s+/g, " ").trim())
            .filter(Boolean);
        return normalizeLyricsText(words.length ? words.join(" ") : primaryLine.textContent);
    }

    function getSpicyLyricsRomanizedText(line) {
        const row = line.querySelector(".RomanizedRow");
        return row ? normalizeLyricsText(row.textContent) : "";
    }

    function findVisibleSpicyLyricsLine(lines, content, page) {
        const viewport = content.querySelector(".simplebar-content-wrapper")
            || page.querySelector(".LyricsContainer")
            || content;
        const viewportRect = viewport.getBoundingClientRect();
        const viewportHeight = viewport.clientHeight || viewportRect.height;
        if (viewportHeight <= 0) return null;

        const viewportBottom = viewportRect.top + viewportHeight;
        const center = viewportRect.top + viewportHeight / 2;
        let closestLine = null;
        let closestDistance = Infinity;
        for (const line of lines) {
            const rect = line.element.getBoundingClientRect();
            if (rect.bottom <= viewportRect.top || rect.top >= viewportBottom) continue;
            const distance = Math.abs((rect.top + rect.bottom) / 2 - center);
            if (distance < closestDistance) {
                closestLine = line;
                closestDistance = distance;
            }
        }
        return closestLine;
    }

    function getLyricsLineData(element) {
        const raw = element.textContent || "";
        const cached = lyricsLineCache.get(element);
        if (cached && cached.raw === raw) return cached.data;
        const data = {
            element,
            original: getSpicyLyricsLineText(element),
            romanized: getSpicyLyricsRomanizedText(element)
        };
        lyricsLineCache.set(element, { raw, data });
        return data;
    }

    // Cheap fingerprint of the lyrics on screen (line count + first/last line), used to tell
    // "SpicyLyrics still shows the previous song" from "the new lyrics have arrived"
    function getLyricsContentSig(content) {
        const els = content.querySelectorAll(".line");
        if (!els.length) return "0";
        return `${els.length}|${(els[0].textContent || "").slice(0, 40)}|${(els[els.length - 1].textContent || "").slice(0, 40)}`;
    }

    // ---------------------------------------------------------------------------------------------
    // LRCLIB fallback: synced lyrics from lrclib.net (free, no API key) when SpicyLyrics can't supply
    // them (page closed, still loading, or no lyrics). The active line is computed from our own
    // playback clock, so SpicyLyrics doesn't have to be open at all.
    // ---------------------------------------------------------------------------------------------
    const LRCLIB_API = "https://lrclib.net/api";
    const LRCLIB_STORE_KEY = "miniplayer_lrclib_v1";
    const LRCLIB_MAX_ENTRIES = 60;           // cached songs kept in localStorage (oldest dropped first)
    const LRCLIB_MISS_TTL_MS = 12 * 3600e3;  // "no synced lyrics" answers are re-checked after 12 h
    const LRCLIB_ERROR_RETRY_MS = 30000;     // network failures are retried after 30 s
    const LRCLIB_TIMEOUT_MS = 7000;
    const LRCLIB_OFFSET_MS = 150;            // show lines slightly early: covers the poll interval + reading time
    const lrclibRuntime = new Map();         // uri -> { state: "loading" | "error", at }
    let lrclibStore = null;

    function lrclibLoadStore() {
        if (lrclibStore) return lrclibStore;
        try { lrclibStore = JSON.parse(localStorage.getItem(LRCLIB_STORE_KEY) || "{}") || {}; }
        catch (e) { lrclibStore = {}; }
        return lrclibStore;
    }

    function lrclibSaveStore() {
        const store = lrclibLoadStore();
        const keys = Object.keys(store);
        if (keys.length > LRCLIB_MAX_ENTRIES) {
            keys.sort((a, b) => (store[a].t || 0) - (store[b].t || 0))
                .slice(0, keys.length - LRCLIB_MAX_ENTRIES)
                .forEach(key => delete store[key]);
        }
        try { localStorage.setItem(LRCLIB_STORE_KEY, JSON.stringify(store)); } catch (e) {}
    }

    // "[01:23.45] text" (also several stamps per line and 2/3-digit fractions) -> sorted [[ms, text], ...]
    function parseLrc(text) {
        const out = [];
        for (const raw of String(text || "").split(/\r?\n/)) {
            const stamps = Array.from(raw.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g));
            if (!stamps.length) continue;
            const lyric = raw
                .replace(/\[[^\]]*\]/g, "")
                .replace(/<\d+:\d+(?:[.:]\d+)?>/g, "") // enhanced-LRC word stamps
                .replace(/\s+/g, " ")
                .trim();
            for (const m of stamps) {
                const frac = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) : 0;
                out.push([Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac, lyric]);
            }
        }
        return out.sort((a, b) => a[0] - b[0]);
    }

    function cleanTitleForSearch(title) {
        return String(title || "")
            .replace(/\s*[-\u2013]\s*(remaster(ed)?|\d{4}\b|live|mono|stereo|single version|radio edit|deluxe|bonus).*$/i, "")
            .replace(/\s*[(\[](feat|ft|with)\b[^)\]]*[)\]]/ig, "")
            .trim();
    }

    async function lrclibGetJson(url) {
        const ctl = new AbortController();
        const timer = window.setTimeout(() => ctl.abort(), LRCLIB_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: ctl.signal });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            // Some Spotify builds restrict fetch() to known hosts: retry through Spotify's own HTTP client
            if (Spicetify.CosmosAsync?.get && !(err && err.name === "AbortError")) {
                try { return await Spicetify.CosmosAsync.get(url); }
                catch (cosmosErr) {
                    if (cosmosErr && (cosmosErr.status === 404 || /404/.test(String(cosmosErr.message || cosmosErr)))) return null;
                    throw cosmosErr;
                }
            }
            throw err;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function lrclibQueryFor(item) {
        const md = item.metadata || {};
        return {
            title: item.name || md.title || "",
            artist: (item.artists && item.artists[0]?.name) || md.artist_name || "",
            album: item.album?.name || md.album_title || "",
            durationSec: Math.round((item.duration?.milliseconds || Spicetify.Player.getDuration() || 0) / 1000)
        };
    }

    // Exact lookup first, then looser searches; the closest duration wins (a wrong cut is worse than none)
    async function lrclibLookup(q) {
        const usable = (r) => r && (r.instrumental || r.syncedLyrics);
        const closest = (list) => {
            const ok = (Array.isArray(list) ? list : []).filter(usable);
            if (!ok.length) return null;
            if (!q.durationSec) return ok[0];
            ok.sort((a, b) => Math.abs((a.duration || 0) - q.durationSec) - Math.abs((b.duration || 0) - q.durationSec));
            return Math.abs((ok[0].duration || 0) - q.durationSec) <= 5 ? ok[0] : null;
        };
        const qs = (o) => new URLSearchParams(o).toString();

        let hit = await lrclibGetJson(`${LRCLIB_API}/get?${qs({
            track_name: q.title, artist_name: q.artist, album_name: q.album, duration: String(q.durationSec)
        })}`);
        if (usable(hit)) return hit;

        const cleaned = cleanTitleForSearch(q.title);
        hit = closest(await lrclibGetJson(`${LRCLIB_API}/search?${qs({ track_name: q.title, artist_name: q.artist })}`));
        if (hit) return hit;
        if (cleaned && cleaned !== q.title) {
            hit = closest(await lrclibGetJson(`${LRCLIB_API}/search?${qs({ track_name: cleaned, artist_name: q.artist })}`));
            if (hit) return hit;
        }
        return closest(await lrclibGetJson(`${LRCLIB_API}/search?${qs({ q: `${cleaned || q.title} ${q.artist}`.trim() })}`));
    }

    async function lrclibFetchFor(item) {
        const uri = item.uri;
        lrclibRuntime.set(uri, { state: "loading", at: Date.now() });
        try {
            const hit = await lrclibLookup(lrclibQueryFor(item));
            const store = lrclibLoadStore();
            if (hit && hit.instrumental) store[uri] = { t: Date.now(), ins: true };
            else if (hit && hit.syncedLyrics) {
                const lines = parseLrc(hit.syncedLyrics);
                store[uri] = lines.length ? { t: Date.now(), lines } : { t: Date.now(), lines: null };
            } else store[uri] = { t: Date.now(), lines: null };
            lrclibSaveStore();
            lrclibRuntime.delete(uri);
        } catch (err) {
            console.warn("[MiniPlayer] LRCLIB lookup failed:", err);
            lrclibRuntime.set(uri, { state: "error", at: Date.now() });
        }
        if (Spicetify.Player.data?.item?.uri === uri) refreshLyricsAdapter(); // paint as soon as it lands
    }

    // -> { state: "ready" | "loading" | "none", lines?, instrumental? } for the track playing right now
    function getLrclibForCurrentTrack() {
        const item = Spicetify.Player.data?.item;
        const uri = item?.uri || "";
        if (!uri || uri.startsWith("spotify:episode:") || item.type === "episode") return { state: "none" };

        const entry = lrclibLoadStore()[uri];
        if (entry) {
            if (entry.ins) return { state: "ready", lines: [], instrumental: true };
            if (entry.lines && entry.lines.length) return { state: "ready", lines: entry.lines };
            if (Date.now() - (entry.t || 0) < LRCLIB_MISS_TTL_MS) return { state: "none" };
        }
        const run = lrclibRuntime.get(uri);
        if (run) {
            if (run.state === "loading") return { state: "loading" };
            if (Date.now() - run.at < LRCLIB_ERROR_RETRY_MS) return { state: "none" };
        }
        lrclibFetchFor(item);
        return { state: "loading" };
    }

    function lrclibLineIndexAt(lines, ms) {
        let lo = 0, hi = lines.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lines[mid][0] <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return idx;
    }

    let lyricsLrclibLoading = false; // LRCLIB lookup in flight for the current track

    function renderLrclibLine(lrc) {
        setLyricsSourceLabel("LRCLIB");
        if (lrc.instrumental) {
            renderLyricsSnapshot("\u266a Instrumental");
            return;
        }
        const idx = lrclibLineIndexAt(lrc.lines, getPlaybackProgress() + LRCLIB_OFFSET_MS);
        const current = idx >= 0 ? lrc.lines[idx][1] : "";
        const next = lyricsTextMode === "both" ? (lrc.lines[idx + 1]?.[1] || "") : "";
        renderLyricsSnapshot("", current || "\u266a", next);
    }

    // Status text for when neither source has lines (LRCLIB is always tried first, in refreshLyricsAdapter)
    function renderLyricsFallback(status) {
        lyricsRomanizationAvailable = false;
        syncLyricsTextModeButton();
        setLyricsSourceLabel("");
        renderLyricsSnapshot(lyricsLrclibLoading ? "Loading lyrics\u2026" : status);
    }

    function refreshLyricsAdapter() {
        if (!isPiPWindowOpen() || !pipWindow.document.body.classList.contains("lyrics-mode")) return;

        const page = document.querySelector("#SpicyLyricsPage");
        const content = page?.querySelector(".LyricsContainer .LyricsContent")
            || page?.querySelector(".LyricsContent")
            || null;

        if (content !== lyricsSource) {
            lyricsObserver?.disconnect();
            lyricsObserver = null;
            lyricsSource = content;
            if (content) {
                lyricsObserver = new MutationObserver(records => {
                    if (records.some(record =>
                        record.type === "childList"
                        || record.type === "characterData"
                        || (record.type === "attributes" && record.target.matches(".line"))
                    )) {
                        if (lyricsRefreshTimerId !== null) return;
                        lyricsRefreshTimerId = window.setTimeout(() => {
                            lyricsRefreshTimerId = null;
                            refreshLyricsAdapter();
                        }, LYRICS_REFRESH_DEBOUNCE_MS);
                    }
                });
                lyricsObserver.observe(content, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: ["class"]
                });
            }
        }

        // Stale guard: right after a track change SpicyLyrics keeps the previous song's lines until it re-renders
        const trackUri = Spicetify.Player.data?.item?.uri || "";
        if (trackUri !== lyricsTrackUri) {
            lyricsTrackUri = trackUri;
            lyricsStaleSig = content ? getLyricsContentSig(content) : "";
            lyricsStaleUntil = Date.now() + LYRICS_STALE_TIMEOUT_MS;
        }

        // LRCLIB is the preferred source. SpicyLyrics is used when LRCLIB has nothing for this track, or
        // when a romanized view is requested and SpicyLyrics has romanization (LRCLIB has none).
        const spicyHasRomanization = !!content?.querySelector(".RomanizedRow");
        const lrc = getLrclibForCurrentTrack();
        lyricsLrclibLoading = lrc.state === "loading";
        if (lrc.state === "ready" && !(lyricsTextMode !== "original" && spicyHasRomanization)) {
            lyricsRomanizationAvailable = spicyHasRomanization; // keeps the text-mode button usable
            syncLyricsTextModeButton();
            renderLrclibLine(lrc);
            return;
        }

        if (!page) {
            renderLyricsFallback(
                window.SpicyLyrics ? "No lyrics found. Open SpicyLyrics to try." : "No lyrics found"
            );
            return;
        }
        if (!content) {
            renderLyricsFallback("Waiting for SpicyLyrics lyrics…");
            return;
        }

        if (lyricsStaleUntil) {
            const sig = getLyricsContentSig(content);
            if (sig !== lyricsStaleSig || Date.now() >= lyricsStaleUntil) {
                lyricsStaleUntil = 0; // new lyrics arrived (or we waited long enough): trust the view again
            } else {
                renderLyricsFallback("Loading lyrics…");
                return;
            }
        }

        setLyricsSourceLabel("SpicyLyrics");
        // Only the active line is parsed (and cached); the rest of the song is never touched
        lyricsRomanizationAvailable = spicyHasRomanization; // already measured above
        syncLyricsTextModeButton();

        // Look for the active line first: that's one small query. The full line list (hundreds of nodes on a
        // long song) is only needed when nothing is active, e.g. before the first line.
        const activeEls = content.querySelectorAll(".line.Active");
        let active = null;
        let isActiveLine = false;
        if (activeEls.length) {
            active = getLyricsLineData(activeEls[activeEls.length - 1]);
            isActiveLine = true;
        } else {
            const lineEls = content.querySelectorAll(".line");
            if (!lineEls.length) {
                renderLyricsFallback("No lyric lines are available yet");
                return;
            }
            const visible = findVisibleSpicyLyricsLine(Array.from(lineEls, element => ({ element })), content, page);
            active = visible ? getLyricsLineData(visible.element) : null;
        }
        if (!active) {
            renderLyricsSnapshot("...");
            return;
        }
        // An active line with no words is an instrumental gap
        const gap = isActiveLine ? "\u266a" : "...";
        if (lyricsTextMode === "romanized") {
            renderLyricsSnapshot("", active.romanized || active.original || gap);
        } else if (lyricsTextMode === "both") {
            renderLyricsSnapshot("", active.original || gap, active.romanized || "");
        } else {
            renderLyricsSnapshot("", active.original || gap);
        }
    }

    function startLyricsAdapter() {
        stopLyricsAdapter();
        renderLyricsSnapshot("Looking for lyrics…");
        lyricsTrackUri = Spicetify.Player.data?.item?.uri || ""; // the lyrics already on screen belong to this track
        refreshLyricsAdapter();
        lyricsPollTimerId = window.setInterval(() => {
            if (isPiPWindowOpen() && !pipWindow.document.hidden) refreshLyricsAdapter();
        }, LYRICS_POLL_INTERVAL_MS);
    }

    function updatePlayPauseButton() {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        const btnStandard = doc.getElementById("btn-play-pause");
        const btnCompact = doc.getElementById("btn-play-pause-compact");
        const isPlaying = playerState.isPlaying;
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
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;
        const isShuffle = playerState.shuffle;
        const repeatState = playerState.repeat;
        const isRepeat = repeatState > 0;
        const isRepeatOne = repeatState === 2;
        const repeatTitle = repeatState === 0
            ? "Enable Repeat"
            : repeatState === 1
                ? "Enable Repeat One"
                : "Disable Repeat One";
        ["btn-shuffle", "btn-shuffle-compact"].forEach(id => {
            const button = doc.getElementById(id);
            if (!button) return;
            button.classList.toggle("active", isShuffle);
            button.title = isShuffle ? "Disable Shuffle" : "Enable Shuffle";
        });
        ["btn-repeat", "btn-repeat-compact"].forEach(id => {
            const button = doc.getElementById(id);
            if (!button) return;
            button.classList.toggle("active", isRepeat);
            button.classList.toggle("repeat-one", isRepeatOne);
            button.title = repeatTitle;
        });
    }

    function updateVolumeUI() {
        if (!isPiPWindowOpen()) return;
        const doc = pipWindow.document;

        const pct = Math.round((playerState.volume || 0) * 100);
        ["volume-slider", "volume-slider-compact"].forEach(id => {
            const s = doc.getElementById(id);
            if (!s) return;
            // @ts-ignore
            s.value = String(pct);
            updateSliderFill(s, pct);
        });
        const icon = pct === 0 ? ICONS.volumeMute : pct <= 60 ? ICONS.volumeMedium : ICONS.volumeHigh;
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
        if (!isPiPWindowOpen() || isUserSeeking) return;
        syncPlayerState(["progress"]);
    }

    function renderProgressUI() {
        if (!isPiPWindowOpen() || isUserSeeking) return;
        const doc = pipWindow.document;

        const currentMs = playerState.progress || 0;
        const durationMs = playerState.duration || 0;

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
            const sliderVal = Math.round(pct * PROGRESS_STEPS);
            if (sliderVal !== lastSliderValue) {
                lastSliderValue = sliderVal;
                // @ts-ignore
                slider.value = String(sliderVal);
                updateSliderFill(slider, pct * 100);
            }
        }
    }

    function startProgressLoop() {
        if (rafId !== null || progressTimerId !== null) return;
        const resources = pipResources;
        if (!isPiPWindowOpen() || !resources) return;

        const paint = () => {
            rafId = null;
            if (!isPiPWindowOpen() || !playerState.isPlaying || pipWindow.document.hidden) return;

            const now = Date.now();
            // One scrubber step is duration / PROGRESS_STEPS long, so a 3 hour episode doesn't need 60 repaints a second
            const gap = Math.min(500, Math.max(33, (playerState.duration || 0) / PROGRESS_STEPS / 2));
            if (!isUserSeeking && now - lastProgressPaint >= gap) {
                lastProgressPaint = now;
                updateProgressVisuals();
            }

            const delay = isUserSeeking ? gap : Math.max(0, gap - (now - lastProgressPaint));
            progressTimerId = resources.setTimeout(() => {
                progressTimerId = null;
                if (!isPiPWindowOpen() || !playerState.isPlaying || pipWindow.document.hidden) return;
                rafId = resources.requestAnimationFrame(paint);
            }, delay);
        };

        rafId = resources.requestAnimationFrame(paint);
    }

    function syncPlayerStateTick() {
        if (!isPiPWindowOpen()) return;
        syncPlayerState(["currentTrack", "isPlaying", "duration", "volume", "shuffle", "repeat"]);
        if (pipWindow.document.hidden || !playerState.isPlaying) updateProgressVisuals();
    }

    // Attach Spicetify Event Listeners for live sync
    Spicetify.Player.addEventListener("songchange", () => {
        if (isPiPWindowOpen()) {
            lastFormattedTime = "";
            lastSliderValue = -1;
            syncPlayerState(["currentTrack", "isPlaying", "progress", "duration", "volume", "shuffle", "repeat"]);
            safeSetTimeout(() => syncPlayerState(["queue"]), 400); // the queue settles just after the song changes
            startProgressLoop();
        }
    });

    Spicetify.Player.addEventListener("onplaypause", () => {
        if (isPiPWindowOpen()) {
            syncPlayerState(["isPlaying", "progress"]);
        }
    });

    // Register UI Buttons inside Spotify Client
    function registerButtons() {
        // 1. Topbar Button: opens the mini player's settings (the configured shortcut toggles the player)
        if (Spicetify.Topbar?.Button) {
            try {
                new Spicetify.Topbar.Button(
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
                const shortcutLabel = `Mini Player (${formatToggleShortcut()})`;
                btn.setAttribute("aria-label", shortcutLabel);
                btn.style.background = "transparent";
                btn.style.border = "none";
                btn.style.color = isPiPWindowOpen() ? "#1db954" : "#b3b3b3";
                btn.style.cursor = "pointer";
                btn.style.display = "inline-flex";
                btn.style.alignItems = "center";
                btn.style.justifyContent = "center";
                btn.style.padding = "6px";
                btn.innerHTML = ICONS.miniplayer;

                if (Spicetify.Tippy && Spicetify.TippyProps) {
                    Spicetify.Tippy(btn, {
                        content: shortcutLabel,
                        ...Spicetify.TippyProps
                    });
                } else {
                    btn.title = shortcutLabel;
                }

                btn.onmouseenter = () => btn.style.color = "#ffffff";
                btn.onmouseleave = () => {
                    btn.style.color = isPiPWindowOpen() ? "#1db954" : "#b3b3b3";
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
                updateButtonStates(isPiPWindowOpen());
                return true;
            };

            // Keeps the playback bar showing the right launcher as Spotify re-renders it:
            // - taking over Spotify's own button (found + setting on): hide ours, no extra icon
            // - otherwise (setting off, or Spotify's button not found): show ours
            syncPlaybarButtons = () => {
                const rightControls = document.querySelector(".main-nowPlayingBar-right")
                    || document.querySelector('[data-testid="now-playing-bar-right"]');
                const playbackBar = document.querySelector(".main-nowPlayingBar-container, [data-testid='now-playing-bar']")
                    || rightControls;
                const natives = findNativeMiniplayerButtons(playbackBar);
                const takeover = settings.replaceNative && natives.length > 0;
                natives.forEach((el) => {
                    if (takeover) el.setAttribute("data-mp-takeover", "true");
                    else el.removeAttribute("data-mp-takeover");
                });
                if (takeover) {
                    document.getElementById("miniplayer-playbar-btn")?.remove();
                } else {
                    addPlaybarIcon();
                }
                updateButtonStates(isPiPWindowOpen(), natives);
            };

            let playbarObserver = null;
            let syncQueued = false;
            const queueSync = () => {
                if (syncQueued) return;
                syncQueued = true;
                // Debounced: the playback bar re-renders constantly during playback and each sync scans the DOM
                setTimeout(() => {
                    syncQueued = false;
                    syncPlaybarButtons();
                }, 300);
            };
            const initPlaybarIcon = () => {
                const rightControls = document.querySelector(".main-nowPlayingBar-right") || document.querySelector('[data-testid="now-playing-bar-right"]');
                if (!rightControls) return false;
                syncPlaybarButtons();
                if (!playbarObserver) {
                    const target = document.querySelector(".main-nowPlayingBar-container") || rightControls || document.body;
                    playbarObserver = new MutationObserver(queueSync);
                    playbarObserver.observe(target, { childList: true, subtree: true });
                }
                return true;
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

        // 2b. Take over Spotify's and SpicyLyrics' "Open in Miniplayer" buttons before their handlers run.
        try {
            const takeoverStyle = document.createElement("style");
            takeoverStyle.id = "miniplayer-takeover-style";
            takeoverStyle.textContent = `[data-mp-active="true"], [data-mp-active="true"] svg { color: #1ed760 !important; fill: #1ed760 !important; }`;
            document.head.appendChild(takeoverStyle);

            document.addEventListener("click", (e) => {
                if (!settings.replaceNative) return;
                const t = /** @type {any} */ (e.target);
                const el = t && t.closest ? t.closest("button, [role='button']") : null;
                if (!el || (!isNativeMiniplayerButton(el) && !isOpenMiniplayerButton(el))) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                toggleMiniPlayer();
            }, true);
        } catch (e) {
            console.warn("[MiniPlayer] Could not set up the native button takeover:", e);
        }

        // 3. Global mini player shortcut within Spotify
        window.addEventListener("keydown", (e) => {
            if (e.repeat || e.isComposing || !shortcutMatchesEvent(e)) return;
            const target = /** @type {HTMLElement} */ (e.target);
            const tag = target?.tagName?.toLowerCase();
            const isEditable = target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
            if (isEditable) return;

            e.preventDefault();
            toggleMiniPlayer();
        });
    }

    registerButtons();
})();
