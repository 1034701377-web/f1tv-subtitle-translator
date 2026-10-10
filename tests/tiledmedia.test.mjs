import test from 'node:test';
import assert from 'node:assert/strict';
import { TiledMediaVodSource, tiledContentSeconds, OfficialCaptionVisibility } from '../src/tiledmedia-source.js';

const playlist = '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n1.vtt\n#EXTINF:6.000,\n2.vtt\n#EXT-X-ENDLIST\n';
const vtt = text => `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n1\n00:00:01.000 --> 00:00:04.000\n${text}\n\n2\n00:00:08.000 --> 00:00:10.000\nAhead\n`;
function setup() {
  const track = { language: Promise.resolve('eng') };
  const view = {currentContentTime:{eventType:'vod',currentPosition:2000,contentDuration:12000},associatedPlayer:{currentSubtitleTrack:{parentSubtitleTrack:Promise.resolve(track),url:Promise.resolve('https://subtitles.formula1.com/index.m3u8')}}};
  const received=[],status=[],requests=[];let resets=0;
  const source = new TiledMediaVodSource(view,{fetchText:async url=>{requests.push(url);return url.endsWith('m3u8')?playlist:vtt('Current');},getOfficialText:()=> 'Current',onStatus:s=>status.push(s),onReset:()=>resets++});
  source.onCues=cues=>received.push(...cues); source.stopped=false;
  return {view,source,received,status,requests,resets:()=>resets};
}
test('VOD source calibrates against official cue and uses content ms rather than MSE video time',async()=>{
  const s=setup(); assert.equal(tiledContentSeconds(s.view),2); await s.source.poll();
  assert.equal(s.source.validated,true); assert.equal(s.status.at(-1).ahead,8);
  assert.equal(s.received.length,2);assert.equal(s.received[1].start,8);
  await s.source.poll();assert.equal(s.requests.length,3);assert.equal(s.received.length,2);
  s.view.associatedPlayer.currentSubtitleTrack.url=Promise.resolve('https://subtitles.formula1.com/other.m3u8');
  await s.source.poll();assert.equal(s.resets(),2);s.source.stop();
});
test('unverified clock/caption match and live source do not emit usable cues',async()=>{
  const s=setup();s.source.getOfficialText=()=> 'Different';await s.source.poll();
  assert.equal(s.received.length,0);assert.equal(s.source.validated,false);
  s.view.currentContentTime.eventType='live';await s.source.poll();
  assert.equal(s.status.at(-1).available,false);assert.equal(s.received.length,0);s.source.stop();
});
test('delivered subtitle coverage includes cue gaps and ends on reset, lost calibration or stop',async()=>{
  const s=setup();
  s.source.onCues=cues=>{assert.equal(s.source.coversTime(6),false);s.received.push(...cues);};
  assert.equal(s.source.coversTime(6),false);await s.source.poll();
  assert.equal(s.received.some(c=>c.start<=6&&6<c.end),false);
  assert.equal(s.source.coversTime(6),true);
  assert.equal(s.source.coversTime(-1),false);assert.equal(s.source.coversTime(12),false);
  s.source.validated=false;assert.equal(s.source.coversTime(6),false);
  s.source.reset();assert.equal(s.source.coversTime(6),false);
  await s.source.poll();assert.equal(s.source.coversTime(6),true);
  s.source.stop();assert.equal(s.source.coversTime(6),false);
});
test('late source response after stop cannot append cues or hide official subtitles',async()=>{
  const s=setup();let resolve; s.source.fetchText=()=>new Promise(r=>resolve=r);
  const pending=s.source.poll();await new Promise(r=>setImmediate(r));s.source.stop();resolve(playlist);await pending;
  assert.equal(s.received.length,0);
  const styles = new Map([['visibility',['visible','']]]);
  const element={style:{getPropertyValue:k=>styles.get(k)?.[0]||'',getPropertyPriority:k=>styles.get(k)?.[1]||'',setProperty:(k,v,p)=>styles.set(k,[v,p]),removeProperty:k=>styles.delete(k)}};
  const visibility=new OfficialCaptionVisibility(()=>[element]);
  visibility.setHidden(true);assert.deepEqual(styles.get('visibility'),['hidden','important']);
  visibility.setHidden(false);assert.deepEqual(styles.get('visibility'),['visible','']);
});

function recentReplay(s) {
  const origin = 1791622558.08;
  Object.assign(s.view.currentContentTime, { isWallclockTimeSourceBased: true,
    seekLowerBound: 0, seekUpperBound: 12000, bufferLowerBound: 0, bufferUpperBound: 12000 });
  s.view.currentWallclockTime = { ...s.view.currentContentTime, currentPosition: origin * 1000 + 8000 };
  for (const key of ['seekLowerBound', 'seekUpperBound', 'bufferLowerBound', 'bufferUpperBound']) {
    s.view.currentWallclockTime[key] += origin * 1000;
  }
  const stamp = seconds => {
    const ms = Math.round(seconds * 1000);
    return `${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const absoluteVtt = () => vtt('Current').replace(/00:00:(\d+)\.000(?= -->|\n)/g, (_, second) => stamp(origin + Number(second)));
  s.source.fetchText = async url => url.endsWith('m3u8')
    ? playlist.replace('#EXTINF:', '#EXT-X-DISCONTINUITY-SEQUENCE:38\n#EXTINF:') : absoluteVtt();
}

test('recent VOD maps clear Unix captions with SDK bounds, not the wallclock playhead', async () => {
  const s = setup(); recentReplay(s);
  await s.source.poll();
  assert.equal(s.source.validated, true);
  assert.deepEqual(s.received.map(c => [c.start, c.end]), [[1, 4], [8, 10]]);
  assert.equal(s.source.coversTime(6), true);
  s.view.currentWallclockTime.seekUpperBound += 1000;
  await s.source.poll();
  assert.equal(s.source.validated, false);
  assert.equal(s.source.coversTime(6), false);
  assert.equal(s.received.length, 2);
  s.source.stop();
});

test('recent VOD refuses missing or inconsistent clock anchors and mismatched official text', async () => {
  for (const breakClock of [s => { delete s.view.currentWallclockTime; },
    s => { s.view.currentWallclockTime.bufferLowerBound += 1000; },
    s => { s.source.getOfficialText = () => 'Different'; }]) {
    const s = setup(); recentReplay(s); breakClock(s);
    await s.source.poll();
    assert.equal(s.received.length, 0);
    assert.equal(s.source.validated, false);
    s.source.stop();
  }
});

test('ordinary relative VOD captions remain relative even when SDK wallclock metadata exists', async () => {
  const s = setup(); recentReplay(s);
  s.source.fetchText = async url => url.endsWith('m3u8') ? playlist : vtt('Current');
  await s.source.poll();
  assert.equal(s.source.validated, true);
  assert.deepEqual(s.received.map(c => [c.start, c.end]), [[1, 4], [8, 10]]);
  s.source.stop();
});
