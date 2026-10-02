import test from 'node:test';
import assert from 'node:assert/strict';
import { CueStore, TranslationQueue, SubtitleTimeline, sameSpeech } from '../src/core.js';
import { SimulatedSource, TextTrackSource, MappedCueSource } from '../src/sources.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const cue = (id = 'a', start = 10, end = 15) => ({id,start,end,text:`English ${id}`});

test('early translation is cached, appears only at media time, pause and replay preserve sync', async () => {
  const store = new CueStore(); const queue = new TranslationQueue(store, async () => '整句中文');
  const timeline = new SubtitleTimeline(store); timeline.setEnabled(true);
  queue.ingest(cue()); await tick();
  assert.equal(store.cues.get('a').status, 'ready');
  assert.equal(timeline.render(9.999).text, '');
  assert.equal(timeline.render(10).text, '整句中文');
  assert.equal(timeline.render(10).text, '整句中文');
  assert.equal(timeline.render(15).text, '');
  timeline.seek(); assert.equal(timeline.render(12).text, '整句中文');
  timeline.setEnabled(false); assert.equal(timeline.render(12).text, '');
  queue.dispose();
});

test('late and out-of-order responses cannot change current sentence or leave stale text', async () => {
  const store = new CueStore(); const resolves = {};
  const queue = new TranslationQueue(store, c => new Promise(resolve => { resolves[c.id] = resolve; }));
  const timeline = new SubtitleTimeline(store); timeline.setEnabled(true);
  queue.ingestMany([cue('a',10,15),cue('b',16,20)]); await tick();
  assert.equal(timeline.render(10).text, 'English a');
  resolves.b('第二句'); resolves.a('第一句'); await tick();
  assert.equal(timeline.render(11).text, 'English a');
  assert.equal(timeline.render(15).text, '');
  assert.equal(timeline.render(16).text, '第二句');
  timeline.seek(); assert.equal(timeline.render(11).text, '第一句');
  queue.dispose();
});

