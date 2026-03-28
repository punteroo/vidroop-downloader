const LOG_PREFIX = '[Vidroop Downloader:BG]';
const PLAYLIST_TTL_MS = 120_000;
const HOST_TTL_MS = 300_000;
const MAX_RECENT_HOSTS = 12;
const FALLBACK_CDN_HOST = 'vz-7703e207-751.b-cdn.net';

/**
 * Stores the most recently captured playlist metadata.
 *
 * @type {{url: string, guid: string | null, host: string | null, capturedAt: number} | null}
 */
let latestPlaylistRecord = null;

/**
 * Maps video GUID -> latest known playlist metadata.
 *
 * @type {Map<string, {url: string, host: string | null, capturedAt: number}>}
 */
const playlistByGuid = new Map();

/**
 * Stores recently seen CDN hosts.
 *
 * @type {Array<{host: string, capturedAt: number}>}
 */
const recentHosts = [];

/**
 * Logs structured debug telemetry from background runtime.
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
 * Logs structured warning telemetry from background runtime.
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
 * Attempts to extract a GUID from a URL.
 *
 * @param {string} url Any URL that may contain a UUID-like GUID.
 * @returns {string | null}
 */
function extractGuid(url) {
    const guidMatch = url.match(/([a-f0-9-]{36})/i);

    return guidMatch ? guidMatch[1] : null;
}

/**
 * Extracts the host from an URL.
 *
 * @param {string} url URL to parse.
 * @returns {string | null}
 */
function extractHost(url) {
    try {
        return new URL(url).host;
    } catch {
        return null;
    }
}

/**
 * Indicates whether a timestamp is still considered fresh for the given TTL.
 *
 * @param {number} capturedAt Epoch milliseconds of when the item was captured.
 * @param {number} ttlMs TTL in milliseconds.
 * @returns {boolean}
 */
function isFresh(capturedAt, ttlMs) {
    return Date.now() - capturedAt <= ttlMs;
}

/**
 * Builds the canonical playlist URL for a host + GUID.
 *
 * @param {string} host CDN host.
 * @param {string} guid Video GUID.
 * @returns {string}
 */
function buildPlaylistUrl(host, guid) {
    return `https://${host}/${guid}/playlist.m3u8`;
}

/**
 * Registers a CDN host as recently observed.
 *
 * @param {string} host Host to register.
 * @param {number} now Current timestamp.
 */
function touchRecentHost(host, now) {
    const index = recentHosts.findIndex((entry) => entry.host === host);
    if (index >= 0) {
        recentHosts[index].capturedAt = now;
    } else {
        recentHosts.push({ host, capturedAt: now });
    }

    recentHosts.sort((a, b) => b.capturedAt - a.capturedAt);
    if (recentHosts.length > MAX_RECENT_HOSTS) {
        recentHosts.length = MAX_RECENT_HOSTS;
    }
}

/**
 * Removes stale playlist and host state.
 */
function pruneStaleState() {
    for (const [guid, record] of playlistByGuid.entries()) {
        if (!isFresh(record.capturedAt, PLAYLIST_TTL_MS)) {
            playlistByGuid.delete(guid);
        }
    }

    if (
        latestPlaylistRecord &&
        !isFresh(latestPlaylistRecord.capturedAt, PLAYLIST_TTL_MS)
    ) {
        latestPlaylistRecord = null;
    }

    for (let index = recentHosts.length - 1; index >= 0; index--) {
        if (!isFresh(recentHosts[index].capturedAt, HOST_TTL_MS)) {
            recentHosts.splice(index, 1);
        }
    }
}

/**
 * Stores captured playlist metadata for future resolution.
 *
 * @param {string} url Captured playlist URL.
 */
function rememberPlaylist(url) {
    const now = Date.now();
    const guid = extractGuid(url);
    const host = extractHost(url);

    latestPlaylistRecord = { url, guid, host, capturedAt: now };

    if (guid) {
        playlistByGuid.set(guid, { url, host, capturedAt: now });
    }

    if (host) {
        touchRecentHost(host, now);
    }

    logDebug('playlist.remembered', {
        guid,
        host,
        url,
        recentHostCount: recentHosts.length,
    });

    pruneStaleState();
}

