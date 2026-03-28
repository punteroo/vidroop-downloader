const LOG_PREFIX = '[Vidroop Downloader]';
const STYLE_ID = 'vidroop-downloader-style';
const BUTTON_CLASS = 'vidroop-download-btn';
const CANCEL_BUTTON_CLASS = 'vidroop-download-cancel-btn';
const MAX_CONCURRENT_DOWNLOADS = 6;
const FALLBACK_CDN_HOST = 'vz-7703e207-751.b-cdn.net';
const PLAYLIST_MARKERS = ['#EXTM3U', '#EXT-X-STREAM-INF:', '#EXTINF:'];
const COMMON_VARIANT_RESOLUTIONS = [
    '2160p',
    '1440p',
    '1080p',
    '720p',
    '480p',
    '360p',
];
const OUTPUT_FORMATS = [
    { id: 'ts', extension: 'ts', mimeType: 'video/mp2t' },
    { id: 'mp4', extension: 'mp4', mimeType: 'video/mp4' },
    { id: 'aac', extension: 'aac', mimeType: 'audio/aac' },
];

const I18N = {
    en: {
        buttonDownload: 'Download video',
        buttonCancelDownload: 'Cancel',
        statusLoadingQualities: 'Loading qualities...',
        statusDownloading: 'Downloading {completed}/{total} ({percent}%)',
        statusSaving: 'Saving file...',
        statusConverting: 'Converting file ({percent}%)',
        statusDownloaded: 'Downloaded',
        statusError: 'Error. Check console logs.',
        qualityTitle: 'Select video quality',
        qualityHelp: 'Higher quality means better image and larger file size.',
        qualityCancel: 'Cancel',
        formatTitle: 'Select output format',
        formatHelp: 'TS is the original format. MP4 is easiest for video players. AAC is audio only and smaller.',
        formatCancel: 'Cancel',
        formatTs: 'TS (Original)',
        formatMp4: 'MP4 (Video)',
        formatAac: 'AAC (Audio)',
        cancelTitle: 'Cancel download?',
        cancelMessage: 'This will stop the current download progress.',
        cancelConfirm: 'Yes, cancel',
        cancelKeep: 'Keep downloading',
        qualityUnknown: 'Unknown quality',
        bitrateUnknown: 'Unknown bitrate',
    },
    'es-419': {
        buttonDownload: 'Descargar video',
        buttonCancelDownload: 'Cancelar',
        statusLoadingQualities: 'Cargando calidades...',
        statusDownloading: 'Descargando {completed}/{total} ({percent}%)',
        statusSaving: 'Guardando archivo...',
        statusConverting: 'Convirtiendo archivo ({percent}%)',
        statusDownloaded: 'Descargado',
        statusError: 'Error. Revisar consola.',
        qualityTitle: 'Seleccionar calidad de video',
        qualityHelp: 'Mayor calidad significa mejor imagen y archivo más grande.',
        qualityCancel: 'Cancelar',
        formatTitle: 'Seleccionar formato de salida',
        formatHelp: 'TS es el formato original. MP4 es más fácil para reproducir video. AAC guarda solo audio y ocupa menos.',
        formatCancel: 'Cancelar',
        formatTs: 'TS (Original)',
        formatMp4: 'MP4 (Video)',
        formatAac: 'AAC (Audio)',
        cancelTitle: '¿Cancelar descarga?',
        cancelMessage: 'Esto detendrá el progreso actual de la descarga.',
        cancelConfirm: 'Sí, cancelar',
        cancelKeep: 'Seguir descargando',
        qualityUnknown: 'Calidad desconocida',
        bitrateUnknown: 'Bitrate desconocido',
    },
};

let downloadInProgress = false;
let activeDownloadSession = null;
let downloadSessionCounter = 0;
let activeLanguage = 'en';

/**
 * Logs structured debug telemetry from the content runtime.
 *
 * @param {string} eventName Event identifier.
 * @param {Record<string, unknown>} [payload={}] Event payload.
 */
function logDebug(eventName, payload = {}) {
    console.debug(`${LOG_PREFIX} [${eventName}]`, {
        timestamp: new Date().toISOString(),
        ...payload,
    });
}

/**
 * Logs structured warning telemetry from the content runtime.
 *
 * @param {string} eventName Event identifier.
 * @param {Record<string, unknown>} [payload={}] Event payload.
 */
function logWarn(eventName, payload = {}) {
    console.warn(`${LOG_PREFIX} [${eventName}]`, {
        timestamp: new Date().toISOString(),
        ...payload,
    });
}

/**
 * Resolves the best matching internal language key.
 *
 * @param {string | undefined} value Requested language.
 * @returns {'en' | 'es-419'}
 */
function normalizeLanguage(value) {
    if (!value) return 'en';

    const normalized = value.toLowerCase();
    if (
        normalized === 'es-419' ||
        normalized === 'es_ar' ||
        normalized === 'es-ar' ||
        normalized.startsWith('es')
    ) {
        return 'es-419';
    }

    return 'en';
}

/**
 * Returns localized text for a given key.
 *
 * @param {keyof typeof I18N.en} key Translation key.
 * @param {Record<string, string | number>} [params={}] Optional interpolation params.
 * @returns {string}
 */
function t(key, params = {}) {
    const dictionary = I18N[activeLanguage] ?? I18N.en;
    const template = dictionary[key] ?? I18N.en[key] ?? key;

    return Object.entries(params).reduce(
        (result, [paramName, value]) =>
            result.replaceAll(`{${paramName}}`, String(value)),
        template,
    );
}

/**
 * Loads language settings from storage.
 *
 * @returns {Promise<void>}
 */
async function loadSettings() {
    try {
        const stored = await chrome.storage.sync.get(['language']);
        activeLanguage = normalizeLanguage(stored?.language || navigator.language);

        logDebug('settings.loaded', { language: activeLanguage });
    } catch (error) {
        activeLanguage = normalizeLanguage(navigator.language);
        logWarn('settings.load.failed', {
            reason: error?.message ?? 'unknown',
        });
    }
}

/**
 * Applies translated idle text to existing action buttons.
 */