test('failed/timeout translation frees queue; fallback expires and never pauses playback', async () => {
  const store = new CueStore();
  const queue = new TranslationQueue(store, c => c.id === 'a' ? new Promise(()=>{}) : Promise.resolve('第二句'), {concurrency:1, timeoutMs:15});
  const timeline = new SubtitleTimeline(store); timeline.setEnabled(true);
  queue.ingestMany([cue('a'), cue('b', 16, 20)]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(store.cues.get('a').status, 'failed');
  assert.equal(timeline.render(12).text, 'English a');
  assert.equal(timeline.render(15).text, '');
  assert.equal(timeline.render(16).text, '第二句');
  queue.dispose();
});

test('deduplicates, passes neighboring context, resets without leaking responses between videos', async () => {
  const store = new CueStore(); const pending = []; const contexts = [];
  const queue = new TranslationQueue(store, (c, context) => { contexts.push(context); return new Promise(resolve=>pending.push(resolve)); });
  queue.ingestMany([cue('a'),cue('a'),cue('b',16,20)]); await tick();
  assert.equal(pending.length,2); assert.equal(contexts[0][0].text,'English b');
  queue.reset(); queue.ingest(cue('a')); await tick();
  pending[0]('旧视频'); pending[1]('旧视频'); await tick();
  assert.equal(store.cues.get('a').zh, null);
  pending[2]('新视频'); await tick(); assert.equal(store.cues.get('a').zh,'新视频');
  assert.equal(store.add({id:'bad',start:20,end:10,text:'x'}),null);
  queue.dispose();
});

test('source acquisition advances independently while media is paused or rewound', () => {
  let wall = 100; const received = [];
  const source = new SimulatedSource([cue('a',20,25),cue('b',40,45)], {now:()=>wall,leadSeconds:30});
  source.start(batch => received.push(...batch));
  assert.deepEqual(received.map(c=>c.id),['a']);
  wall += 20; source.poll();
  assert.equal(source.head,50); assert.deepEqual(received.map(c=>c.id),['a','b']);
  source.stop();
});

test('native adapter scans future cues and restores prior mode; no track leaves page untouched', () => {
  const track = {kind:'subtitles',language:'en',label:'English',mode:'showing', cues:[{startTime:40,endTime:45,text:'Future'}]};
  const video = {currentTime:10,textTracks:[track]}; const received=[]; let status;
  const source = new TextTrackSource(video,{onStatus:s=>status=s});
  source.start(batch=>received.push(...batch));
  assert.equal(received[0].start,40); assert.equal(track.mode,'hidden'); assert.equal(status.ahead,35);
  source.poll(); assert.equal(received.length,1);
  source.stop(); assert.equal(track.mode,'showing');
  const missing = new TextTrackSource({currentTime:0,textTracks:[]},{onStatus:s=>status=s});
  missing.start(()=>assert.fail()); assert.equal(status.available,false); missing.stop();
});

test('mapping adapter refuses unknown timeline, overlapping cues finish independently', () => {
  const source = new MappedCueSource(()=>NaN);
  assert.throws(()=>source.push([cue()],{epoch:'p2'}),/mapping/);
  const store=new CueStore(); store.add(cue('a',0,5)); store.add(cue('b',3,7));
  const timeline=new SubtitleTimeline(store); timeline.setEnabled(true);
  assert.equal(timeline.render(4).text,'English a\nEnglish b');
  assert.equal(timeline.render(5).text,'English b'); assert.equal(timeline.render(7).text,'');
});

test('replaced English track resets cache so old channel cannot leak into new subtitles', () => {
  const oldTrack = {kind:'subtitles',language:'en',mode:'showing',cues:[{startTime:1,endTime:8,text:'Old'}]};
  const newTrack = {kind:'subtitles',language:'en',mode:'disabled',cues:[{startTime:1,endTime:8,text:'New'}]};
  const video = {currentTime:3,textTracks:[oldTrack]};
  const store = new CueStore(); const timeline = new SubtitleTimeline(store); timeline.setEnabled(true);
  const source = new TextTrackSource(video,{onReset:()=>{store.clear();timeline.seek();}});
  source.start(batch=>batch.forEach(c=>store.add(c)));
  assert.equal(timeline.render(3).text,'Old');
  video.textTracks=[newTrack]; source.poll();
  assert.equal(oldTrack.mode,'showing'); assert.equal(timeline.render(3).text,'New');
  source.stop(); assert.equal(newTrack.mode,'disabled');
});

test('fragment waits for following speech, sends directional context once and retains original timing', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let clock = 0; const calls = [];
  const store = new CueStore();
  const queue = new TranslationQueue(store, async (c,context) => {
    calls.push({id:c.id,context}); return c.id === 'a' ? '他现在需要的是' : '顺畅出弯。';
  }, {getTime:()=>0,now:()=>clock});
  t.after(()=>queue.dispose());
  queue.ingest({id:'a',start:30,end:33,text:'What he needs now'}); await tick();
  assert.equal(calls.length,0);
  clock = 1000; t.mock.timers.tick(1000);
  queue.ingest({id:'b',start:33,end:36,text:'is a clean exit.'}); await tick();
  assert.deepEqual(calls.map(c=>c.id),['a','b']);
  assert.deepEqual(calls[0].context,[{text:'is a clean exit.',start:33,end:36,position:'after'}]);
  assert.equal(calls[1].context[0].position,'before');
  const timeline = new SubtitleTimeline(store); timeline.setEnabled(true);
  assert.equal(timeline.render(29.9).text,'');
  assert.equal(timeline.render(30).text,'他现在需要的是');
  assert.equal(timeline.render(33).text,'顺畅出弯。');
  assert.equal(timeline.render(36).text,'');
  clock = 4000; t.mock.timers.tick(3000); await tick();
  assert.equal(calls.length,2); // No speculative retranslation after the timer.
});

test('bounded lookahead never blocks complete/urgent speech and releases an unfinished tail', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let clock = 0; const calls = [];
  const store = new CueStore();
  const queue = new TranslationQueue(store, async c => { calls.push(c.id); return '译文'; },
    {getTime:()=>0,now:()=>clock,concurrency:1});
  t.after(()=>queue.dispose());
  queue.ingestMany([
    {id:'tail',start:30,end:33,text:'If he can'},
    {id:'complete',start:60,end:63,text:'Box, box!'},
    {id:'urgent',start:5,end:8,text:'And on the outside'},
  ]); await tick(); await tick();
  assert.deepEqual(calls,['complete','urgent']);
  clock = 2999; t.mock.timers.tick(2999); await tick();
  assert.equal(store.cues.get('tail').status,'queued');
  clock = 3000; t.mock.timers.tick(1); await tick();
  assert.deepEqual(calls,['complete','urgent','tail']);
});

test('waiting consumes only spare lead and reset/dispose cancel pending context timers', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let clock = 0; let calls = 0;
  const queue = new TranslationQueue(new CueStore(), async () => { calls++; return '译文'; }, {getTime:()=>clock / 1000,now:()=>clock});
  t.after(()=>queue.dispose());
  queue.ingest({id:'near',start:11,end:13,text:'And ahead of him'});
  clock = 1000; t.mock.timers.tick(1000); await tick();
  assert.equal(calls,1); // Only one second of the three-second window was affordable.
  queue.ingest({id:'reset',start:30,end:33,text:'What he needs'});
  queue.reset(); clock = 4000; t.mock.timers.tick(3000); await tick();
  assert.equal(calls,1);
  queue.ingest({id:'dispose',start:40,end:43,text:'What he needs'});
  queue.dispose(); clock = 7000; t.mock.timers.tick(3000); await tick();
  assert.equal(calls,1);
});

