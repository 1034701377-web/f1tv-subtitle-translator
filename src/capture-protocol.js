// F1 playback rules belong to the userscript; the extension only validates
// the transport and uses the supplied timeline and readiness messages.
export function validCaptureSnapshot(value, programmeId = value?.programmeId) {
  return value?.protocol === 1 && typeof value.programmeId === 'string'
    && /^[A-Za-z0-9_:-]{1,120}$/.test(value.programmeId) && value.programmeId === programmeId
    && ['time', 'origin', 'at', 'rate', 'epoch'].every(key => Number.isFinite(value[key]))
    && value.time >= 0 && value.origin >= 0 && value.at >= 0 && value.rate > 0
    && typeof value.paused === 'boolean' && typeof value.muted === 'boolean'
    && (value.startProblem === null || typeof value.startProblem === 'string')
    && (value.problem === null || typeof value.problem === 'string');
}