function refreshIdleButtonLabels() {
    const idleText = t('buttonDownload');
    const cancelText = t('buttonCancelDownload');

    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((element) => {
        const button = /** @type {HTMLButtonElement} */ (element);
        button.dataset.idleText = idleText;

        if (!button.disabled) {
            button.textContent = idleText;
        }
    });

    document.querySelectorAll(`.${CANCEL_BUTTON_CLASS}`).forEach((element) => {
        const button = /** @type {HTMLButtonElement} */ (element);
        button.textContent = cancelText;
    });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.language) return;

    activeLanguage = normalizeLanguage(changes.language.newValue);
    logDebug('settings.language.changed', { language: activeLanguage });

    refreshIdleButtonLabels();
});

/**
 * Injects extension CSS styles once.
 */
function ensureStylesInjected() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
    .${BUTTON_CLASS} {
      position: absolute;
      top: 14px;
      right: 14px;
      z-index: 10000;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(148, 163, 184, 0.35);
      background: rgba(15, 23, 42, 0.88);
      color: #f8fafc;
      padding: 9px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      backdrop-filter: blur(6px);
      box-shadow: 0 4px 14px rgba(2, 6, 23, 0.32);
      transition: transform 0.16s ease, box-shadow 0.2s ease, background-color 0.2s ease, border-color 0.2s ease;
    }

    .${BUTTON_CLASS}:hover {
      transform: translateY(-1px);
      border-color: rgba(148, 163, 184, 0.55);
      background: rgba(30, 41, 59, 0.92);
      box-shadow: 0 8px 18px rgba(2, 6, 23, 0.38);
    }

    .${BUTTON_CLASS}:active {
      transform: translateY(0);
    }

    .${BUTTON_CLASS}:disabled {
      opacity: 0.72;
      cursor: not-allowed;
      transform: none;
      box-shadow: 0 3px 10px rgba(2, 6, 23, 0.26);
    }

    .${CANCEL_BUTTON_CLASS} {
      position: absolute;
      top: 56px;
      right: 14px;
      z-index: 10000;
      border: 1px solid rgba(148, 163, 184, 0.3);
      background: rgba(30, 41, 59, 0.9);
      color: #e2e8f0;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      cursor: pointer;
      transition: background-color 0.16s ease, border-color 0.16s ease;
    }

    .${CANCEL_BUTTON_CLASS}:hover {
      background: rgba(51, 65, 85, 0.95);
      border-color: rgba(148, 163, 184, 0.5);
    }

    .vidroop-quality-modal {
      position: fixed;
      inset: 0;
      z-index: 20000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(2, 6, 23, 0.72);
      backdrop-filter: blur(2px);
    }

    .vidroop-quality-card {
      width: min(430px, 92vw);
      background: #0f172a;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 14px;
      padding: 18px;
      box-shadow: 0 16px 36px rgba(2, 6, 23, 0.46);
      color: #e2e8f0;
      animation: vidroopCardIn 0.18s ease-out;
    }

    .vidroop-quality-title {
      margin: 0 0 12px;
      font-size: 16px;
      font-weight: 700;
      color: #f8fafc;
    }

    .vidroop-quality-help {
      margin: -2px 0 10px;
      font-size: 12px;
      line-height: 1.45;
      color: #94a3b8;
    }

    .vidroop-quality-option,
    .vidroop-quality-cancel {
      width: 100%;
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      color: #f8fafc;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      padding: 11px 12px;
      transition: background-color 0.16s ease, border-color 0.16s ease;
    }

    .vidroop-quality-option {
      margin: 6px 0;
      background: #1e293b;
      text-align: left;
    }

    .vidroop-quality-option:hover {
      background: #334155;
      border-color: rgba(148, 163, 184, 0.45);
    }

    .vidroop-quality-cancel {
      margin-top: 10px;
      background: #334155;
    }

    .vidroop-quality-cancel:hover {
      background: #475569;
      border-color: rgba(148, 163, 184, 0.45);
    }

    @keyframes vidroopCardIn {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `;

    document.head.appendChild(style);
}

/**
 * Adds a download button inside a valid iframe wrapper.
 *
 * @param {HTMLElement} wrapper The wrapper that contains the Vidroop iframe.
 * @param {string} videoGuid The GUID extracted from the iframe source.
 */
function addDownloadButton(wrapper, videoGuid) {
    if (wrapper.querySelector(`.${BUTTON_CLASS}`)) return;

    wrapper.style.position = 'relative';

    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.type = 'button';
    button.dataset.idleText = t('buttonDownload');
    button.textContent = button.dataset.idleText;

    button.addEventListener('click', () => startDownload(videoGuid, wrapper));
    wrapper.appendChild(button);
}

/**
 * Sets a translated text into a button.
 *
 * @param {HTMLButtonElement} button Target button.
 * @param {keyof typeof I18N.en} key Translation key.
 * @param {Record<string, string | number>} [params={}] Optional interpolation params.
 */
function setButtonText(button, key, params = {}) {
    button.textContent = t(key, params);
}

/**
 * Handles the complete download workflow for a single video.
 *
 * @param {string} guid The video GUID.
 * @param {HTMLElement} wrapper The iframe wrapper where the action button lives.
 * @returns {Promise<void>}
 */
async function startDownload(guid, wrapper) {
    validateActiveDownloadSession();

    if (downloadInProgress) {
        logWarn('download.blocked.concurrent', { guid });

        return;
    }

    const button = wrapper.querySelector(`.${BUTTON_CLASS}`);
    if (!button) return;

    const startedAt = performance.now();
    const abortController = new AbortController();
    const session = {
        id: ++downloadSessionCounter,
        guid,
        wrapper,
        button,
        abortController,
        cancelRequested: false,
        workerTerminate: null,
    };

    activeDownloadSession = session;
    downloadInProgress = true;
    button.disabled = true;
    const cancelButton = ensureCancelButton(wrapper, async () => {
        const shouldCancel = await showConfirmDialog({
            title: t('cancelTitle'),
            message: t('cancelMessage'),
            confirmText: t('cancelConfirm'),
            dismissText: t('cancelKeep'),
        });

        if (!shouldCancel) return;
        cancelActiveDownload('user-confirmed');
    });
    cancelButton.disabled = false;

    logDebug('download.started', { guid });

    try {
        ensureSessionActive(session, 'start-initialized');
        setButtonText(button, 'statusLoadingQualities');

        const playlistCandidates = await getPlaylistCandidates(guid);
        ensureSessionActive(session, 'playlist-candidates-loaded');

        const resolvedEntry = await resolvePlayablePlaylist(
            guid,
            playlistCandidates,
            'entry-playlist',
            session.abortController.signal,
        );
        ensureSessionActive(session, 'entry-playlist-resolved');

        let selectedResolution =
            extractResolutionFromUrl(resolvedEntry.playlistUrl) ?? '720p';
        let finalPlaylistUrl = resolvedEntry.playlistUrl;
        let finalPlaylistText = resolvedEntry.playlistText;

        const isMaster = isMasterPlaylistText(resolvedEntry.playlistText);
        let availableQualities = [];

        if (isMaster) {
            availableQualities = parseMasterPlaylist(
                resolvedEntry.playlistUrl,
                resolvedEntry.playlistText,
            );
        } else {
            availableQualities = await discoverVariantQualities(
                guid,
                resolvedEntry.playlistUrl,
                resolvedEntry.playlistText,
                playlistCandidates,
                session.abortController.signal,
            );
        }
        ensureSessionActive(session, 'qualities-discovered');

        if (!availableQualities.length) {
            throw new Error('No playable qualities found');
        }

        const selectedQuality = await showQualitySelector(
            availableQualities,
            session.abortController.signal,
        );
        if (!selectedQuality) {
            logDebug('download.cancelled.by-user', { guid });
            throw createCancelledError('quality-selection-cancelled');
        }

        selectedResolution = selectedQuality.resolutionLabel;

        const selectedOutputFormat = await showOutputFormatSelector(
            session.abortController.signal,
        );
        if (!selectedOutputFormat) {
            logDebug('download.cancelled.output-format', { guid });
            throw createCancelledError('format-selection-cancelled');
        }

        const selectedVariantCandidates = buildSelectedVariantCandidateUrls(
            guid,
            selectedQuality.resolutionPath,
            playlistCandidates,
            selectedQuality.url,
        );

        const selectedVariant = await resolvePlayablePlaylist(
            guid,
            selectedVariantCandidates,
            'selected-variant',
            session.abortController.signal,
        );
        ensureSessionActive(session, 'selected-variant-resolved');

        finalPlaylistUrl = selectedVariant.playlistUrl;
        finalPlaylistText = selectedVariant.playlistText;

        const { segments, keyUrl, ivHex } = parseVariantPlaylist(
            finalPlaylistUrl,
            finalPlaylistText,
        );

        if (!segments?.length) {
            throw new Error('No segments found in selected variant');
        }

        let cryptoKey = null;
        if (keyUrl) {
            logDebug('encryption.key.fetch.started', { guid, keyUrl });
            const keyBuffer = await fetchKey(keyUrl, session.abortController.signal);
            cryptoKey = await importAesKey(keyBuffer);
            ensureSessionActive(session, 'encryption-key-ready');
            logDebug('encryption.key.fetch.completed', { guid });
        }

        setButtonText(button, 'statusDownloading', {
            completed: 0,
            total: segments.length,
            percent: 0,
        });

        const chunks = await downloadInParallel(
            segments,
            cryptoKey,
            ivHex,
            (completed) => {
                if (!isSessionCurrent(session)) return;

                const percent = Math.round((completed / segments.length) * 100);
                setButtonText(button, 'statusDownloading', {
                    completed,
                    total: segments.length,
                    percent,
                });
            },
            guid,
            session.abortController.signal,
        );
        ensureSessionActive(session, 'segments-downloaded');

        setButtonText(button, 'statusSaving');

        const output = await buildOutputFile(
            chunks,
            guid,
            selectedResolution,
            selectedOutputFormat,
            (percent) => {
                if (selectedOutputFormat.id !== 'mp4') return;
                if (!isSessionCurrent(session)) return;

                setButtonText(button, 'statusConverting', { percent });
            },
            {
                signal: session.abortController.signal,
                onWorkerTerminate: (terminate) => {
                    session.workerTerminate = terminate;
                },
            },
        );
        ensureSessionActive(session, 'output-generated');
        saveOutputFile(output);

        setButtonText(button, 'statusDownloaded');
        setTimeout(() => resetButtonState(button), 3000);

        logDebug('download.completed', {
            guid,
            resolution: selectedResolution,
            format: selectedOutputFormat.id,
            segmentCount: segments.length,
            durationMs: Math.round(performance.now() - startedAt),
        });
    } catch (error) {
        if (isCancelledError(error)) {
            logDebug('download.cancelled', {
                guid,
                reason: error?.reason ?? error?.message ?? 'cancelled',
            });

            resetButtonState(button);

            return;
        }

        logWarn('download.failed', {
            guid,
            reason: error?.message ?? 'unknown',
            status: error?.status,
        });

        setButtonText(button, 'statusError');
        setTimeout(() => resetButtonState(button), 4200);
    } finally {
        if (activeDownloadSession?.id === session.id) {
            clearActiveDownloadSession();
        } else if (!activeDownloadSession) {
            downloadInProgress = false;
        }

        removeCancelButton(wrapper);
    }
}

/**
 * Parses an HLS master playlist and returns available quality options.
 *
 * @param {string} baseUrl Base URL used to resolve relative variant URLs.
 * @param {string} text Raw playlist text.
 * @returns {Array<{url: string, resolutionRaw: string, resolutionPath: string, resolutionLabel: string, bandwidth: number}>}
 */
function parseMasterPlaylist(baseUrl, text) {
    const lines = text.split('\n');
    const qualities = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

        const resolutionMatch = line.match(/RESOLUTION=([\d]+x[\d]+)/);
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const nextLine = lines[index + 1]?.trim();

        if (!nextLine || nextLine.startsWith('#')) continue;

        const url = resolveUrl(baseUrl, nextLine);
        const resolutionRaw = resolutionMatch ? resolutionMatch[1] : t('qualityUnknown');
        const resolutionPath =
            extractResolutionFromUrl(url) ??
            inferResolutionPathFromRawResolution(resolutionRaw) ??
            '720p';

        qualities.push({
            url,
            resolutionRaw,
            resolutionPath,
            resolutionLabel: resolutionPath,
            bandwidth: bandwidthMatch ? Number.parseInt(bandwidthMatch[1], 10) : 0,
        });
    }

    qualities.sort((a, b) => b.bandwidth - a.bandwidth);

    return qualities;
}

/**
 * Infers a resolution path (e.g. 1080p) from a raw RESOLUTION token (e.g. 1920x1080).
 *
 * @param {string} resolutionRaw Raw resolution string.
 * @returns {string | null}
 */
function inferResolutionPathFromRawResolution(resolutionRaw) {
    const match = resolutionRaw.match(/\d+x(\d+)/i);
    if (!match) return null;

    return `${match[1]}p`;
}

/**
 * Parses a variant playlist to extract segment URLs and encryption details.
 *
 * @param {string} baseUrl Base URL used to resolve relative segment URLs.
 * @param {string} text Raw playlist text.
 * @returns {{segments: Array<{url: string}>, keyUrl: string | null, ivHex: string | null}}
 */
function parseVariantPlaylist(baseUrl, text) {
    const lines = text.split('\n');
    const segments = [];
    let keyUrl = null;
    let ivHex = null;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();

        if (line.startsWith('#EXT-X-KEY:')) {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch) {
                keyUrl = resolveUrl(baseUrl, uriMatch[1]);
            }

            const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);
            if (ivMatch) {
                ivHex = ivMatch[1].toLowerCase();
            }
        }

        if (!line.startsWith('#EXTINF:')) continue;

        const nextLine = lines[index + 1]?.trim();
        if (!nextLine || nextLine.startsWith('#')) continue;

        segments.push({ url: resolveUrl(baseUrl, nextLine) });
    }

    return { segments, keyUrl, ivHex };
}

/**
 * Probes and returns available qualities when entry playback starts from a direct variant.
 *
 * @param {string} guid Video GUID.
 * @param {string} currentPlaylistUrl Currently resolved variant URL.
 * @param {string} currentPlaylistText Current variant text.
 * @param {string[]} playlistCandidates Resolved playlist candidates.
 * @returns {Promise<Array<{url: string, resolutionPath: string, resolutionLabel: string, bandwidth: number}>>}
 */
async function discoverVariantQualities(
    guid,
    currentPlaylistUrl,
    currentPlaylistText,
    playlistCandidates,
    signal,
) {
    throwIfAborted(signal, 'quality-discovery-aborted');

    const discovered = new Map();
    const currentResolution = extractResolutionFromUrl(currentPlaylistUrl) ?? '720p';

    if (isVariantPlaylistText(currentPlaylistText)) {
        discovered.set(currentResolution, {
            url: currentPlaylistUrl,
            resolutionPath: currentResolution,
            resolutionLabel: currentResolution,
            bandwidth: estimateBandwidthByResolution(currentResolution),
        });
    }

    const hosts = extractUniqueHosts([currentPlaylistUrl, ...playlistCandidates]);
    const resolutionsToProbe = Array.from(
        new Set([currentResolution, ...COMMON_VARIANT_RESOLUTIONS]),
    );

    for (const host of hosts) {
        for (const resolution of resolutionsToProbe) {
            if (discovered.has(resolution)) continue;

            const candidateUrl = `https://${host}/${guid}/${resolution}/video.m3u8`;

            try {
                const candidateText = await fetchPlaylistText(
                    candidateUrl,
                    'variant-probe',
                    signal,
                );
                if (!isVariantPlaylistText(candidateText)) continue;

                discovered.set(resolution, {
                    url: candidateUrl,
                    resolutionPath: resolution,
                    resolutionLabel: resolution,
                    bandwidth: estimateBandwidthByResolution(resolution),
                });

                logDebug('quality.probe.success', {
                    guid,
                    host,
                    resolution,
                });
            } catch (error) {
                if (isCancelledError(error)) {
                    throw error;
                }

                await reportPlaylistFailure(guid, candidateUrl, error?.status);
            }

            throwIfAborted(signal, 'quality-discovery-aborted');
        }
    }

    const qualityList = Array.from(discovered.values());
    qualityList.sort(
        (a, b) =>
            resolutionSortWeight(b.resolutionPath) -
            resolutionSortWeight(a.resolutionPath),
    );

    logDebug('quality.discovered', {
        guid,
        count: qualityList.length,
        resolutions: qualityList.map((quality) => quality.resolutionPath),
    });

    return qualityList;
}

