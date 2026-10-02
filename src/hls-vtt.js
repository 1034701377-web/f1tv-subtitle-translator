const MAX_PLAYLIST_CHARS = 8_000_000;
const MAX_SEGMENTS = 20_000;
const MAX_VTT_CHARS = 2_000_000;
const MAX_CUES = 20_000;
const MAX_CUE_CHARS = 20_000;

function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${label} must be text within ${maximum} characters`);
  }
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function httpUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error('Invalid HLS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('HLS URLs must use HTTP(S) without embedded credentials');
  }
  return url.href;
}

function unsignedInteger(value, label) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${label}`);
  }
  return Number(value);
}

/** Parse a complete, unencrypted HLS subtitle media playlist. Times are seconds. */
export function parseHlsVodPlaylist(text, baseUrl) {
  const lines = boundedText(text, MAX_PLAYLIST_CHARS, 'HLS playlist').split('\n');
  const base = httpUrl(baseUrl);
  if (lines.shift()?.trim() !== '#EXTM3U') throw new Error('Missing HLS EXTM3U header');

  const segments = [];
  let duration = 0;
  let nextDuration = null;
  let firstSequence = 0;
  let sawSequence = false;
  let sawType = false;
  let ended = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      // Ordinary comments have no playlist semantics.
      if (!line.startsWith('#EXT')) continue;
      if (ended) throw new Error('HLS tags after ENDLIST are unsupported');
      if (line === '#EXT-X-ENDLIST') {
        if (nextDuration !== null) throw new Error('HLS segment URI missing');
        ended = true;
      } else if (line.startsWith('#EXTINF:')) {
        if (nextDuration !== null) throw new Error('HLS segment URI missing');
        const match = /^#EXTINF:(\d+(?:\.\d+)?),.*$/.exec(line);
        const value = match && Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid HLS segment duration');
        nextDuration = value;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        if (sawType || line !== '#EXT-X-PLAYLIST-TYPE:VOD') {
          throw new Error('Only complete HLS VOD playlists are supported');
        }
        sawType = true;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        if (sawSequence || segments.length || nextDuration !== null) {
          throw new Error('Invalid HLS media sequence placement');
        }
        firstSequence = unsignedInteger(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 'HLS media sequence');
        sawSequence = true;
      } else if (line.startsWith('#EXT-X-VERSION:')) {
        if (unsignedInteger(line.slice('#EXT-X-VERSION:'.length), 'HLS version') < 1) {
          throw new Error('Invalid HLS version');
        }
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        if (unsignedInteger(line.slice('#EXT-X-TARGETDURATION:'.length), 'HLS target duration') < 1) {
          throw new Error('Invalid HLS target duration');
        }
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        if (!Number.isFinite(Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length)))) {
          throw new Error('Invalid HLS program date time');
        }
        // This wall-clock metadata is not a cue-time offset.
      } else if (/^#EXT-X-ALLOW-CACHE:(?:YES|NO)$/.test(line)
          || line === '#EXT-X-INDEPENDENT-SEGMENTS') {
        // Neither tag changes subtitle segment addressing or timestamps.
      } else {
        const tag = line.split(':', 1)[0];
        throw new Error(`Unsupported HLS tag: ${tag}`);
      }
      continue;
    }

    if (ended) throw new Error('HLS segment after ENDLIST');
    if (nextDuration === null) throw new Error('HLS segment requires EXTINF');
    if (segments.length >= MAX_SEGMENTS || line.length > 32_768) {
      throw new Error('HLS segment limit exceeded');
    }
    const end = duration + nextDuration;
    const sequence = firstSequence + segments.length;
    if (!Number.isFinite(end) || end <= duration || !Number.isSafeInteger(sequence)) {
      throw new Error('Invalid HLS timeline');
    }
    segments.push({ url: httpUrl(line, base), start: duration, end, sequence });
    duration = end;
    nextDuration = null;
  }
  if (!ended) throw new Error('Only complete HLS VOD playlists with ENDLIST are supported');
  if (!segments.length) throw new Error('HLS playlist contains no segments');
  return { segments, duration };
}

