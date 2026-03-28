import * as muxjs from 'mux.js';
import * as MP4Box from 'mp4box';

const LOG_PREFIX = '[Vidroop Converter Worker]';

/**
 * Emits structured debug events to parent runtime.
 *
 * @param {string} eventName Event identifier.
 * @param {Record<string, unknown>} payload Event payload.
 */
function emitDebug(eventName, payload) {
  self.postMessage({
    type: 'debug',
    payload: {
      eventName,
      timestamp: new Date().toISOString(),
      ...payload,
    },
  });
}

/**
 * Resolves the transmuxer constructor regardless of package export shape.
 *
 * @returns {new (options?: Record<string, unknown>) => any}
 */
function getTransmuxerConstructor() {
  const fromNamespace = muxjs?.mp4?.Transmuxer;
  const fromDefault = muxjs?.default?.mp4?.Transmuxer;
  const Constructor = fromNamespace || fromDefault;

  if (!Constructor) {
    throw new Error('mux.js Transmuxer constructor not available');
  }

  return Constructor;
}

/**
 * Clones a Uint8Array into an ArrayBuffer with exact byte range.
 *
 * @param {Uint8Array} source Source bytes.
 * @returns {ArrayBuffer}
 */
function cloneToArrayBuffer(source) {
  return source.buffer.slice(
    source.byteOffset,
    source.byteOffset + source.byteLength,
  );
}

/**
 * Normalizes buffer-like values into an ArrayBuffer.
 *
 * @param {ArrayBuffer | Uint8Array | {buffer?: ArrayBuffer, byteOffset?: number, byteLength?: number}} value Buffer-like value.
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return cloneToArrayBuffer(value);
  }

  if (
    value?.buffer instanceof ArrayBuffer &&
    typeof value.byteOffset === 'number' &&
    typeof value.byteLength === 'number'
  ) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }

  throw new Error('Unsupported buffer type received from converter runtime');
}

/**
 * Concatenates array buffers into a single array buffer.
 *
 * @param {Array<ArrayBuffer>} buffers Input buffers.
 * @returns {ArrayBuffer}
 */
function concatArrayBuffers(buffers) {
  const totalBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const merged = new Uint8Array(totalBytes);

  let offset = 0;
  buffers.forEach((buffer) => {
    merged.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  });

  return merged.buffer;
}

/**
 * Converts TS chunks to MP4 fragments.
 *
 * @param {Array<ArrayBuffer>} chunks TS chunks in playback order.
 * @param {string} guid Video GUID.
 * @returns {Promise<Array<ArrayBuffer>>}
 */