/**
 * Resolves numeric ranking for known resolution labels.
 *
 * @param {string} resolution Resolution path string.
 * @returns {number}
 */
function resolutionSortWeight(resolution) {
    const value = Number.parseInt(resolution.replace(/[^0-9]/g, ''), 10);

    return Number.isNaN(value) ? 0 : value;
}

/**
 * Returns a rough bandwidth estimate for a resolution.
 *
 * @param {string} resolution Resolution path.
 * @returns {number}
 */
function estimateBandwidthByResolution(resolution) {
    const mapping = {
        '2160p': 16_000_000,
        '1440p': 9_000_000,
        '1080p': 6_000_000,
        '720p': 3_500_000,
        '480p': 1_800_000,
        '360p': 900_000,
    };

    return mapping[resolution] ?? 0;
}

/**
 * Displays a quality selector modal and resolves with selected quality metadata.
 *
 * @param {Array<{url: string, resolutionPath: string, resolutionLabel: string, bandwidth: number}>} qualities Available quality options.
 * @returns {Promise<{url: string, resolutionPath: string, resolutionLabel: string, bandwidth: number} | null>}
 */
async function showQualitySelector(qualities, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);

            return;
        }

        const modal = document.createElement('div');
        modal.className = 'vidroop-quality-modal';

        const content = document.createElement('div');
        content.className = 'vidroop-quality-card';

        const title = document.createElement('h3');
        title.className = 'vidroop-quality-title';
        title.textContent = t('qualityTitle');
        content.appendChild(title);

        const helper = document.createElement('p');
        helper.className = 'vidroop-quality-help';
        helper.textContent = t('qualityHelp');
        content.appendChild(helper);

        qualities.forEach((quality) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vidroop-quality-option';

            const bitrateLabel = quality.bandwidth
                ? `${Math.round(quality.bandwidth / 1_000_000)} Mbps`
                : t('bitrateUnknown');

            button.textContent = `${quality.resolutionLabel} · ${bitrateLabel}`;
            button.onclick = () => {
                dispose();
                resolve(quality);
            };

            content.appendChild(button);
        });

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'vidroop-quality-cancel';
        cancelButton.textContent = t('qualityCancel');
        cancelButton.onclick = () => {
            dispose();
            resolve(null);
        };

        content.appendChild(cancelButton);
        modal.appendChild(content);
        document.body.appendChild(modal);

        const onAbort = () => {
            dispose();
            resolve(null);
        };

        const dispose = () => {
            if (modal.isConnected) {
                document.body.removeChild(modal);
            }

            signal?.removeEventListener('abort', onAbort);
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Displays an output format selector modal.
 *
 * @returns {Promise<{id: string, extension: string, mimeType: string} | null>}
 */
async function showOutputFormatSelector(signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);

            return;
        }

        const modal = document.createElement('div');
        modal.className = 'vidroop-quality-modal';

        const content = document.createElement('div');
        content.className = 'vidroop-quality-card';

        const title = document.createElement('h3');
        title.className = 'vidroop-quality-title';
        title.textContent = t('formatTitle');
        content.appendChild(title);

        const helper = document.createElement('p');
        helper.className = 'vidroop-quality-help';
        helper.textContent = t('formatHelp');
        content.appendChild(helper);

        OUTPUT_FORMATS.forEach((formatOption) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vidroop-quality-option';
            const labelById = {
                ts: t('formatTs'),
                mp4: t('formatMp4'),
                aac: t('formatAac'),
            };
            button.textContent = labelById[formatOption.id] ?? formatOption.id;

            button.onclick = () => {
                dispose();
                resolve(formatOption);
            };

            content.appendChild(button);
        });

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'vidroop-quality-cancel';
        cancelButton.textContent = t('formatCancel');
        cancelButton.onclick = () => {
            dispose();
            resolve(null);
        };

        content.appendChild(cancelButton);
        modal.appendChild(content);
        document.body.appendChild(modal);

        const onAbort = () => {
            dispose();
            resolve(null);
        };

        const dispose = () => {
            if (modal.isConnected) {
                document.body.removeChild(modal);
            }

            signal?.removeEventListener('abort', onAbort);
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Displays a confirmation modal dialog.
 *
 * @param {{title: string, message: string, confirmText: string, dismissText: string}} config Dialog config.
 * @returns {Promise<boolean>}
 */
async function showConfirmDialog(config) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'vidroop-quality-modal';

        const content = document.createElement('div');
        content.className = 'vidroop-quality-card';

        const title = document.createElement('h3');
        title.className = 'vidroop-quality-title';
        title.textContent = config.title;
        content.appendChild(title);

        const helper = document.createElement('p');
        helper.className = 'vidroop-quality-help';
        helper.textContent = config.message;
        content.appendChild(helper);

        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = 'vidroop-quality-option';
        confirmButton.textContent = config.confirmText;
        confirmButton.onclick = () => {
            dispose();
            resolve(true);
        };
        content.appendChild(confirmButton);

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.className = 'vidroop-quality-cancel';
        dismissButton.textContent = config.dismissText;
        dismissButton.onclick = () => {
            dispose();
            resolve(false);
        };
        content.appendChild(dismissButton);

        modal.appendChild(content);
        document.body.appendChild(modal);

        const dispose = () => {
            if (modal.isConnected) {
                document.body.removeChild(modal);
            }
        };
    });
}

