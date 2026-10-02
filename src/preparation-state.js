const prepTimeEpsilon = 1e-6;

// Coverage means the official caption source has been read, including silence.
// A translated cue farther ahead cannot establish coverage across an unread gap.
export function commentaryPreparation({ enabled, time, coverage = [], cues = [], targetSeconds = 45 } = {}) {
  const prepTimeValid = Number.isFinite(time) && time >= 0;
  const prepInitial = { state: enabled ? 'preparing' : 'waiting', ahead: 0, readyUntil: prepTimeValid ? time : null };
  if (!enabled || !prepTimeValid) return prepInitial;

  const prepRanges = Array.isArray(coverage) ? coverage.filter(range => Array.isArray(range)
    && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] >= 0 && range[1] > range[0])
    .map(range => [range[0], range[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) : [];
  let prepUntil = time;
  for (const prepRange of prepRanges) {
    if (prepRange[1] <= prepUntil) continue;
    if (prepRange[0] > prepUntil + prepTimeEpsilon) break;
    prepUntil = prepRange[1];
  }

  for (const prepCue of Array.isArray(cues) ? cues : []) {
    if (!prepCue || !Number.isFinite(prepCue.start) || !Number.isFinite(prepCue.end)
      || prepCue.end <= prepCue.start || prepCue.end <= time || prepCue.start >= prepUntil) continue;
    const prepCueReady = prepCue.status === 'ready' && typeof prepCue.zh === 'string' && !!prepCue.zh.trim();
    if (!prepCueReady) prepUntil = Math.max(time, Math.min(prepUntil, prepCue.start));
  }

  const prepAhead = Math.max(0, prepUntil - time);
  const prepTarget = Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : 45;
  return { state: prepAhead + prepTimeEpsilon >= prepTarget ? 'ready' : 'preparing', ahead: prepAhead, readyUntil: prepUntil };
}