async function remuxTsToMp4Parts(chunks, guid) {
  const Transmuxer = getTransmuxerConstructor();
  const transmuxer = new Transmuxer({
    keepOriginalTimestamps: true,
  });

  const outputParts = [];
  const totalChunks = chunks.length;

  emitDebug('remux.started', {
    guid,
    totalChunks,
  });

  return new Promise((resolve, reject) => {
    transmuxer.on('data', (segment) => {
      if (segment.initSegment?.byteLength) {
        outputParts.push(cloneToArrayBuffer(segment.initSegment));
      }

      if (segment.data?.byteLength) {
        outputParts.push(cloneToArrayBuffer(segment.data));
      }
    });

    transmuxer.on('done', () => {
      emitDebug('remux.completed', {
        guid,
        parts: outputParts.length,
      });

      resolve(outputParts);
    });

    try {
      chunks.forEach((chunk, index) => {
        transmuxer.push(new Uint8Array(chunk));

        const percent = Math.round(((index + 1) / totalChunks) * 100);
        self.postMessage({
          type: 'progress',
          payload: {
            phase: 'remux',
            processed: index + 1,
            total: totalChunks,
            percent,
          },
        });
      });

      transmuxer.flush();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Parses AAC object type from codec string.
 *
 * @param {string | undefined} codec Codec string (e.g. mp4a.40.2).
 * @returns {number}
 */
function getAacObjectType(codec) {
  const match = codec?.match(/mp4a\.40\.(\d+)/i);
  const objectType = match ? Number.parseInt(match[1], 10) : 2;

  return Number.isFinite(objectType) ? objectType : 2;
}

/**
 * Returns ADTS sampling frequency index.
 *
 * @param {number | undefined} sampleRate Audio sample rate.
 * @returns {number}
 */
function getAdtsSampleRateIndex(sampleRate) {
  const indexByRate = new Map([
    [96000, 0],
    [88200, 1],
    [64000, 2],
    [48000, 3],
    [44100, 4],
    [32000, 5],
    [24000, 6],
    [22050, 7],
    [16000, 8],
    [12000, 9],
    [11025, 10],
    [8000, 11],
    [7350, 12],
  ]);

  return indexByRate.get(sampleRate ?? 44100) ?? 4;
}

/**
 * Builds ADTS header for a single AAC frame.
 *
 * @param {number} frameLength AAC frame payload length.
 * @param {number} objectType AAC object type.
 * @param {number} sampleRateIndex ADTS frequency index.
 * @param {number} channelConfig Channel configuration.
 * @returns {Uint8Array}
 */
function buildAdtsHeader(frameLength, objectType, sampleRateIndex, channelConfig) {
  const fullLength = frameLength + 7;
  const profile = Math.max(1, objectType) - 1;
  const channels = Math.max(1, channelConfig);

  return Uint8Array.from([
    0xff,
    0xf1,
    ((profile & 0x03) << 6) | ((sampleRateIndex & 0x0f) << 2) | ((channels >> 2) & 0x01),
    ((channels & 0x03) << 6) | ((fullLength >> 11) & 0x03),
    (fullLength >> 3) & 0xff,
    ((fullLength & 0x07) << 5) | 0x1f,
    0xfc,
  ]);
}

/**
 * Builds a full ADTS AAC frame.
 *
 * @param {ArrayBuffer} sampleBuffer Raw AAC sample.
 * @param {number} objectType AAC object type.
 * @param {number} sampleRateIndex ADTS frequency index.
 * @param {number} channelConfig Channel configuration.
 * @returns {ArrayBuffer}
 */
function buildAdtsFrame(sampleBuffer, objectType, sampleRateIndex, channelConfig) {
  const sample = new Uint8Array(sampleBuffer);
  const header = buildAdtsHeader(
    sample.byteLength,
    objectType,
    sampleRateIndex,
    channelConfig,
  );
  const out = new Uint8Array(header.byteLength + sample.byteLength);

  out.set(header, 0);
  out.set(sample, header.byteLength);

  return out.buffer;
}

/**
 * Extracts audio from an MP4 buffer and writes an AAC output.
 *
 * @param {ArrayBuffer} mp4Buffer Input MP4 buffer.
 * @param {string} guid Video GUID.
 * @returns {Promise<ArrayBuffer>}
 */
async function convertMp4ToAac(mp4Buffer, guid) {
  return new Promise((resolve, reject) => {
    const parser = MP4Box.createFile();
    let settled = false;
    let extractionStarted = false;
    let expectedSamples = null;
    const collectedSamples = [];

    /**
     * Finalizes extracted audio samples into a single AAC file.
     *
     * @param {any} audioTrack Audio track metadata.
     */
    function finalizeExtraction(audioTrack) {
      if (settled) return;

      if (!collectedSamples.length) {
        settled = true;
        reject(new Error('No audio samples extracted from MP4 stream'));

        return;
      }

      try {
        const objectType = getAacObjectType(audioTrack.codec);
        const sampleRate = audioTrack.audio?.sample_rate || 44100;
        const sampleRateIndex = getAdtsSampleRateIndex(sampleRate);
        const channelConfig = audioTrack.audio?.channel_count || 2;

        const adtsFrames = collectedSamples.map((sample) =>
          buildAdtsFrame(
            toArrayBuffer(sample.data),
            objectType,
            sampleRateIndex,
            channelConfig,
          ),
        );

        const outputBuffer = concatArrayBuffers(adtsFrames);
        if (outputBuffer.byteLength < 2048) {
          throw new Error(
            `Generated AAC output is too small (${outputBuffer.byteLength} bytes)`,
          );
        }

        emitDebug('aac.extract.completed', {
          guid,
          samples: collectedSamples.length,
          sampleRate,
          channelConfig,
          outputBytes: outputBuffer.byteLength,
        });

        settled = true;
        resolve(outputBuffer);
      } catch (error) {
        settled = true;
        reject(error);
      }
    }

    parser.onError = (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${LOG_PREFIX} MP4 parsing failed: ${error}`));
    };

    parser.onReady = (info) => {
      try {
        if (extractionStarted) return;

        const audioTrack = info?.audioTracks?.[0];
        if (!audioTrack) {
          throw new Error('No audio track found in MP4 stream');
        }

        extractionStarted = true;
        expectedSamples =
          audioTrack.nb_samples ||
          audioTrack.sample_count ||
          audioTrack.samples_count ||
          null;

        emitDebug('aac.extract.started', {
          guid,
          audioTrackId: audioTrack.id,
          codec: audioTrack.codec,
          expectedSamples,
        });

        parser.setExtractionOptions(audioTrack.id, null, {
          nbSamples: 2000,
        });

        parser.onSamples = (id, _user, samples) => {
          if (settled) return;
          if (id !== audioTrack.id || !samples?.length) return;

          collectedSamples.push(...samples);

          if (expectedSamples && collectedSamples.length >= expectedSamples) {
            finalizeExtraction(audioTrack);
          }
        };

        // Start extraction pass after metadata pass has provided track information.
        parser.start();

        const extractionBuffer = mp4Buffer.slice(0);
        extractionBuffer.fileStart = 0;
        parser.appendBuffer(extractionBuffer);
        parser.flush();

        // If expected sample count is unavailable, finalize after extraction tick.
        setTimeout(() => {
          if (settled) return;

          finalizeExtraction(audioTrack);
        }, 0);
      } catch (error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
    };

    // First pass only for metadata discovery.
    const metadataBuffer = mp4Buffer.slice(0);
    metadataBuffer.fileStart = 0;
    parser.appendBuffer(metadataBuffer);
  });
}

/**
 * Converts TS chunks according to selected output format.
 *
 * @param {Array<ArrayBuffer>} chunks TS chunks in playback order.
 * @param {string} guid Video GUID.
 * @param {'mp4' | 'aac'} format Output format identifier.
 * @returns {Promise<Array<ArrayBuffer>>}
 */
async function convert(chunks, guid, format) {
  const mp4Parts = await remuxTsToMp4Parts(chunks, guid);

  if (format === 'mp4') {
    return mp4Parts;
  }

  self.postMessage({
    type: 'progress',
    payload: {
      phase: 'audio',
      percent: 100,
    },
  });

  const mp4Buffer = concatArrayBuffers(mp4Parts);
  const aacBuffer = await convertMp4ToAac(mp4Buffer, guid);

  return [aacBuffer];
}

self.onmessage = async (event) => {
  const { action, guid, format, chunks } = event.data || {};

  if (action !== 'convert') return;

  try {
    const targetFormat = format === 'aac' ? 'aac' : 'mp4';
    const parts = (await convert(chunks, guid, targetFormat)).map((part) =>
      toArrayBuffer(part),
    );
    const transferables = parts.filter((part) => part instanceof ArrayBuffer);

    self.postMessage(
      {
        type: 'done',
        payload: {
          parts,
        },
      },
      transferables,
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      payload: {
        message: `${LOG_PREFIX} ${error?.message ?? 'Unknown conversion error'}`,
      },
    });
  }
};