/**
 * Builds output payload according to selected format.
 *
 * @param {Array<ArrayBuffer>} chunks Decrypted TS chunks.
 * @param {string} guid Video GUID.
 * @param {string} selectedResolution Selected quality label.
 * @param {{id: string, extension: string, mimeType: string}} selectedOutputFormat Output format.
 * @param {(percent: number) => void} onConversionProgress Conversion progress callback.
 * @returns {Promise<{blob: Blob, fileName: string}>}
 */
async function buildOutputFile(
    chunks,
    guid,
    selectedResolution,
    selectedOutputFormat,
    onConversionProgress,
    options = {},
) {
    const fileName =
        `vidroop-video-${guid.slice(0, 8)}-${selectedResolution}.${selectedOutputFormat.extension}`;

    if (selectedOutputFormat.id === 'ts') {
        return {
            blob: new Blob(chunks, { type: selectedOutputFormat.mimeType }),
            fileName,
        };
    }

    const convertedParts = await convertTsChunksByFormat(
        chunks,
        guid,
        selectedOutputFormat.id,
        onConversionProgress,
        options,
    );

    return {
        blob: new Blob(convertedParts, { type: selectedOutputFormat.mimeType }),
        fileName,
    };
}

/**
 * Saves a generated file payload through browser download flow.
 *
 * @param {{blob: Blob, fileName: string}} output Output payload.
 */
