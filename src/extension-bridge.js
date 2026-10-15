const extensionPageOrigin = 'https://f1tv.formula1.com';
// Tampermonkey's granted window is a sandbox wrapper. MessageEvent.source is
// the page WindowProxy, so comparing it only with that wrapper drops valid
// extension messages (including both the handshake and snapshot requests).
const extensionPageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
export function postExtensionMessage(message) {
  extensionPageWindow.postMessage({ f1zhPage: 1, ...message }, extensionPageOrigin);
}
export function listenExtensionMessages(receive) {
  const listener = event => {
    if ((event.source === extensionPageWindow || event.source === window)
        && event.origin === extensionPageOrigin && event.data?.f1zhExtension === 1) receive(event.data);
  };
  extensionPageWindow.addEventListener('message', listener);
  return () => extensionPageWindow.removeEventListener('message', listener);
}
export function extensionSnapshotFailure(collector) {
  // The script did respond: do not let an SDK read failure masquerade as an
  // absent/outdated script. Never expose SDK exceptions or media URLs.
  return { protocol: 1, collector, pageLabel: collector ? '采集页' : '观看页', problem: null,
    startProblem: '网页已连接，但未能读取官网播放器状态。请等待播放器加载完成后重试。' };
}
export function createExtensionRelayChannel(programmeId) {
  const channel = { onmessage: null, postMessage(packet) { postExtensionMessage({ type: 'relay', packet }); }, close: null };
  channel.close = listenExtensionMessages(message => {
    if (message.type === 'relay' && message.packet?.programmeId === programmeId) channel.onmessage?.({ data: message.packet });
  });
  return channel;
}
