import { CommentarySync } from './commentary-sync.js';
import { tiledContentSeconds } from '../../src/tiledmedia-source.js';
import { tiledLiveOriginSeconds } from '../../src/tiledmedia-live-source.js';

// Playback stays inside the official, licensed player. No audio capture, media
// URLs, credentials or subtitle text are sent through this channel.
export class CommentaryCompanion {
  constructor({ pageWindow, shadow, followerId = '', volume = .5, onVolume = () => {} }) {
    this.pageWindow = pageWindow; this.shadow = shadow; this.followerId = followerId;
    this.programmeId = this.programme(); this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : .5;
    this.onVolume = onVolume; this.enabled = false; this.offset = 0;
    this.audioReady = false; this.disposed = false; this.trackBusy = false;
    this.element = document.createElement('div');
    this.element.id = 'commentary-companion';
    this.element.innerHTML = followerId
      ? '<button id="commentary-resume" type="button">恢复同步播放</button><p id="commentary-status" role="status">请先在官网选择 WATCH LIVE；随后自动切换英语解说并对齐主页面。</p><small>本页只播放英语解说，不采集声音、不翻译字幕。主画面和音量由观看页控制。</small>'
      : '<button id="commentary-toggle" type="button" aria-pressed="false">开启英语解说</button><label class="opacity">解说音量<input id="commentary-volume" aria-label="解说音量" type="range" min="0" max="100" step="5"><output id="commentary-volume-value"></output></label><p id="commentary-status" role="status">保留 Track FX 原声，可另开同步英语解说。</p><details><summary>解说同步微调</summary><label class="opacity">声音提前<input id="commentary-offset" aria-label="解说声音提前秒数" type="range" min="-5" max="5" step="0.1" value="0"><output id="commentary-offset-value">0.0秒</output></label><button id="commentary-focus" type="button">显示解说页</button><small>正值让解说提前，负值让解说延后；默认按同一节目时间同步。</small></details>';
    shadow.querySelector('style').textContent += '#commentary-companion{margin:10px 0 6px;padding-top:10px;border-top:1px solid #456079}#commentary-toggle,#commentary-resume{width:100%}#commentary-toggle[aria-pressed=true]{background:#294b60;border-color:#83bcd5}#commentary-status{color:#b9cbd9;font-size:11px}#commentary-companion small{display:block;margin-top:6px}';
    shadow.getElementById('subtitle-style').before(this.element);
    this.statusElement = shadow.getElementById('commentary-status');
    if (followerId) {
      shadow.getElementById('commentary-resume').addEventListener('click', () => {
        // Let the synchronizer serialize seek and play; concurrent SDK calls
        // can otherwise pause the stream immediately after it was resumed.
        void this.sync?.resume(); void this.tick();
      });
      this.createSync('follower', followerId);
    } else {
      this.toggle = shadow.getElementById('commentary-toggle');
      this.toggle.addEventListener('click', () => this.setEnabled(!this.enabled));
      const input = shadow.getElementById('commentary-volume');
      const output = shadow.getElementById('commentary-volume-value');
      input.value = String(Math.round(this.volume * 100)); output.value = `${input.value}%`;
      input.addEventListener('input', () => {
        this.volume = Number(input.value) / 100; output.value = `${input.value}%`;
        this.sync?.setSettings({ volume: this.volume });
      });
      input.addEventListener('change', () => this.onVolume(this.volume));
      const offset = shadow.getElementById('commentary-offset');
      offset.addEventListener('input', () => {
        this.offset = Number(offset.value);
        shadow.getElementById('commentary-offset-value').value = `${this.offset.toFixed(1)}秒`;
        this.sync?.setSettings({ offset: this.offset });
      });
      shadow.getElementById('commentary-focus').addEventListener('click', () => this.openFollower());
    }
  }
  programme() { return /^\/detail\/(\d+)(?:\/|$)/.exec(this.pageWindow.location.pathname)?.[1] || ''; }
  view() { return this.pageWindow.document.querySelector('tiledmedia-view'); }
  state() {
    const view = this.view(), clock = view?.currentContentTime, video = view?.querySelector('video');
    const origin = clock?.eventType === 'live' ? tiledLiveOriginSeconds(view) : clock?.eventType === 'vod' ? 0 : NaN;
    return { ready: this.programme() === this.programmeId && !!video && video.readyState >= 2 && !video.seeking && Number.isFinite(origin)
        && Number.isFinite(clock?.currentPosition) && (!this.followerId || this.audioReady),
      position: tiledContentSeconds(view) + origin, paused: video?.paused ?? true,
      rate: video?.playbackRate || 1, lower: clock?.seekLowerBound / 1000 + origin,
      upper: clock?.seekUpperBound / 1000 + origin };
  }
  createSync(role, pairId) {
    this.sync = new CommentarySync({ role, programmeId: this.programmeId, pairId,
      getState: () => this.state(),
      controls: role === 'leader' ? {} : {
        seek: async absolute => {
          const view = this.view(), player = view?.associatedPlayer;
          const origin = view.currentContentTime.eventType === 'live' ? tiledLiveOriginSeconds(view) : 0;
          if (!Number.isFinite(origin)) throw Error('CLOCK_UNAVAILABLE');
          const config = new this.pageWindow.Tiledmedia.TimingConfig();
          // Verified against the site's SDK: CONTENT_TIME=1, PRECISE=1, ms.
          config.timingType = 1; config.targetPositionStrategy = 1;
          config.target = Math.round((absolute - origin) * 1000);
          await player.seek(config);
        },
        play: () => this.view().associatedPlayer.unpause(),
        pause: () => this.view().associatedPlayer.pause(),
        setRate: value => this.view().associatedPlayer.changePlaybackRate(value),
        setVolume: value => this.view().associatedPlayer.setAudioGain(value),
        setMuted: value => this.view().associatedPlayer.setAudioIsMuted(value)
      },
      onStatus: state => {
        if (this.disposed) return;
        this.statusElement.textContent = role === 'follower' && !this.view()?.associatedPlayer
          ? '请先在官网点击 WATCH LIVE；随后自动选择英语解说并同步。'
          : state.message || '正在等待同步';
      }
    });
  }
  setEnabled(value) {
    if (this.followerId || this.disposed) return;
    if (value && !this.state().ready) { this.statusElement.textContent = '请先打开本场的官方播放器。'; return; }
    this.enabled = value;
    if (!this.sync && value) {
      this.pairId = this.pageWindow.crypto.randomUUID();
      this.createSync('leader', this.pairId);
    }
    this.sync?.setSettings({ enabled: value, volume: this.volume, offset: this.offset });
    this.toggle.textContent = value ? '关闭英语解说' : '开启英语解说';
    this.toggle.setAttribute('aria-pressed', String(value));
    if (value) this.openFollower();
    else this.statusElement.textContent = '英语解说已关闭，Track FX 主页面继续播放。';
  }
  openFollower() {
    if (!this.enabled) { this.statusElement.textContent = '先点击“开启英语解说”。'; return; }
    if (this.followerWindow && !this.followerWindow.closed) { this.followerWindow.focus(); return; }
    const url = new URL(this.pageWindow.location.href);
    url.searchParams.delete('f1zh-audio'); url.searchParams.set('f1zh-commentary', this.pairId);
    url.searchParams.set('action', 'play');
    this.followerWindow = this.pageWindow.open(url.href, `f1zh-commentary-${this.pairId}`);
    this.statusElement.textContent = this.followerWindow
      ? '解说页已打开；在该页点击 WATCH LIVE 后会自动同步。'
      : '浏览器拦住了新页面；请允许弹出窗口，再点“显示解说页”。';
  }
  async selectEnglish() {
    if (this.trackBusy || this.disposed || !this.followerId) return;
    const view = this.view(), player = view?.associatedPlayer;
    if (!player) return;
    this.trackBusy = true;
    try {
      if (player !== this.lastPlayer) {
        this.lastPlayer = player; this.audioReady = false;
        this.sync?.resetOutput();
        await player.setAudioIsMuted(true);
      }
      const stream = await player.currentAudioTrack, track = await stream?.parentAudioTrack;
      if (await track?.name === 'English F1 Live') { this.audioReady = true; return; }
      this.audioReady = false;
      await player.setAudioIsMuted(true);
      const content = await stream?.parentContentItem || await track?.parentContentItem;
      for (const feedValue of await content?.feeds || []) {
        const feed = await feedValue;
        for (const candidateValue of await feed.audioTracks || []) {
          const candidate = await candidateValue;
          if (await candidate.name !== 'English F1 Live') continue;
          if (this.disposed) return;
          player.desiredAudioTrackSelection = new this.pageWindow.Tiledmedia.AudioTrackSelection(false, candidate);
          await player.applyDesiredState(this.pageWindow.Tiledmedia.DesiredStateConfig.maintainPosition());
          this.statusElement.textContent = '已选择 English F1 Live，正在对齐主页面。';
          return;
        }
      }
      this.statusElement.textContent = '本节目没有 English F1 Live 音轨，暂不出声。';
    } catch { this.audioReady = false; this.statusElement.textContent = '等待官方播放器音轨就绪。'; }
    finally { this.trackBusy = false; }
  }
  async tick() {
    if (this.disposed) return;
    if (this.programme() !== this.programmeId) {
      if (this.followerId) { this.statusElement.textContent = '节目已切换，请从观看页重新打开解说。'; this.dispose(); return; }
      this.setEnabled(false); this.sync?.close(); this.sync = null;
      this.programmeId = this.programme(); this.followerWindow = null; this.offset = 0;
      this.shadow.getElementById('commentary-offset').value = '0';
      this.shadow.getElementById('commentary-offset-value').value = '0.0秒';
      this.statusElement.textContent = '已切换节目；可重新开启本场英语解说。';
    }
    if (this.followerId) await this.selectEnglish();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sync?.close();
    if (this.followerId) this.view()?.associatedPlayer?.setAudioIsMuted(true).catch(() => {});
  }
}