test('context stays local across gaps, and two following fragments are enough to stop waiting', async t => {
  const store = new CueStore(); const calls = [];
  const queue = new TranslationQueue(store, async c => {calls.push(c.id); return '译文';}, {getTime:()=>0});
  t.after(()=>queue.dispose());
  queue.ingestMany([
    {id:'unrelated',start:10,end:15,text:'An unrelated interview.'},
    {id:'a',start:30,end:32,text:'The driver who'},
    {id:'b',start:32,end:34,text:'stopped first'},
    {id:'c',start:34,end:36,text:'is now ahead'},
  ]); await tick();
  assert.ok(calls.includes('a'));
  assert.ok(!calls.includes('b'));
  assert.deepEqual(store.context(store.cues.get('a')).map(c=>[c.text,c.position]),[['stopped first','after'],['is now ahead','after']]);
});

test('direct Chinese captions remain ready with speaker metadata and never enter text translation', async () => {
  const store = new CueStore(), calls = [];
  const queue = new TranslationQueue(store, async c => { calls.push(c.id); return '后续翻译'; });
  const added = queue.ingestMany([
    { ...cue('direct'), zh: '  这一圈非常顺利。  ', speaker: 2 },
    { ...cue('english', 16, 20), zh: 'English is not a Chinese translation' },
    { ...cue('empty', 21, 22), zh: '  ' },
    { ...cue('oversized', 23, 24), zh: '中'.repeat(4001), speaker: -1 },
  ]);
  assert.equal(added[0].status, 'ready');
  assert.equal(added[0].zh, '这一圈非常顺利。');
  assert.equal(added[0].speaker, 2);
  assert.equal(added[3].speaker, undefined);
  await tick(); await tick();
  assert.deepEqual(calls, ['english', 'empty', 'oversized']);
  assert.equal(store.cues.get('direct').zh, '这一圈非常顺利。');
  queue.dispose();
});

test('exclusive timeline displays only the latest active question or answer', () => {
  const store = new CueStore();
  store.add({ id: 'question', start: 0, end: 6, text: 'How was the lap?', zh: '这一圈怎么样？' });
  store.add({ id: 'answer', start: 4, end: 9, text: 'It was very good.', zh: '非常好。' });
  const timeline = new SubtitleTimeline(store, { exclusive: true });
  timeline.setEnabled(true);
  assert.equal(timeline.render(3).text, '这一圈怎么样？');
  assert.equal(timeline.render(4).text, '非常好。');
  assert.equal(timeline.render(5).lines.length, 1);
  assert.equal(timeline.render(9).text, '');
});

test('suppression is frozen for the current visit, reevaluated on replay and never exposes an older overlap', () => {
  const store = new CueStore();
  store.add(cue('old', 0, 8)); store.add(cue('new', 4, 9));
  let suppressNew = true, calls = 0;
  const timeline = new SubtitleTimeline(store, { exclusive: true, suppress: c => { calls++; return c.id === 'new' && suppressNew; } });
  timeline.setEnabled(true);
  assert.equal(timeline.render(3).text, 'English old');
  assert.deepEqual(timeline.render(4), { lines: [], text: '', hasEnglish: false });
  suppressNew = false;
  assert.equal(timeline.render(5).text, '');
  assert.equal(calls, 2);
  timeline.seek();
  assert.equal(timeline.render(5).text, 'English new');
  suppressNew = true;
  assert.equal(timeline.render(6).text, 'English new');
  assert.equal(calls, 3);
});

test('same speech requires overlapping times and enough ordered English words, not merely concurrent speech', () => {
  const speech = (text, start = 1, end = 5) => ({ text, start, end });
  assert.equal(sameSpeech(speech('Firstly, massive congrats to Pierre!'), speech('I mean firstly massive congratulations to Pierre, that was incredible.')), true);
  assert.equal(sameSpeech(speech('The lap was very good.'), speech('The lap was very good.', 5, 8)), false);
  assert.equal(sameSpeech(speech('Box, box now.'), speech('Box box now')), false);
  assert.equal(sameSpeech(speech('I need more front grip.'), speech('He is fastest in the first sector.')), false);
  assert.equal(sameSpeech(speech('one two three four five'), speech('five four three two one')), false);
  assert.equal(sameSpeech(speech('one two three four'), speech('one two three seven')), true);
  assert.equal(sameSpeech(speech('one two three four'), speech('one two six seven')), false);
  assert.equal(sameSpeech(speech('one two three four'), { text: 'one two three four', start: NaN, end: 8 }), false);
});
