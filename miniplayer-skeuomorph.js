// NAME: MiniPlayer - Skeuomorph Theme
// AUTHOR: pu1zly
// DESCRIPTION: Optional Skeuomorph player style for Spotify Mini Player

(function () {
    const definition = {
        id: "aero",
        label: "Skeuomorph",
        legacyIds: ["minimal"],
        sharedControls: {
            albumArtGradient: false,
            albumArtGradientMessage: "Skeuomorph uses metallic styling instead of an album-art glow."
        },
        previewCss: `
            .mp-style-preview.aero {
                height: 42px;
                border: 1px solid rgba(190, 245, 255, 0.62);
                border-radius: 11px;
                background: radial-gradient(ellipse at 18% 0%, rgba(111, 240, 213, 0.62), transparent 58%), linear-gradient(145deg, rgba(255, 255, 255, 0.28), rgba(40, 129, 157, 0.48));
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55), 0 2px 5px rgba(0, 0, 0, 0.22);
            }
            .mp-style-preview.aero .mp-style-preview-art {
                border-radius: 7px;
                background: linear-gradient(145deg, #c4f4ce, #52b9cf 55%, #66a8da);
                box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.7), 0 1px 3px rgba(0, 0, 0, 0.3);
            }
            .mp-style-preview.aero .mp-style-preview-control {
                background: linear-gradient(145deg, #d6ffe6, #72dfd1);
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75), 0 1px 3px rgba(4, 75, 96, 0.55);
            }
        `,
        css: `
            @media (min-width: 690px) and (min-height: 420px) {
                body.style-aero.podcast-video-active .miniplayer-card {
                    transition: background 0.35s ease;
                }
                body.style-aero.idle.podcast-video-active .miniplayer-card {
                    background: rgba(var(--mp-bg-rgb), calc(0.28 * var(--idle-opacity, 0.35)));
                }
            }
            body.style-aero {
                font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
                --mp-skeuo-metal-surface: linear-gradient(145deg, #c9cdd1 0%, #989ea4 24%, #62696f 54%, #b0b5ba 78%, #70777d 100%);
                --mp-skeuo-metal-readout: linear-gradient(145deg, #f1f3f5 0%, #d4d9dd 20%, #b8bfc5 48%, #e2e5e8 74%, #c0c7cd 100%);
            }
            body.style-aero button {
                border: 1px solid rgba(var(--mp-fg-rgb), 0.2);
                border-radius: 8px;
                background-color: rgba(var(--mp-bg-rgb), 0.24);
                background-image: linear-gradient(145deg, rgba(var(--mp-fg-rgb), 0.2), rgba(var(--mp-fg-rgb), 0.035) 44%, rgba(var(--mp-bg-rgb), 0.12));
                box-shadow:
                    inset 0 1px 0 rgba(var(--mp-fg-rgb), 0.34),
                    inset 0 -2px 3px rgba(var(--mp-bg-rgb), 0.24),
                    0 2px 5px rgba(var(--mp-accent-rgb), 0.18);
                transition: color 0.16s ease, background-color 0.16s ease, box-shadow 0.16s ease, transform 0.14s ease;
            }
            body.style-aero button:hover:not(:disabled) {
                background-color: rgba(var(--mp-accent-rgb), 0.2);
                box-shadow:
                    inset 0 1px 0 rgba(var(--mp-fg-rgb), 0.42),
                    inset 0 -2px 3px rgba(var(--mp-bg-rgb), 0.2),
                    0 0 0 1px rgba(var(--mp-accent-rgb), 0.18),
                    0 4px 10px rgba(var(--mp-accent-rgb), 0.26);
                transform: translateY(-1px);
            }
            body.style-aero button:active:not(:disabled) {
                box-shadow:
                    inset 0 2px 5px rgba(var(--mp-bg-rgb), 0.42),
                    inset 0 1px 0 rgba(var(--mp-fg-rgb), 0.18),
                    0 1px 2px rgba(var(--mp-accent-rgb), 0.16);
                transform: translateY(1px) scale(0.97);
            }
            body.style-aero button:focus-visible {
                outline: 2px solid var(--mp-accent);
                outline-offset: 2px;
            }
            body.style-aero button:disabled {
                cursor: default;
                filter: saturate(0.55);
                transform: none;
            }
            body.style-aero .player-surface::before {
                content: "";
                position: absolute;
                z-index: 0;
                inset: -28%;
                background:
                    radial-gradient(ellipse at 18% 13%, rgba(var(--mp-accent-rgb), 0.38), transparent 42%),
                    radial-gradient(ellipse at 78% 27%, rgba(var(--mp-fg-rgb), 0.13), transparent 38%),
                    radial-gradient(ellipse at 55% 100%, rgba(var(--mp-accent-rgb), 0.22), transparent 46%);
                filter: blur(24px);
                pointer-events: none;
            }
            body.style-aero .miniplayer-card {
                border: none;
                border-radius: 0;
                background:
                    linear-gradient(145deg, rgba(var(--mp-fg-rgb), 0.2), rgba(var(--mp-accent-rgb), 0.045) 42%, rgba(var(--mp-accent-rgb), 0.19)),
                    rgba(var(--mp-bg-rgb), 0.28);
                box-shadow: none;
                backdrop-filter: blur(18px) saturate(1.35);
            }
            body.style-aero.custom-background .player-surface::before {
                display: none;
            }
            body.style-aero.custom-background .miniplayer-card {
                background: rgba(var(--mp-bg-rgb), 0.28);
                backdrop-filter: none;
                transition: background 0.35s ease, backdrop-filter 0.35s ease;
            }
            body.idle.style-aero.custom-background .miniplayer-card {
                backdrop-filter: blur(18px) saturate(1.35);
            }
            body.style-aero .cover-container {
                box-sizing: border-box;
                padding: calc(3px * var(--s, 1));
                border: 1px solid #c5c8cb;
                border-radius: 12px;
                background: var(--mp-skeuo-metal-surface);
                box-shadow:
                    inset 0 1px 0 #ffffff,
                    inset 1px 0 0 #d8dbde,
                    inset 0 -2px 2px #535a61,
                    inset -1px 0 0 #686f76,
                    0 2px 4px rgba(0, 0, 0, 0.42),
                    0 5px 12px rgba(0, 0, 0, 0.28);
            }
            body.style-aero.compact-mode .cover-container {
                padding: calc(2px * var(--s, 1));
                border-radius: 10px;
            }
            body.style-aero.mini-mode .cover-container {
                padding: calc(1px * var(--s, 1));
                border-radius: 7px;
            }
            body.style-aero .cover-art,
            body.style-aero .cover-container.video-active .episode-video,
            body.style-aero .cover-overlay {
                border-radius: 8px;
            }
            body.style-aero.compact-mode .cover-art,
            body.style-aero.compact-mode .cover-container.video-active .episode-video,
            body.style-aero.compact-mode .cover-overlay {
                border-radius: 6px;
            }
            body.style-aero.mini-mode .cover-art,
            body.style-aero.mini-mode .cover-container.video-active .episode-video,
            body.style-aero.mini-mode .cover-overlay {
                border-radius: 4px;
            }
            body.style-aero .cover-container.video-active .episode-video,
            body.style-aero .cover-overlay {
                inset: calc(3px * var(--s, 1));
            }
            body.style-aero.compact-mode .cover-container.video-active .episode-video,
            body.style-aero.compact-mode .cover-overlay {
                inset: calc(2px * var(--s, 1));
            }
            body.style-aero.mini-mode .cover-container.video-active .episode-video,
            body.style-aero.mini-mode .cover-overlay {
                inset: calc(1px * var(--s, 1));
            }
            body.style-aero .cover-container.video-active .episode-video {
                width: auto;
                height: auto;
            }
            body.style-aero .time-label {
                box-sizing: border-box;
                color: #30363b;
                padding: 0 3px;
                border: 1px solid #7e878e;
                border-radius: 4px;
                background:
                    linear-gradient(180deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.08) 52%, rgba(0, 0, 0, 0.06)),
                    var(--mp-skeuo-metal-readout);
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.95),
                    inset 0 -1px 1px rgba(48, 54, 59, 0.38),
                    0 1px 2px rgba(0, 0, 0, 0.4);
                text-shadow: 0 1px 0 rgba(255, 255, 255, 0.85);
            }
            body.style-aero .progress-bar-container {
                box-sizing: border-box;
                border: 1px solid rgba(31, 36, 40, 0.6);
                border-radius: 999px;
                background: linear-gradient(180deg, #42484d, #737a80);
                box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.55), 0 1px 0 rgba(255, 255, 255, 0.65);
            }
            body.style-aero .progress-slider::-webkit-slider-runnable-track {
                background:
                    linear-gradient(180deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.08) 52%, rgba(0, 0, 0, 0.24)),
                    linear-gradient(to right, color-mix(in srgb, var(--mp-accent) 72%, white) var(--stop), rgba(255, 255, 255, 0.22) var(--stop));
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.5),
                    inset 0 -1px 0 rgba(0, 0, 0, 0.5),
                    0 0 5px rgba(var(--mp-accent-rgb), 0.42);
            }
            body.style-aero .progress-slider::-webkit-slider-thumb {
                box-sizing: border-box;
                border: 1px solid #596168;
                background: radial-gradient(circle at 35% 25%, #ffffff 0 8%, #e3e6e9 30%, #9da5ac 72%, #6b737a 100%);
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.95),
                    inset 0 -1px 1px rgba(45, 50, 54, 0.25),
                    0 1px 3px rgba(0, 0, 0, 0.65),
                    0 0 0 1px rgba(255, 255, 255, 0.25);
            }
            body.style-aero .progress-slider:focus-visible {
                outline: 2px solid var(--mp-accent);
                outline-offset: 1px;
                border-radius: 999px;
            }
            body.style-aero .progress-slider:focus-visible::-webkit-slider-thumb {
                opacity: 1;
            }
            body.style-aero .queue-menu {
                padding: 6px;
                border: 1px solid #92999f;
                border-radius: 9px;
                background: linear-gradient(145deg, #666d73, #30363b 12%, #202529 52%, #171b1e);
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.42),
                    inset 0 -2px 3px rgba(0, 0, 0, 0.62),
                    0 10px 24px rgba(0, 0, 0, 0.72),
                    0 2px 5px rgba(0, 0, 0, 0.44);
            }
            body.style-aero .queue-menu-item {
                min-height: 32px;
                padding: 7px 10px;
                border: 1px solid rgba(220, 225, 229, 0.16);
                border-radius: 5px;
                background: linear-gradient(155deg, rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.035) 48%, rgba(0, 0, 0, 0.12));
                color: #e7eaed;
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.18),
                    inset 0 -1px 1px rgba(0, 0, 0, 0.28),
                    0 1px 2px rgba(0, 0, 0, 0.35);
                text-shadow: 0 1px 1px rgba(0, 0, 0, 0.55);
                transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease, transform 0.14s ease;
            }
            body.style-aero .queue-menu-item:hover:not(:disabled) {
                border-color: rgba(var(--mp-accent-rgb), 0.72);
                background: linear-gradient(155deg, rgba(var(--mp-fg-rgb), 0.28), rgba(var(--mp-accent-rgb), 0.34) 48%, rgba(var(--mp-accent-rgb), 0.2));
                color: #ffffff;
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.38),
                    0 2px 5px rgba(0, 0, 0, 0.42),
                    0 0 0 1px rgba(var(--mp-accent-rgb), 0.18);
                transform: translateY(-1px);
            }
            body.style-aero .queue-menu-item:active:not(:disabled) {
                background: linear-gradient(165deg, rgba(0, 0, 0, 0.3), rgba(var(--mp-accent-rgb), 0.2));
                box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.42), 0 1px 1px rgba(255, 255, 255, 0.08);
                transform: translateY(1px);
            }
            body.style-aero .queue-menu-item:focus-visible {
                outline: 2px solid var(--mp-accent);
                outline-offset: 1px;
            }
            body.style-aero .queue-menu-item:disabled {
                border-color: rgba(220, 225, 229, 0.08);
                background: rgba(255, 255, 255, 0.025);
                box-shadow: none;
                text-shadow: none;
            }
            body.style-aero .queue-menu-sep {
                height: 2px;
                margin: 5px 4px;
                border-top: 1px solid rgba(255, 255, 255, 0.16);
                background: rgba(0, 0, 0, 0.46);
            }
            @media (prefers-reduced-motion: reduce) {
                body.style-aero .queue-menu-item {
                    transition: none;
                }
                body.style-aero .queue-menu-item:hover:not(:disabled),
                body.style-aero .queue-menu-item:active:not(:disabled) {
                    transform: none;
                }
            }
            body.style-aero .icon-btn {
                display: grid;
                place-items: center;
                border: 1px solid rgba(var(--mp-fg-rgb), 0.16);
                border-radius: 8px;
                background: linear-gradient(145deg, rgba(var(--mp-fg-rgb), 0.17), rgba(var(--mp-accent-rgb), 0.08));
                box-shadow: inset 0 1px 0 rgba(var(--mp-fg-rgb), 0.3), 0 2px 6px rgba(var(--mp-accent-rgb), 0.2);
            }
            body.style-aero .icon-btn svg {
                display: block;
                place-self: center;
                margin: 0;
                transform: none;
            }
            body.style-aero #btn-volume-compact svg,
            body.style-aero #btn-volume-icon-compact svg,
            body.style-aero #btn-volume-icon svg {
                transform: none;
            }
            body.style-aero #btn-lyrics svg {
                transform: translateX(-0.5px);
            }
            body.style-aero .icon-btn:hover {
                background: linear-gradient(145deg, rgba(var(--mp-fg-rgb), 0.3), rgba(var(--mp-accent-rgb), 0.24));
            }
            body.style-aero .volume-popup {
                height: 24px;
                gap: 8px;
            }
            body.style-aero .volume-popup .icon-btn {
                width: 24px;
                height: 24px;
                flex: 0 0 24px;
                padding: 0;
            }
            body.style-aero .volume-popup .volume-slider {
                height: 24px;
            }
            body.style-aero .play-pause-btn {
                border: 1px solid rgba(var(--mp-fg-rgb), 0.32);
                border-radius: 13px;
                background: linear-gradient(145deg, var(--mp-accent-hover), var(--mp-accent) 58%, var(--mp-accent-strong));
                color: var(--mp-on-accent);
                box-shadow: inset 0 1px 0 rgba(var(--mp-fg-rgb), 0.56), 0 3px 10px rgba(var(--mp-accent-rgb), 0.42);
            }
            body.style-aero .play-pause-btn:hover {
                background: linear-gradient(145deg, var(--mp-accent-hover), var(--mp-accent));
            }
            body.style-aero .upcoming-bar {
                background:
                    linear-gradient(180deg, rgba(255, 255, 255, 0.38), rgba(255, 255, 255, 0.04) 34%, rgba(0, 0, 0, 0.05)),
                    linear-gradient(110deg, #e1e4e6 0%, #aeb4b9 34%, #d0d4d7 65%, #a4abb1 100%);
                border-bottom-color: rgba(42, 48, 53, 0.72);
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.9),
                    inset 0 -1px 0 rgba(38, 44, 49, 0.48),
                    0 2px 4px rgba(0, 0, 0, 0.24);
            }
            body.style-aero .upcoming-label {
                color: #155c2b;
            }
            body.style-aero .upcoming-dot {
                background: #187438;
                box-shadow: 0 0 4px rgba(24, 116, 56, 0.7);
            }
            body.style-aero .upcoming-title {
                color: #20262b;
            }
            body.style-aero .upcoming-artist {
                color: #343b41;
            }
            body.style-aero .upcoming-bar.empty .upcoming-title {
                color: #4c545a;
            }
            body.style-aero .upcoming-bar .topbar-action-btn {
                align-items: center;
                justify-content: center;
                border: 1px solid #737b82;
                border-radius: 50%;
                background: linear-gradient(145deg, #e1e4e6, #a4abb1 54%, #858d94);
                color: #30373d;
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.92),
                    inset 0 -1px 1px rgba(50, 57, 63, 0.38),
                    0 1px 2px rgba(35, 40, 45, 0.38);
            }
            body.style-aero .upcoming-bar .topbar-action-btn svg {
                display: block;
                flex-shrink: 0;
                margin: 0;
            }
            body.style-aero .upcoming-bar .topbar-action-btn:hover {
                background: linear-gradient(145deg, #f1f3f4, #bac0c5 54%, #969ea4);
                color: #171c20;
            }
            body.style-aero .upcoming-bar .topbar-action-btn:active {
                background: linear-gradient(165deg, #7d858c, #a1a8ae);
                box-shadow: inset 0 2px 3px rgba(35, 40, 45, 0.42);
                transform: translateY(1px);
            }
            @media (prefers-reduced-motion: reduce) {
                body.style-aero button {
                    transition: none;
                }
                body.style-aero button:hover:not(:disabled),
                body.style-aero button:active:not(:disabled) {
                    transform: none;
                }
            }
            body.style-aero.fluid.slim.mini-mode .compact-actions-cluster .window-actions .dynamic-mini-expand-btn {
                display: grid !important;
            }
        `
    };

    const registry = Spicetify.MiniPlayerThemes || (Spicetify.MiniPlayerThemes = { pending: [] });
    if (typeof registry.register === "function") {
        registry.register(definition);
    } else {
        if (!Array.isArray(registry.pending)) registry.pending = [];
        registry.pending.push(definition);
    }
})();
