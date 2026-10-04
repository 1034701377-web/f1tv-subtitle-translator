export const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
const comparableText = value => cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function hash(value) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result >>> 0).toString(36);
}

function similarText(a, b) {
  const left = comparableText(a), right = comparableText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 6) return false;
  if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) / Math.max(left.length, right.length) >= .55) return true;
  const pairs = value => new Set(Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)));
  const aPairs = pairs(left), bPairs = pairs(right);
  const common = [...aPairs].filter(pair => bPairs.has(pair)).length;
  return (2 * common) / (aPairs.size + bPairs.size) >= .78;
}

/** First delivery wins: neighbouring windows cannot rewrite a visible sentence. */
export function mergeTrackFxCues(existing, incoming, scope = 'track-fx') {
  const cues = [...existing], added = [];
  for (const candidate of incoming) {
    const text = cleanText(candidate.text);
    if (!text || !Number.isFinite(candidate.start) || !Number.isFinite(candidate.end) || candidate.end <= candidate.start) continue;
    const duplicate = cues.some(cue => {
      const overlap = Math.min(cue.end, candidate.end) - Math.max(cue.start, candidate.start);
      const near = overlap >= Math.min(cue.end - cue.start, candidate.end - candidate.start) * .25
        || Math.abs(cue.start - candidate.start) <= 1.2;
      return near && similarText(cue.text, text);
    });
    if (duplicate) continue;
    const cue = Object.freeze({ ...candidate, text, source: 'track-fx',
      id: `fx:${scope}:${Math.round(candidate.start * 1000)}:${hash(comparableText(text))}` });
    cues.push(cue); added.push(cue);
  }
  return { cues, added };
}

/** Hold possible cut-off speech until the next overlapping window has returned. */
export function settleTrackFxWindowCues(window, windows) {
  const next = windows.find(item => item.start > window.start && item.start < window.end && item.end > window.end);
  return window.rawCues.flatMap(cue => {
    if (window.terminal || cue.end < window.end - .4) return [cue];
    if (!next) return [];
    const fuller = next.rawCues.find(candidate => candidate.end < next.end - .4
      && Math.min(candidate.end, cue.end) > Math.max(candidate.start, cue.start)
      && similarText(candidate.text, cue.text) && cleanText(candidate.text).length >= cleanText(cue.text).length);
    // A sentence longer than the overlap can still be cut in both windows.
    // After waiting one full window, retain the original instead of fabricating
    // missing words or extending its time range without recognition evidence.
    return [fuller || cue];
  });
}