function saveOutputFile(output) {
    const objectUrl = URL.createObjectURL(output.blob);

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = output.fileName;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
}

/**
 * Converts TS chunks to MP4 parts using worker-based transmuxing.
 *
 * @param {Array<ArrayBuffer>} chunks TS chunks in playback order.
 * @param {string} guid Video GUID.
 * @param {(percent: number) => void} onConversionProgress Conversion progress callback.
 * @returns {Promise<Array<ArrayBuffer>>}
 */
async function convertTsChunksByFormat(
    chunks,
    guid,
    format,
    onConversionProgress,
    options = {},
) {
    const { signal, onWorkerTerminate } = options;
    throwIfAborted(signal, 'conversion-aborted-before-worker-start');

    const workerHandle = await createConversionWorker();

    return new Promise((resolve, reject) => {
        const worker = workerHandle.worker;
        let settled = false;

        const terminateWorker = () => {
            workerHandle.dispose();
            worker.terminate();
        };

        const fail = (error) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            terminateWorker();
            reject(error);
        };

        const succeed = (parts) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            terminateWorker();
            resolve(parts);
        };

        const onAbort = () => {
            fail(createCancelledError('conversion-aborted'));
        };

        onWorkerTerminate?.(terminateWorker);
        signal?.addEventListener('abort', onAbort, { once: true });

        if (signal?.aborted) {
            onAbort();

            return;
        }

        worker.onmessage = (event) => {
            const { type, payload } = event.data || {};

            if (type === 'progress') {
                onConversionProgress(payload.percent);

                return;
            }

            if (type === 'debug') {
                logDebug('conversion.worker', {
                    guid,
                    ...payload,
                });

                return;
            }

            if (type === 'done') {
                succeed(payload.parts);

                return;
            }

            if (type === 'error') {
                fail(new Error(payload.message));
            }
        };

        worker.onerror = (error) => {
            fail(new Error(error.message || 'MP4 conversion worker failed'));
        };

        worker.postMessage(
            {
                action: 'convert',
                guid,
                format,
                chunks,
            },
            chunks,
        );
    });
}

