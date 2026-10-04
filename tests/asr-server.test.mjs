import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { createTranslator } from '../lib/translator.mjs';
import { AsrError } from '../lib/qwen-asr.mjs';

async function service(t, asr) {
  const server = createServer({ translator: createTranslator({mode:'mock'}), asr });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base+'/api/session', {headers:{'Sec-Fetch-Site':'same-origin'}})).json();
  const options = {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.token}`},body:JSON.stringify({audioBase64:'AAA=',sampleRate:16000,start:2040})};
  return {base,options};
}

test('ASR authenticates before work, returns timed sentences and sanitizes unexpected errors', async t => {
  let calls=0;
  const {base,options}=await service(t,{transcribe:async input=>{
    calls++;
    if(calls>1) throw Error('credential-and-signed-url-must-stay-private');
    assert.equal(input.start,2040);
    return {cues:[{text:'Box now.',start:2041,end:2042}],usage:{input_tokens:5}};
  }});
  assert.equal((await fetch(base+'/api/health')).status,200);
  assert.equal((await fetch(base+'/api/asr',{...options,headers:{'Content-Type':'application/json'}})).status,401);
  assert.equal((await fetch(base+'/api/asr',{...options,headers:{...options.headers,Origin:'https://unrelated.example'}})).status,401);
  assert.equal(calls,0);
  const response=await fetch(base+'/api/asr',options);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{cues:[{text:'Box now.',start:2041,end:2042}],usage:{input_tokens:5}});
  const failed=await fetch(base+'/api/asr',options);
  assert.equal(failed.status,500);
  assert.deepEqual(await failed.json(),{error:{code:'INTERNAL_ERROR'}});
});

test('one ASR job cannot block caption translation; cancelling releases its slot', async t => {
  let entered, cancelled;
  const started=new Promise(resolve=>{entered=resolve;});
  const stopped=new Promise(resolve=>{cancelled=resolve;});
  const {base,options}=await service(t,{transcribe:async (_input,{signal})=>{
    entered();
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{
      cancelled(); reject(new AsrError('CANCELLED',499));
    },{once:true}));
  }});
  const abort=new AbortController();
  const first=fetch(base+'/api/asr',{...options,signal:abort.signal}).catch(error=>error.name);
  await started;
  const busy=await fetch(base+'/api/asr',options);
  assert.equal(busy.status,429);
  assert.deepEqual(await busy.json(),{error:{code:'ASR_BUSY'}});
  const caption=await fetch(base+'/api/translate',{...options,body:JSON.stringify({cue:{id:'caption',text:'Box, box.',start:10,end:12},mockDelayMs:0})});
  assert.equal(caption.status,200);
  abort.abort();
  assert.equal(await first,'AbortError');
  await stopped;
});

test('optional ASR configuration does not disable caption-only service', async t => {
  const {base,options}=await service(t,null);
  assert.equal((await (await fetch(base+'/api/health')).json()).asr,false);
  const response=await fetch(base+'/api/asr',options);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:{code:'ASR_NOT_CONFIGURED'}});
});

test('NDJSON exposes a final cue before upstream completion, then ends with the compatible result', {timeout:3000}, async t => {
  const cue={text:'Box now.',start:2041,end:2042};
  let finishTask;
  const upstreamDone=new Promise(resolve=>{finishTask=resolve;});
  t.after(()=>finishTask());
  let completed=false;
  const {base,options}=await service(t,{transcribe:async (_input,{onCue})=>{
    onCue(cue);
    await upstreamDone; completed=true;
    return {cues:[cue],usage:{input_tokens:5}};
  }});
  const response=await fetch(base+'/api/asr',{...options,headers:{...options.headers,Accept:'application/x-ndjson'}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/^application\/x-ndjson/);
  const reader=response.body.getReader();
  const first=await reader.read();
  assert.equal(completed,false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value)),{type:'cue',cue});
  finishTask();
  let tail='';
  for(;;){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}
  assert.deepEqual(JSON.parse(tail),{type:'done',cues:[cue],usage:{input_tokens:5}});
});

test('an NDJSON failure after a cue stays parseable and contains only a safe error code', async t => {
  const cue={text:'Box now.',start:2041,end:2042};
  const {base,options}=await service(t,{transcribe:async (_input,{onCue})=>{
    onCue(cue); throw Error('upstream-private-credential');
  }});
  const response=await fetch(base+'/api/asr',{...options,headers:{...options.headers,Accept:'application/x-ndjson'}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.text()).trim().split('\n').map(line=>JSON.parse(line)),[
    {type:'cue',cue},{type:'error',code:'INTERNAL_ERROR'},
  ]);
});

test('disconnecting an NDJSON reader cancels the upstream request', {timeout:3000}, async t => {
  let cancelled;
  const stopped=new Promise(resolve=>{cancelled=resolve;});
  const {base,options}=await service(t,{transcribe:async (_input,{onCue,signal})=>{
    onCue({text:'Box now.',start:2041,end:2042});
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{
      cancelled(); reject(new AsrError('CANCELLED',499));
    },{once:true}));
  }});
  const response=await fetch(base+'/api/asr',{...options,headers:{...options.headers,Accept:'application/x-ndjson'}});
  const reader=response.body.getReader();
  await reader.read(); await reader.cancel(); await stopped;
});

test('NDJSON backpressure has a bounded queue and oversized lines stop the upstream safely', async t => {
  for(const flood of [false,true]){
    let signal;
    const {base,options}=await service(t,{transcribe:async (_input,options)=>{
      signal=options.signal;
      options.onCue({text:'First.',start:2041,end:2042});
      if(flood){
        for(let i=0;i<1000;i++) options.onCue({text:'x'.repeat(3000),start:2041,end:2042});
      }else options.onCue({text:'x'.repeat(600000),start:2041,end:2042});
      return {cues:[],usage:{}};
    }});
    const response=await fetch(base+'/api/asr',{...options,headers:{...options.headers,Accept:'application/x-ndjson'}});
    const body=await response.text();
    assert.ok(Buffer.byteLength(body)<1024*1024);
    const lines=body.trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(lines.at(-1),{type:'error',code:'ASR_OUTPUT_LIMIT'});
    assert.equal(signal.aborted,true);
  }
});
