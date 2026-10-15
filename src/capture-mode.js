// Explicit replay mode keeps VOD test captions separate from live captions.
export function capturePageInfo(href) {
  try {
    const url = new URL(href), id = /^\/detail\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    if (url.origin !== 'https://f1tv.formula1.com' || !id) return null;
    const replay = url.searchParams.get('f1zh-replay') === '1';
    return { programmeId: `${id}:${replay ? 'vod-test' : 'live'}`, mode: replay ? 'vod-test' : 'live', replay,
      collector: ['f1zh-capture', 'f1zh-audio'].some(key => url.searchParams.get(key) === '1') };
  } catch { return null; }
}
export function validCaptureClock(value, capture) {
  return value?.collector === true && value.programmeId === capture.programmeId
    && ['time', 'origin', 'at', 'rate', 'epoch'].every(key => Number.isFinite(value[key]))
    && value.time >= 0 && value.at >= 0 && typeof value.paused === 'boolean' && typeof value.muted === 'boolean'
    && (capture.mode === 'vod-test' ? value.eventType === 'vod' && value.origin === 0
      : capture.mode === 'live' && value.eventType === 'live' && value.origin > 1e9);
}
export function captureStartProblem(page, snapshot) {
  if (!snapshot) return '扩展未收到网页响应，请刷新此页。';
  if (snapshot.eventType === 'vod' && !page?.replay) return '这是回放，请先在观看页控制台展开“用录播测试 TR”，再点击“开始录播测试”。';
  if (!snapshot.collector || !page?.collector) return '这是观看页；请在网页控制台点击“打开声音采集页”，并在新页准备 Track FX。';
  if (!validCaptureClock(snapshot, page)) return '扩展未取得匹配的官方节目时间，请刷新两页并选择同一节目。';
  if (!snapshot.trackFx) return '当前音轨不是 Track FX，请先点“准备 Track FX”或在官网选择 Track FX。';
  if (snapshot.paused || snapshot.muted || Math.abs(snapshot.rate - 1) > .01) return '请保持采集页正常音量、1 倍速并播放 Track FX。';
  if (!page.replay && (!Number.isFinite(snapshot.behindLive) || snapshot.behindLive > 15)) return '采集页尚未接近直播前沿，请先点“准备 Track FX”。';
  return null;
}