/**
 * Creates a conversion worker with runtime URL first and blob fallback.
 *
 * @returns {Promise<{worker: Worker, dispose: () => void}>}
 */
async function createConversionWorker() {
    const runtimeUrl = chrome.runtime.getURL('conversion.worker.js');
    const muxRuntimeUrl = chrome.runtime.getURL('node_modules/mux.js/dist/mux.min.js');
    const mp4boxRuntimeUrl = chrome.runtime.getURL('node_modules/mp4box/dist/mp4box.all.js');

    logDebug('conversion.worker.bootstrap', {
        mode: 'blob-only-content-script',
    });

    let workerScriptText = await fetch(runtimeUrl).then((response) => {
        if (!response.ok) {
            throw new Error(`Worker source fetch failed: ${response.status}`);
        }

        return response.text();
    });

    if (workerScriptText.includes("import * as muxjs from 'mux.js';")) {
        workerScriptText = workerScriptText.replace(
            "import * as muxjs from 'mux.js';",
            `importScripts('${muxRuntimeUrl}');\nconst muxjs = self.muxjs || self.mux || {};`,
        );
    }

    if (workerScriptText.includes("import * as MP4Box from 'mp4box';")) {
        workerScriptText = workerScriptText.replace(
            "import * as MP4Box from 'mp4box';",
            `importScripts('${mp4boxRuntimeUrl}');\nconst MP4Box = self.MP4Box || self.mp4box || {};`,
        );
    }

    if (
        workerScriptText.includes("import * as muxjs from 'mux.js';") ||
        workerScriptText.includes("import * as MP4Box from 'mp4box';")
    ) {
        logWarn('conversion.worker.source.rewrite.incomplete', {
            reason: 'unresolved-esm-imports',
        });
    } else {

        logDebug('conversion.worker.source.rewritten', {
            mode: 'esm-to-classic',
        });
    }

    const blob = new Blob([workerScriptText], {
        type: 'application/javascript',
    });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);

    logDebug('conversion.worker.created', {
        mode: 'blob-fallback',
    });

    return {
        worker,
        dispose: () => URL.revokeObjectURL(blobUrl),
    };
}

/**
 * Resolves a potentially relative URL from an HLS playlist.
 *
 * @param {string} base Base URL.
 * @param {string} relative Relative or absolute target URL.
 * @returns {string}
 */
function resolveUrl(base, relative) {
    if (relative.startsWith('http')) return relative;

    try {
        return new URL(relative, base).href;
    } catch {
        return relative;
    }
}

/**
 * Extracts host from an URL string.
 *
 * @param {string} url URL string.
 * @returns {string | null}
 */
function extractHostFromUrl(url) {
    try {
        return new URL(url).host;
    } catch {
        return null;
    }
}

/**
 * Returns unique host names extracted from a list of URLs.
 *
 * @param {string[]} urls Candidate URLs.
 * @returns {string[]}
 */
function extractUniqueHosts(urls) {
    const hosts = urls
        .map((url) => extractHostFromUrl(url))
        .filter(Boolean);

    return Array.from(new Set(hosts));
}

/**
 * Extracts the common resolution format from a URL path (e.g. 720p).
 *
 * @param {string} url URL to inspect.
 * @returns {string | null}
 */
function extractResolutionFromUrl(url) {
    const resolutionMatch = url.match(/\/(\d+p)\//i);

    return resolutionMatch ? resolutionMatch[1].toLowerCase() : null;
}

/**
 * Indicates whether a playlist text is a master playlist.
 *
 * @param {string} text Playlist text.
 * @returns {boolean}
 */
function isMasterPlaylistText(text) {
    return text.includes('#EXT-X-STREAM-INF:') && !text.includes('#EXTINF:');
}

/**
 * Indicates whether a playlist text is a variant playlist.
 *
 * @param {string} text Playlist text.
 * @returns {boolean}
 */
function isVariantPlaylistText(text) {
    return text.includes('#EXTINF:');
}

/**
 * Builds a list of best-effort playlist candidates from background cache and local fallback.
 *
 * @param {string} guid Video GUID.
 * @returns {Promise<string[]>}
 */
async function getPlaylistCandidates(guid) {
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'resolvePlaylists',
            guid,
        });

        const fromBackground = response?.playlistUrls ?? [];
        const localFallback = `https://${FALLBACK_CDN_HOST}/${guid}/playlist.m3u8`;
        const candidates = Array.from(new Set([...fromBackground, localFallback]));

        logDebug('playlist.candidates.loaded', {
            guid,
            count: candidates.length,
            candidates,
        });

        return candidates;
    } catch {
        logWarn('playlist.candidates.fallback-only', { guid });

        return [`https://${FALLBACK_CDN_HOST}/${guid}/playlist.m3u8`];
    }
}

/**
 * Builds selected variant candidates using the chosen resolution and known hosts.
 *
 * @param {string} guid Video GUID.
 * @param {string} selectedResolutionPath Selected resolution path (e.g. 1080p).
 * @param {string[]} playlistCandidates Candidate playlist URLs.
 * @param {string} primarySelectedUrl Selected URL from quality list.
 * @returns {string[]}
 */
function buildSelectedVariantCandidateUrls(
    guid,
    selectedResolutionPath,
    playlistCandidates,
    primarySelectedUrl,
) {
    const hosts = extractUniqueHosts([primarySelectedUrl, ...playlistCandidates]);
    const candidates = [primarySelectedUrl];

    hosts.forEach((host) => {
        candidates.push(
            `https://${host}/${guid}/${selectedResolutionPath}/video.m3u8`,
        );
    });

    candidates.push(
        `https://${FALLBACK_CDN_HOST}/${guid}/${selectedResolutionPath}/video.m3u8`,
    );

    return Array.from(new Set(candidates));
}

/**
 * Reports stale playlist candidates to the background service worker.
 *
 * @param {string} guid Video GUID.
 * @param {string} url Failed URL.
 * @param {number | undefined} status HTTP status code.
 */
async function reportPlaylistFailure(guid, url, status) {
    if (!url || (status !== 403 && status !== 404)) return;

    logWarn('playlist.candidate.report-failure', {
        guid,
        url,
        status,
    });

    try {
        await chrome.runtime.sendMessage({
            action: 'reportPlaylistFailure',
            guid,
            url,
            status,
        });
    } catch {
        // Intentionally ignored.
    }
}