/**
 * Returns an ordered list of playlist candidates for a GUID.
 *
 * @param {string | undefined} guid Optional video GUID.
 * @returns {string[]}
 */
function resolvePlaylistCandidates(guid) {
    pruneStaleState();

    const candidates = [];

    if (guid) {
        const guidRecord = playlistByGuid.get(guid);
        if (guidRecord?.url) {
            candidates.push(guidRecord.url);
        }
    }

    if (latestPlaylistRecord?.url) {
        candidates.push(latestPlaylistRecord.url);
    }

    if (guid) {
        recentHosts.forEach((entry) => {
            candidates.push(buildPlaylistUrl(entry.host, guid));
        });

        candidates.push(buildPlaylistUrl(FALLBACK_CDN_HOST, guid));
    }

    const resolved = Array.from(new Set(candidates.filter(Boolean)));

    logDebug('candidates.resolved', {
        guid: guid ?? null,
        count: resolved.length,
        hosts: Array.from(new Set(resolved.map((url) => extractHost(url)).filter(Boolean))),
    });

    return resolved;
}

/**
 * Invalidates stale candidate references after HTTP failures.
 *
 * @param {string | undefined} guid Optional video GUID.
 * @param {string | undefined} url Failing URL.
 * @param {number | undefined} status HTTP status code.
 */
function invalidateCandidate(guid, url, status) {
    if (!url || (status !== 403 && status !== 404)) return;

    const host = extractHost(url);

    if (guid) {
        const record = playlistByGuid.get(guid);
        if (record?.url === url) {
            playlistByGuid.delete(guid);
        }
    }

    if (latestPlaylistRecord?.url === url) {
        latestPlaylistRecord = null;
    }

    if (host) {
        const hostIndex = recentHosts.findIndex((entry) => entry.host === host);
        if (hostIndex >= 0) {
            recentHosts.splice(hostIndex, 1);
        }
    }

    logWarn('candidate.invalidated', {
        guid: guid ?? null,
        url,
        status,
        host,
    });
}

/**
 * Handles captured requests and stores playlist references.
 *
 * @param {{url: string}} details webRequest details.
 */
function handleBeforeRequest(details) {
    if (!details?.url?.includes('.m3u8')) return;

    rememberPlaylist(details.url);
    logDebug('request.captured', {
        url: details.url,
        host: extractHost(details.url),
        guid: extractGuid(details.url),
    });
}

chrome.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ['https://*.b-cdn.net/*'] },
    [],
);

/**
 * Handles runtime messages for playlist resolution and stale cache eviction.
 *
 * @param {{action?: string, guid?: string, url?: string, status?: number}} request Runtime message payload.
 * @param {chrome.runtime.MessageSender} _sender Message sender metadata.
 * @param {(response: {playlistUrl?: string | null, playlistUrls?: string[], acknowledged?: boolean}) => void} sendResponse Message response callback.
 */
function handleRuntimeMessage(request, _sender, sendResponse) {
    if (!request?.action) return;

    if (request.action === 'reportPlaylistFailure') {
        invalidateCandidate(request.guid, request.url, request.status);
        sendResponse({ acknowledged: true });

        return;
    }

    if (request.action === 'resolvePlaylists') {
        const playlistUrls = resolvePlaylistCandidates(request.guid);
        sendResponse({ playlistUrls });

        logDebug('message.resolvePlaylists', {
            guid: request.guid ?? null,
            count: playlistUrls.length,
        });

        return;
    }

    if (request.action !== 'getPlaylist') return;

    const playlistUrls = resolvePlaylistCandidates(request.guid);
    sendResponse({ playlistUrl: playlistUrls[0] ?? null });

    logDebug('message.getPlaylist', {
        guid: request.guid ?? null,
        selected: playlistUrls[0] ?? null,
    });
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);