/** Parse a continuous, unencrypted live/EVENT playlist into Unix-second times. */
export function parseHlsLivePlaylist(text, baseUrl) {
  const lines = boundedText(text, MAX_PLAYLIST_CHARS, 'HLS playlist').split('\n');
  const base = httpUrl(baseUrl);
  if (lines.shift()?.trim() !== '#EXTM3U') throw new Error('Missing HLS EXTM3U header');

  const segments = [];
  const anchors = [];
  let durationMs = 0;
  let nextDuration = null;
  let nextDate = null;
  let firstSequence = 0;
  let sawSequence = false;
  let sawType = false;
  let sawDiscontinuitySequence = false;
  let targetDuration = null;
  let discontinuitySequence = 0;
  let ended = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!line.startsWith('#EXT')) continue;
      if (ended) throw new Error('HLS tags after ENDLIST are unsupported');
      if (line === '#EXT-X-ENDLIST') {
        if (nextDuration !== null || nextDate !== null) throw new Error('HLS segment URI missing');
        ended = true;
      } else if (line.startsWith('#EXTINF:')) {
        if (nextDuration !== null) throw new Error('HLS segment URI missing');
        const match = /^#EXTINF:(\d+(?:\.\d+)?),.*$/.exec(line);
        const value = match && Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid HLS segment duration');
        nextDuration = value * 1000;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        if (sawType || line !== '#EXT-X-PLAYLIST-TYPE:EVENT') {
          throw new Error('Only live or EVENT HLS playlists are supported');
        }
        sawType = true;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        if (sawSequence || segments.length || nextDuration !== null) {
          throw new Error('Invalid HLS media sequence placement');
        }
        firstSequence = unsignedInteger(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 'HLS media sequence');
        sawSequence = true;
      } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        if (sawDiscontinuitySequence || segments.length || nextDuration !== null) {
          throw new Error('Invalid HLS discontinuity sequence placement');
        }
        discontinuitySequence = unsignedInteger(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length), 'HLS discontinuity sequence');
        sawDiscontinuitySequence = true;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        if (targetDuration !== null) throw new Error('Duplicate HLS target duration');
        targetDuration = unsignedInteger(line.slice('#EXT-X-TARGETDURATION:'.length), 'HLS target duration');
        if (targetDuration < 1) throw new Error('Invalid HLS target duration');
      } else if (line.startsWith('#EXT-X-VERSION:')) {
        if (unsignedInteger(line.slice('#EXT-X-VERSION:'.length), 'HLS version') < 1) {
          throw new Error('Invalid HLS version');
        }
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        const value = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
        if (nextDate !== null || !Number.isFinite(value)) throw new Error('Invalid HLS program date time');
        nextDate = value;
      } else if (line !== '#EXT-X-INDEPENDENT-SEGMENTS') {
        throw new Error(`Unsupported HLS tag: ${line.split(':', 1)[0]}`);
      }
      continue;
    }

    if (ended) throw new Error('HLS segment after ENDLIST');
    if (nextDuration === null) throw new Error('HLS segment requires EXTINF');
    if (segments.length >= MAX_SEGMENTS || line.length > 32_768) throw new Error('HLS segment limit exceeded');
    const end = durationMs + nextDuration;
    const sequence = firstSequence + segments.length;
    if (!Number.isFinite(end) || end <= durationMs || !Number.isSafeInteger(sequence)) {
      throw new Error('Invalid HLS timeline');
    }
    if (nextDate !== null) anchors.push({ date: nextDate, offset: durationMs });
    segments.push({ url: httpUrl(line, base), start: durationMs, end, sequence });
    durationMs = end;
    nextDuration = null;
    nextDate = null;
  }

  if (nextDuration !== null || nextDate !== null) throw new Error('HLS segment URI missing');
  if (!segments.length) throw new Error('HLS playlist contains no segments');
  if (targetDuration === null) throw new Error('Missing HLS target duration');
  if (!anchors.length) throw new Error('Missing HLS program date time anchor');
  const first = anchors[0];
  for (const anchor of anchors) {
    // Compare relative milliseconds; allow only floating-point accumulation noise.
    if (Math.abs((anchor.date - first.date) - (anchor.offset - first.offset)) > 0.001) {
      throw new Error('Discontinuous HLS program date time');
    }
  }
  const origin = first.date - first.offset;
  for (const segment of segments) {
    segment.start = (origin + segment.start) / 1000;
    segment.end = (origin + segment.end) / 1000;
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) {
      throw new Error('Invalid HLS absolute timeline');
    }
  }
  return { segments, duration: durationMs / 1000, targetDuration, discontinuitySequence, ended };
}