/**
 * Resolves the first valid playlist from a candidate list.
 *
 * @param {string} guid Video GUID.
 * @param {string[]} candidates Candidate URLs.
 * @param {string} purpose Telemetry label indicating caller purpose.
 * @returns {Promise<{playlistUrl: string, playlistText: string}>}
 */
async function resolvePlayablePlaylist(guid, candidates, purpose, signal) {
    let lastError = null;
    const total = candidates.length;

    throwIfAborted(signal, 'playlist-resolution-aborted');

    logDebug('playlist.resolve.started', {
        guid,
        purpose,
        candidateCount: total,
    });

    for (let index = 0; index < candidates.length; index++) {
        const candidateUrl = candidates[index];
        const attemptStartedAt = performance.now();

        logDebug('playlist.resolve.attempt', {
            guid,
            purpose,
            attempt: index + 1,
            total,
            url: candidateUrl,
            host: extractHostFromUrl(candidateUrl),
        });

        try {
            const playlistText = await fetchPlaylistText(candidateUrl, purpose, signal);
            if (!isPlaylistTextValid(playlistText)) {
                logWarn('playlist.resolve.invalid-body', {
                    guid,
                    purpose,
                    url: candidateUrl,
                    durationMs: Math.round(performance.now() - attemptStartedAt),
                });

                continue;
            }

            logDebug('playlist.resolve.success', {
                guid,
                purpose,
                url: candidateUrl,
                host: extractHostFromUrl(candidateUrl),
                durationMs: Math.round(performance.now() - attemptStartedAt),
                variant: isVariantPlaylistText(playlistText),
                master: isMasterPlaylistText(playlistText),
            });

            return {
                playlistUrl: candidateUrl,
                playlistText,
            };
        } catch (error) {
            if (isCancelledError(error)) {
                throw error;
            }

            lastError = error;

            logWarn('playlist.resolve.failed', {
                guid,
                purpose,
                url: candidateUrl,
                host: extractHostFromUrl(candidateUrl),
                status: error?.status,
                reason: error?.message,
                durationMs: Math.round(performance.now() - attemptStartedAt),
            });

            await reportPlaylistFailure(guid, candidateUrl, error?.status);
        }

        throwIfAborted(signal, 'playlist-resolution-aborted');
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error('No valid playlist candidates available');
}

/**
 * Validates whether the text looks like an HLS playlist body.
 *
 * @param {string} text Raw response text.
 * @returns {boolean}
 */
function isPlaylistTextValid(text) {
    return PLAYLIST_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Builds an HTTP-like error with status metadata.
 *
 * @param {string} message Error message.
 * @param {number} status HTTP status code.
 * @returns {Error & {status: number}}
 */
function createHttpError(message, status) {
    const error = new Error(message);
    error.status = status;

    return error;
}

/**
 * Fetches and returns playlist text.
 *
 * @param {string} playlistUrl Playlist URL.
 * @param {string} errorPrefix Error message prefix.
 * @returns {Promise<string>}
 */
async function fetchPlaylistText(playlistUrl, errorPrefix, signal) {
    throwIfAborted(signal, 'playlist-fetch-aborted');

    const response = await fetch(playlistUrl, { cache: 'default', signal });
    if (!response.ok) {
        throw createHttpError(`${errorPrefix}: ${response.status}`, response.status);
    }

    return response.text();
}

/**
 * Fetches an AES key from a remote URL.
 *
 * @param {string} keyUrl The key endpoint URL.
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchKey(keyUrl, signal) {
    throwIfAborted(signal, 'key-fetch-aborted');

    const response = await fetch(keyUrl, { cache: 'default', signal });
    if (!response.ok) {
        throw createHttpError(`Key failed: ${response.status}`, response.status);
    }

    return response.arrayBuffer();
}

/**
 * Imports AES-CBC key material for Web Crypto decryption.
 *
 * @param {ArrayBuffer} keyBuffer Raw key bytes.
 * @returns {Promise<CryptoKey>}
 */
async function importAesKey(keyBuffer) {
    return crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'AES-CBC' },
        false,
        ['decrypt'],
    );
}

/**
 * Fetches a single encrypted HLS segment.
 *
 * @param {string} url Segment URL.
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchSegment(url, signal) {
    throwIfAborted(signal, 'segment-fetch-aborted');

    const response = await fetch(url, { cache: 'default', signal });
    if (!response.ok) {
        throw createHttpError(`Segment failed: ${response.status}`, response.status);
    }

    return response.arrayBuffer();
}

/**
 * Decrypts an encrypted segment with AES-CBC.
 *
 * @param {ArrayBuffer} encrypted Encrypted segment bytes.
 * @param {CryptoKey} cryptoKey Imported decryption key.
 * @param {string | null} ivHex IV in hexadecimal format.
 * @returns {Promise<ArrayBuffer>}
 */
async function decryptSegment(encrypted, cryptoKey, ivHex) {
    const iv = new Uint8Array(16);

    if (ivHex && ivHex.length === 32) {
        for (let index = 0; index < 16; index++) {
            iv[index] = Number.parseInt(ivHex.substr(index * 2, 2), 16);
        }
    }

    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, encrypted);
}

/**
 * Downloads and optionally decrypts all variant segments in batches.
 *
 * @param {Array<{url: string}>} segments Segment descriptors.
 * @param {CryptoKey | null} cryptoKey Imported key for decryption.
 * @param {string | null} ivHex Optional IV for decryption.
 * @param {(completed: number) => void} onProgress Callback for progress updates.
 * @param {string} guid Video GUID for telemetry.
 * @returns {Promise<Array<ArrayBuffer>>}
 */
async function downloadInParallel(
    segments,
    cryptoKey,
    ivHex,
    onProgress,
    guid,
    signal,
) {
    throwIfAborted(signal, 'segment-download-aborted');

    const chunks = [];
    let completed = 0;
    const totalBatches = Math.ceil(segments.length / MAX_CONCURRENT_DOWNLOADS);
    let batchNumber = 0;

    for (
        let offset = 0;
        offset < segments.length;
        offset += MAX_CONCURRENT_DOWNLOADS
    ) {
        batchNumber += 1;
        const batch = segments.slice(offset, offset + MAX_CONCURRENT_DOWNLOADS);

        logDebug('segments.batch.started', {
            guid,
            batch: batchNumber,
            totalBatches,
            size: batch.length,
            offset,
        });

        const batchPromises = batch.map(async (segment, batchIndex) => {
            const globalIndex = offset + batchIndex;

            let data = await fetchSegment(segment.url, signal);
            if (cryptoKey) {
                throwIfAborted(signal, 'segment-decrypt-aborted');
                data = await decryptSegment(data, cryptoKey, ivHex);
            }

            chunks[globalIndex] = data;
            completed += 1;
            onProgress(completed);

            return data;
        });

        await Promise.all(batchPromises);
        throwIfAborted(signal, 'segment-download-aborted');

        logDebug('segments.batch.completed', {
            guid,
            batch: batchNumber,
            totalBatches,
            completedSegments: completed,
            totalSegments: segments.length,
        });
    }

    return chunks;
}

