// NAME: MiniPlayer - Adaptive Theme
// AUTHOR: pu1zly
// DESCRIPTION: Optional Adaptive player style for Spotify Mini Player

(function () {
    let lastCoverUrl = null;
    let requestId = 0;
    let lastAccent = "";
    let corsWarningShown = false;

    function sampleAlbumArtPixels(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.crossOrigin = "anonymous";
            image.onload = () => {
                let canvas = null;
                try {
                    canvas = document.createElement("canvas");
                    canvas.width = 32;
                    canvas.height = 32;
                    const context = canvas.getContext("2d");
                    if (!context) throw new Error("Canvas pixel sampling is unavailable.");
                    context.drawImage(image, 0, 0, canvas.width, canvas.height);
                    resolve(context.getImageData(0, 0, canvas.width, canvas.height).data);
                } catch (error) {
                    reject(error);
                } finally {
                    if (canvas) {
                        canvas.width = 0;
                        canvas.height = 0;
                    }
                    image.onload = null;
                    image.onerror = null;
                }
            };
            image.onerror = () => {
                image.onload = null;
                image.onerror = null;
                reject(new Error("Album art could not be loaded for color sampling."));
            };
            image.src = url;
        });
    }

    function colorToHex(red, green, blue) {
        return "#" + [red, green, blue]
            .map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
            .join("");
    }

    function luminance(hex) {
        const values = hex.match(/[0-9a-f]{2}/gi).map(value => {
            const channel = parseInt(value, 16) / 255;
            return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    }

    function findContrastingAlbumArtColor(pixels) {
        const buckets = new Map();
        let count = 0;
        let redTotal = 0;
        let greenTotal = 0;
        let blueTotal = 0;

        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] < 128) continue;
            const red = pixels[i];
            const green = pixels[i + 1];
            const blue = pixels[i + 2];
            redTotal += red;
            greenTotal += green;
            blueTotal += blue;
            count++;

            const key = `${red >> 4}:${green >> 4}:${blue >> 4}`;
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = { count: 0, red: 0, green: 0, blue: 0 };
                buckets.set(key, bucket);
            }
            bucket.count++;
            bucket.red += red;
            bucket.green += green;
            bucket.blue += blue;
        }

        if (!count) throw new Error("Album art contained no readable pixels.");

        const averageLuminance = luminance(colorToHex(
            redTotal / count,
            greenTotal / count,
            blueTotal / count
        ));
        const allBuckets = Array.from(buckets.values());
        const minimumCount = Math.max(2, Math.ceil(count * 0.01));
        const candidates = allBuckets.filter(bucket => bucket.count >= minimumCount);
        const palette = candidates.length ? candidates : allBuckets;
        let bestColor = "";
        let bestScore = -1;
        let bestCount = -1;

        palette.forEach(bucket => {
            const color = colorToHex(
                bucket.red / bucket.count,
                bucket.green / bucket.count,
                bucket.blue / bucket.count
            );
            const colorLuminance = luminance(color);
            const contrast = (Math.max(averageLuminance, colorLuminance) + 0.05)
                / (Math.min(averageLuminance, colorLuminance) + 0.05);
            const channels = color.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16));
            const brightestChannel = Math.max(...channels);
            const darkestChannel = Math.min(...channels);
            const saturation = brightestChannel ? (brightestChannel - darkestChannel) / brightestChannel : 0;
            const brightness = brightestChannel / 255;
            const contrastFactor = Math.min(1, (contrast - 1) / 20);
            const score = colorLuminance * 0.4 + saturation * 0.35 + brightness * 0.15 + contrastFactor * 0.1;

            if (score > bestScore + 0.001 || (Math.abs(score - bestScore) <= 0.001 && bucket.count > bestCount)) {
                bestColor = color;
                bestScore = score;
                bestCount = bucket.count;
            }
        });

        return bestColor;
    }

    function updateAccent({ coverUrl, setAccent }) {
        const url = coverUrl || "";
        if (url === lastCoverUrl) {
            setAccent(lastAccent);
            return;
        }
        lastCoverUrl = url;
        const currentRequestId = ++requestId;
        lastAccent = "";
        setAccent("");
        if (!url) return;

        sampleAlbumArtPixels(url).then(pixels => {
            if (currentRequestId !== requestId) return;
            lastAccent = findContrastingAlbumArtColor(pixels);
            setAccent(lastAccent);
        }).catch(error => {
            if (currentRequestId !== requestId) return;
            lastAccent = "";
            if (!corsWarningShown) {
                console.warn("[MiniPlayer Adaptive] Could not read album art colors; using the selected or saved accent.", error);
                corsWarningShown = true;
            }
            setAccent("");
        });
    }

    const definition = {
        id: "artwork",
        label: "Adaptive",
        sharedControls: {
            accent: false,
            albumArtGradient: false,
            customBackground: false,
            customBackgroundMessage: "Adaptive uses the current cover as its background. Your saved custom image is kept for other styles."
        },
        getVariables: settings => ({
            "--artwork-background-blur": `${settings.artworkBackgroundBlur * 0.4}px`
        }),
        settings: {
            title: "Adaptive settings",
            controls: [{
                type: "range",
                key: "artworkBackgroundBlur",
                defaultValue: 35,
                min: 0,
                max: 100,
                step: 5,
                format: "percent",
                label: "Background blur",
                description: "Set the cover-art background blur. 0% is sharp; 100% is strongest."
            }]
        },
        previewCss: `
            .mp-style-preview.artwork { height: 48px; gap: 5px; padding: 4px; }
            .mp-style-preview.artwork .mp-style-preview-art { flex-basis: 38px; width: 38px; height: 38px; border-radius: 5px; }
        `,
        onTrackChange: updateAccent,
        css: `
            body.style-artwork .upcoming-bar {
                background: rgba(var(--mp-bg-rgb), 0.72);
                border-bottom-color: rgba(var(--mp-fg-rgb), 0.16);
                backdrop-filter: blur(14px) saturate(0.82);
                -webkit-backdrop-filter: blur(14px) saturate(0.82);
            }
            body.style-artwork:not(.compact-mode):not(.mini-mode) .track-section {
                gap: 14px;
            }
            body.style-artwork #ambient-bg {
                filter: blur(var(--artwork-background-blur, 14px));
            }
            body.style-artwork.album-art-gradient-off #ambient-bg {
                display: block;
            }
            body.style-artwork.custom-background #ambient-bg {
                opacity: 0.9;
            }
            body.idle.style-artwork #ambient-bg,
            body.idle.style-artwork.custom-background #ambient-bg {
                opacity: max(var(--idle-opacity, 0.35), 0.5);
            }
            body.style-artwork #ambient-bg::after {
                content: "";
                position: absolute;
                inset: 0;
                background:
                    linear-gradient(90deg, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.2) 52%, rgba(0, 0, 0, 0.42)),
                    linear-gradient(0deg, rgba(0, 0, 0, 0.34), transparent 58%, rgba(0, 0, 0, 0.22));
            }
            body.style-artwork #custom-bg {
                display: none;
            }
            body.style-artwork .track-title {
                color: #ffffff;
                text-shadow: 0 1px 4px rgba(0, 0, 0, 0.72);
            }
            body.style-artwork .track-artist,
            body.style-artwork.mini-mode .track-artist-inline {
                color: rgba(255, 255, 255, 0.84);
                text-shadow: 0 1px 3px rgba(0, 0, 0, 0.76);
            }
            body.style-artwork .icon-btn {
                border: 1px solid rgba(255, 255, 255, 0.16);
                background: rgba(0, 0, 0, 0.2);
                color: rgba(255, 255, 255, 0.9);
            }
            body.style-artwork .icon-btn:hover {
                border-color: rgba(255, 255, 255, 0.38);
                background: rgba(0, 0, 0, 0.42);
            }
            body.style-artwork #btn-shuffle.active,
            body.style-artwork #btn-shuffle-compact.active,
            body.style-artwork #btn-repeat.active,
            body.style-artwork #btn-repeat-compact.active {
                border-color: var(--mp-accent);
                background: var(--mp-accent);
                color: var(--mp-on-accent);
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.28),
                    0 2px 6px rgba(var(--mp-accent-rgb), 0.42);
            }
            body.style-artwork:not(.compact-mode):not(.mini-mode) .cover-container {
                width: 84px;
                height: 84px;
                border-radius: 10px;
                box-shadow: 0 8px 22px rgba(0, 0, 0, 0.48);
            }
            body.style-artwork.compact-mode:not(.mini-mode) .cover-container {
                border-radius: 50%;
            }
            body.style-artwork.mini-mode:not(.podcast-track) .cover-container {
                display: block !important;
                width: 28px;
                height: 28px;
                border-radius: 50%;
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