function timestampMs(value) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) {
    throw new Error('Invalid WebVTT timestamp');
  }
  const result = (Number(match[1] || 0) * 3600 + Number(match[2]) * 60
    + Number(match[3])) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(result)) throw new Error('Invalid WebVTT timestamp');
  return result;
}

function verifyTimestampMap(line) {
  const match = /^X-TIMESTAMP-MAP\s*=\s*(.+)$/.exec(line);
  try {
    if (!match) throw new Error('Missing mapping');
    const values = new Map();
    for (const field of match[1].split(',')) {
      const part = /^(LOCAL|MPEGTS):(.+)$/.exec(field.trim());
      if (!part || values.has(part[1])) throw new Error('Invalid mapping');
      values.set(part[1], part[2]);
    }
    if (values.size !== 2 || timestampMs(values.get('LOCAL')) !== 0
        || !/^0+$/.test(values.get('MPEGTS') || '')) {
      throw new Error('Nonzero mapping');
    }
  } catch {
    throw new Error('Unverified timestamp mapping');
  }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '\u200E', rlm: '\u200F',
};

function cueText(value) {
  return value.replace(/<[^>]*>/g, '').replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi,
    (original, name) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? original;
      const point = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(point) && point > 0 && point <= 0x10FFFF
        && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : '\uFFFD';
    },
  ).split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim()).join('\n').trim();
}

function textHash(value) {
  // A deterministic 64-bit FNV-1a fingerprint; no browser or Node APIs required.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Parse absolute VOD cue times, refusing unverified MPEG timestamp mappings. */
export function parseWebVtt(text, { epoch = 'vod' } = {}) {
  if (typeof epoch !== 'string' || !epoch || epoch.length > 128) {
    throw new Error('Invalid WebVTT epoch');
  }
  const lines = boundedText(text, MAX_VTT_CHARS, 'WebVTT').split('\n');
  const header = lines.shift();
  if (!/^WEBVTT(?:[\t ].*)?$/.test(header || '') || header.includes('-->')) {
    throw new Error('Missing WebVTT header');
  }

  let sawMap = false;
  let cursor = 0;
  for (; cursor < lines.length && lines[cursor].trim(); cursor += 1) {
    const line = lines[cursor].trim();
    if (line.startsWith('X-TIMESTAMP-MAP')) {
      if (sawMap) throw new Error('Unverified timestamp mapping');
      verifyTimestampMap(line);
      sawMap = true;
    } else if (line.includes('-->')) {
      throw new Error('WebVTT header must end with a blank line');
    }
  }

  const cues = [];
  const seen = new Set();
  let parsedCues = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    if (cursor === lines.length) break;
    const block = [];
    while (cursor < lines.length && lines[cursor].trim()) block.push(lines[cursor++]);
    if (/^NOTE(?:[\t ]|$)/.test(block[0])) continue;
    if (block[0] === 'STYLE' || block[0] === 'REGION') {
      if (parsedCues) throw new Error('WebVTT STYLE/REGION must precede cues');
      continue;
    }
    parsedCues += 1;
    if (parsedCues > MAX_CUES) throw new Error('WebVTT cue limit exceeded');

    const timeIndex = block[0].includes('-->') ? 0 : 1;
    const timing = /^(\S+)\s+-->\s+(\S+)(?:[\t ].*)?$/.exec(block[timeIndex]?.trim() || '');
    if (!timing) throw new Error('Invalid WebVTT cue timing');
    const startMs = timestampMs(timing[1]);
    const endMs = timestampMs(timing[2]);
    if (endMs <= startMs) throw new Error('Invalid WebVTT cue time range');
    const rawText = block.slice(timeIndex + 1).join('\n');
    if (rawText.length > MAX_CUE_CHARS) throw new Error('WebVTT cue text limit exceeded');
    if (rawText.includes('-->')) throw new Error('WebVTT cues must be separated by a blank line');
    const cleanText = cueText(rawText);
    if (!cleanText) continue;
    const id = `${epoch}:${startMs}:${endMs}:${textHash(cleanText)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    cues.push({ id, start: startMs / 1000, end: endMs / 1000, text: cleanText });
  }
  return cues;
}