/**
 * Restores the download button state to its initial value.
 *
 * @param {HTMLButtonElement} button Download button element.
 */
function resetButtonState(button) {
    button.textContent = button.dataset.idleText ?? t('buttonDownload');
    button.disabled = false;
}

/**
 * Returns whether a session is still current.
 *
 * @param {{id: number} | null} session Download session.
 * @returns {boolean}
 */
function isSessionCurrent(session) {
    return Boolean(session) && activeDownloadSession?.id === session.id;
}

/**
 * Throws when session lock changed or abort signal is set.
 *
 * @param {{id: number, abortController: AbortController}} session Download session.
 * @param {string} reason Guard reason.
 */
function ensureSessionActive(session, reason) {
    if (!isSessionCurrent(session)) {
        throw createCancelledError(`session-mismatch:${reason}`);
    }

    throwIfAborted(session.abortController.signal, reason);
}

/**
 * Creates a cancellation error marker.
 *
 * @param {string} reason Cancellation reason.
 * @returns {Error & {isCancelled: boolean, reason: string}}
 */
function createCancelledError(reason) {
    const error = new Error(reason);
    error.isCancelled = true;
    error.reason = reason;

    return error;
}

/**
 * Determines whether an error was caused by user/system cancellation.
 *
 * @param {unknown} error Error candidate.
 * @returns {boolean}
 */
function isCancelledError(error) {
    return Boolean(error?.isCancelled) || error?.name === 'AbortError';
}

/**
 * Throws cancellation error when signal is already aborted.
 *
 * @param {AbortSignal | undefined} signal Abort signal.
 * @param {string} reason Cancellation reason.
 */
function throwIfAborted(signal, reason) {
    if (!signal?.aborted) return;

    throw createCancelledError(reason);
}

/**
 * Cancels active download session.
 *
 * @param {string} reason Cancellation reason.
 */
function cancelActiveDownload(reason) {
    const session = activeDownloadSession;
    if (!session) return;
    if (session.cancelRequested) return;

    session.cancelRequested = true;
    logWarn('download.cancel.requested', {
        guid: session.guid,
        reason,
    });

    try {
        session.abortController.abort();
    } catch {
        // Intentionally ignored.
    }

    try {
        session.workerTerminate?.();
    } catch {
        // Intentionally ignored.
    }
}

/**
 * Ensures cancel button is available for active downloads.
 *
 * @param {HTMLElement} wrapper Wrapper element.
 * @param {() => void | Promise<void>} onClick Click handler.
 * @returns {HTMLButtonElement}
 */
function ensureCancelButton(wrapper, onClick) {
    let cancelButton = wrapper.querySelector(`.${CANCEL_BUTTON_CLASS}`);

    if (!cancelButton) {
        cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = CANCEL_BUTTON_CLASS;
        wrapper.appendChild(cancelButton);
    }

    cancelButton.textContent = t('buttonCancelDownload');
    cancelButton.onclick = () => {
        void onClick();
    };

    return cancelButton;
}

/**
 * Removes cancel button from wrapper if present.
 *
 * @param {HTMLElement} wrapper Wrapper element.
 */
function removeCancelButton(wrapper) {
    const cancelButton = wrapper.querySelector(`.${CANCEL_BUTTON_CLASS}`);
    if (cancelButton) {
        cancelButton.remove();
    }
}

/**
 * Clears active download lock.
 */
function clearActiveDownloadSession() {
    activeDownloadSession = null;
    downloadInProgress = false;
}

/**
 * Validates that active session still belongs to current wrapper/iframe.
 */
function validateActiveDownloadSession() {
    const session = activeDownloadSession;
    if (!session) return;

    if (!session.wrapper?.isConnected) {
        logWarn('download.session.reset', {
            guid: session.guid,
            reason: 'wrapper-detached',
        });
        cancelActiveDownload('wrapper-detached');
        clearActiveDownloadSession();

        return;
    }

    const iframe = session.wrapper.querySelector('iframe');
    const currentGuid = iframe ? extractGuidFromIframe(iframe.src) : null;

    if (!currentGuid || currentGuid !== session.guid) {
        logWarn('download.session.reset', {
            guid: session.guid,
            currentGuid,
            reason: 'iframe-guid-changed',
        });
        cancelActiveDownload('iframe-guid-changed');

        if (session.button?.isConnected) {
            resetButtonState(session.button);
        }

        removeCancelButton(session.wrapper);
        clearActiveDownloadSession();
    }
}

/**
 * Extracts a video GUID from an iframe source URL.
 *
 * @param {string} src Iframe source URL.
 * @returns {string | null}
 */
function extractGuidFromIframe(src) {
    const guidMatch = src.match(/embed\/\d+\/([a-f0-9-]{36})/i);

    return guidMatch ? guidMatch[1] : null;
}

/**
 * Adds buttons to all currently available wrappers in the page.
 */
function hydrateExistingWrappers() {
    validateActiveDownloadSession();

    document.querySelectorAll('.iframeWrapper').forEach((wrapper) => {
        const iframe = wrapper.querySelector('iframe');
        if (!iframe) return;

        const guid = extractGuidFromIframe(iframe.src);
        if (guid) {
            addDownloadButton(wrapper, guid);
        }
    });
}

/**
 * Starts DOM observation and injects the downloader UI for supported iframes.
 */
function initObserver() {
    const observer = new MutationObserver(() => {
        hydrateExistingWrappers();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    hydrateExistingWrappers();
}

/**
 * Boots the content runtime.
 */
async function bootstrap() {
    await loadSettings();
    ensureStylesInjected();
    initObserver();
    refreshIdleButtonLabels();

    logDebug('runtime.ready', {
        language: activeLanguage,
    });
}

bootstrap();
