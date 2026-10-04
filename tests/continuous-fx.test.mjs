import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackFxContinuousSource } from '../src/track-fx-source.js';

const continuousManifest = () => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n'+Array.from({length:20},(_,i)=>`#EXTINF:6,\n${i}.m4s\n`).join('')+'#EXT-X-ENDLIST\n';
const continuousDrmManifest = () => continuousManifest().replace('#EXT-X-MAP',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="https://license.example/never-read"\n#EXT-X-MAP');

function setup({ streams, fetchText, fetchBytes } = {}) {
  const clock = {eventType:'vod',currentPosition:35000,contentDuration:120000};
  const track = {name:'Track FX',streams: streams || [{url:'https://f1tv.formula1.com/fx/audio.m3u8'}]};
  const view = {currentContentTime:clock,associatedPlayer:{currentAudioTrack:{parentContentItem:{feeds:[{audioTracks:[track]}]}}}};
  const sessions=[], received=[], chunks=[], statuses=[];
  const client={async open(options){
    let resolve,reject;
    const s={options,cancelled:false,finished:false,done:new Promise((a,b)=>{resolve=a;reject=b;}),
      async append(chunk){chunks.push(chunk);},
      async finish(){s.finished=true;resolve({cues:[]});return s.done;},
      cancel(){s.cancelled=true;reject(Object.assign(Error('CANCELLED'),{code:'CANCELLED'}));}
    };
    sessions.push(s);return s;
  }};
  const source=new TrackFxContinuousSource(view,{client,aheadSeconds:12,isPaused:()=>true,
    fetchText: fetchText || (async()=> continuousManifest()),
    fetchBytes: fetchBytes || (async()=>new ArrayBuffer(4)),encodeAudio:async()=> 'AAAA',
    onStatus: status => statuses.push(status)
  });
  source.stopped=false;source.onCues=cues=>received.push(...cues);
  return {source,clock,track,sessions,received,chunks,statuses};
}

test('continuous recognition shares candidate fallback, DRM checks and programme isolation', async () => {
  const drmUrl = 'https://f1tv.formula1.com/protected/audio.m3u8';
  const clearUrl = 'https://f1tv.formula1.com/clear/audio.m3u8';
  const manifests = [], binaries = [];
  const s = setup({ streams: [{ url: drmUrl }],
    fetchText: async url => { manifests.push(url); return url === drmUrl ? continuousDrmManifest() : continuousManifest(); },
    fetchBytes: async url => { binaries.push(url); return new ArrayBuffer(4); }
  });
  try {
    await s.source.poll(); await s.source.poll();
    assert.equal(manifests.length, 1); assert.equal(binaries.length, 0); assert.equal(s.sessions.length, 0);
    assert.equal(s.statuses.at(-1).errorCode, 'FX_DRM');
    assert.match(s.statuses.at(-1).message, /5 分钟检查/); assert.doesNotMatch(s.statuses.at(-1).message, /重试/);
    s.track.streams.push({ url: clearUrl });
    await s.source.poll();
    assert.deepEqual(manifests, [drmUrl, drmUrl, clearUrl]);
    assert.equal(s.sessions.length, 1); assert.equal(s.source.url, clearUrl);
    assert.ok(binaries.every(url => url.startsWith('https://f1tv.formula1.com/clear/')));
    const previous = s.sessions[0];
    previous.options.onCue({ text: 'Old race.', zh: '上一场。', start: 34, end: 37 });
    assert.equal(s.received.length, 1);
    s.track.streams = [{ url: 'https://f1tv.formula1.com/next-race/audio.m3u8' }];
    await s.source.poll();
    assert.equal(previous.cancelled, true); assert.equal(s.sessions.length, 2);
    assert.equal(s.source.cues.length, 0); assert.equal(s.source.completed.size, 0);
    previous.options.onCue({ text: 'Late old race.', zh: '迟到的上一场。', start: 34, end: 37 });
    assert.equal(s.received.length, 1);
  } finally { s.source.stop(); }
});

test('continuous chunks retain one session, deliver finalized Chinese early, and pause stops at finite horizon',async()=>{
  const s=setup();
  try {
    await s.source.poll();await s.source.poll();
    assert.equal(s.sessions.length,1);
    assert.deepEqual(s.chunks.map(c=>c.start),[32,38]);
    s.sessions[0].options.onCue({id:'answer',text:'We can improve on the next lap.',zh:'下一圈还能再提升。',start:34,end:41,speaker:2});
    assert.equal(s.received.length,1);assert.equal(s.received[0].zh,'下一圈还能再提升。');
    assert.equal(s.sessions[0].finished,false);
    await s.source.poll();await s.source.poll();
    assert.equal(s.sessions[0].finished,true);assert.equal(s.chunks.length,2);
    assert.equal(s.source.coversTime(35),true);
    s.source.reset({keepCache:true});await s.source.poll();
    assert.equal(s.chunks.length,2);assert.equal(s.received.length,2);
    assert.equal(s.received[0].id,s.received[1].id);
  } finally {s.source.stop();}
});

test('seek and stop cancel the stream; late prior-speaker cues cannot enter the new time range',async()=>{
  const s=setup();
  try {
    await s.source.poll();const old=s.sessions[0];
    s.clock.currentPosition=70000;await s.source.poll();
    assert.equal(old.cancelled,true);assert.equal(s.sessions.length,2);
    old.options.onCue({text:'Old interview question',zh:'旧问题',start:33,end:37});
    assert.equal(s.received.length,0);assert.equal(s.chunks[1].start,67);
    const next=s.sessions[1];s.source.stop();
    next.options.onCue({text:'New but stopped answer',zh:'已停止的回答',start:68,end:72});
    assert.equal(next.cancelled,true);assert.equal(s.received.length,0);
  } finally {s.source.stop();}
});
