import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsrRequester } from '../src/asr-client.js';

const payload = {audioBase64:'AAA=',sampleRate:16000,start:2060};
const cue = {text:'The rear axle is broken.',start:2074.16,end:2079.28};
const tick = () => new Promise(resolve => setImmediate(resolve));
const line = item => JSON.stringify(item)+'\n';

function setup(timeoutMs=500) {
  let options, aborts=0;
  const run=createAsrRequester(value=>{options=value; return {abort(){aborts++;}};},
    {service:'http://127.0.0.1:3847',getToken:()=> 'local-pairing-only',timeoutMs});
  return {run,options:()=>options,aborts:()=>aborts};
}

test('final sentences leave the stream before task completion; split chunks decode once', async () => {
  const s=setup(), seen=[]; let finished=false, controller;
  const result=s.run(payload,new AbortController().signal,c=>seen.push(c)).then(value=>{finished=true;return value;});
  const stream=new ReadableStream({start(c){controller=c;}});
  s.options().onloadstart({status:200,response:stream});
  const bytes=new TextEncoder().encode(line({type:'cue',cue}));
  controller.enqueue(bytes.slice(0,13)); await tick(); assert.equal(seen.length,0);
  controller.enqueue(bytes.slice(13)); await tick();
  assert.deepEqual(seen,[cue]); assert.equal(finished,false);
  controller.enqueue(new TextEncoder().encode(line({type:'done',cues:[cue],usage:{input_tokens:10}})));
  controller.close();
  assert.deepEqual(await result,{cues:[cue],usage:{input_tokens:10}});
  assert.equal(s.options().headers.Accept,'application/x-ndjson');
  assert.equal(s.options().headers.Authorization,'Bearer local-pairing-only');
  assert.equal(s.aborts(),0);
});

test('seek cancellation cancels the reader and transport and ignores late callbacks', async () => {
  const s=setup(), abort=new AbortController(), seen=[]; let cancelled=false;
  const result=s.run(payload,abort.signal,c=>seen.push(c));
  const check=assert.rejects(result,{code:'CANCELLED'});
  s.options().onloadstart({status:200,response:new ReadableStream({cancel(){cancelled=true;}})});
  abort.abort(); await check;
  s.options().onprogress({status:200,responseText:line({type:'cue',cue})});
  assert.equal(cancelled,true); assert.equal(s.aborts(),1); assert.equal(seen.length,0);
});

test('cumulative text progress stays incremental; old JSON responses remain compatible', async () => {
  const s=setup(), seen=[];
  const result=s.run(payload,new AbortController().signal,c=>seen.push(c));
  const first=line({type:'cue',cue});
  s.options().onprogress({status:200,responseText:first});
  s.options().onprogress({status:200,responseText:first});
  assert.deepEqual(seen,[cue]);
  s.options().onload({status:200,responseText:first+line({type:'done',cues:[cue]})});
  assert.deepEqual((await result).cues,[cue]);
  const legacy=s.run(payload,new AbortController().signal);
  s.options().onload({status:200,responseText:JSON.stringify({cues:[cue]})});
  assert.deepEqual((await legacy).cues,[cue]);
});

test('cancelling inside a cue callback suppresses the rest of that network chunk', async () => {
  const s=setup(), abort=new AbortController(), seen=[];
  const result=s.run(payload,abort.signal,c=>{seen.push(c);abort.abort();});
  const check=assert.rejects(result,{code:'CANCELLED'});
  s.options().onprogress({status:200,responseText:line({type:'cue',cue})+line({type:'cue',cue:{...cue,start:2080,end:2082}})});
  await check; assert.deepEqual(seen,[cue]);
});

test('safe errors, malformed streams and independent timeout terminate without extra requests', async () => {
  for (const [body,code,status] of [
    [{error:{code:'ASR_NOT_CONFIGURED'}},'ASR_NOT_CONFIGURED',503],
    [{error:{code:'unknown'}},'UNAUTHORIZED',401],
    [{type:'error',code:'ASR_TIMEOUT'},'ASR_TIMEOUT',200],
    [{type:'cue',cue:{...cue,end:0}},'ASR_INVALID_RESPONSE',200]
  ]) {
    const s=setup(), promise=s.run(payload,new AbortController().signal);
    const check=assert.rejects(promise,{code});
    s.options().onload({status,responseText:line(body)}); await check;
  }
  const s=setup(15);
  await assert.rejects(s.run(payload,new AbortController().signal),{code:'ASR_CLIENT_TIMEOUT'});
  assert.equal(s.aborts(),1);
});

test('an empty done event completes even if the GM stream never closes', async () => {
  const s=setup(100), seen=[]; let controller, cancelled=false;
  const result=s.run(payload,new AbortController().signal,c=>seen.push(c));
  s.options().onloadstart({status:200,response:new ReadableStream({start(c){controller=c;},cancel(){cancelled=true;}})});
  controller.enqueue(new TextEncoder().encode(line({type:'done',cues:[],usage:{}})));
  assert.deepEqual(await result,{cues:[],usage:{}});
  assert.deepEqual(seen,[]); assert.equal(cancelled,true);
});

test('phase diagnostics survive upstream errors without accepting provider text', async () => {
  const s=setup(), result=s.run(payload,new AbortController().signal);
  const check=assert.rejects(result,error=>error.code==='ASR_FINISH_TIMEOUT'
    && error.diagnostics.stage==='recognizing' && error.diagnostics.sentAudioMs===30000
    && !JSON.stringify(error).includes('private'));
  s.options().onload({status:200,responseText:line({type:'progress',diagnostics:{stage:'sending',sentAudioMs:0}})
    +line({type:'error',code:'ASR_FINISH_TIMEOUT',diagnostics:{stage:'recognizing',elapsedMs:25000,sentAudioMs:30000,provider:'private'}})});
  await check;
});
