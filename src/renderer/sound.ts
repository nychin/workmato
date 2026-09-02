/**
 * 音效管理器
 */

const SOUND_BASE = './sound';

import type { SoundEvent, SoundSettings } from '../shared/settings';

const SOUND_MAP: Record<string, string> = {
  focus_start: 'focus_start.wav',
  prolongation: 'prolongation.mp3',
  rest_start: 'rest_start.mp3',
  rest_end: 'rest_end.mp3',
  happy: 'happy.mp3',
  rage: 'rage.mp3',
  focus_start_02: 'old/focus_start_02.mp3',
  focus_start_03: 'old/focus_start_03.mp3',
  prolongation_02: 'old/prolongation_02.mp3',
};

export class SoundManager {
  private cache = new Map<string, HTMLAudioElement>();
  private enabled = true;
  private volume = 0.6;
  private events: SoundSettings['events'] = {
    focusStart: 'focus_start', prolongation: 'prolongation', restStart: 'rest_start', restEnd: 'rest_end', taskComplete: 'happy',
  };

  preload(): void {
    for (const [key, file] of Object.entries(SOUND_MAP)) {
      const audio = new Audio(`${SOUND_BASE}/${file}`);
      audio.preload = 'auto';
      audio.volume = this.volume;
      audio.load();
      this.cache.set(key, audio);
    }
  }

  play(name: string): void {
    if (!this.enabled) return;
    const audio = this.cache.get(name);
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  applySettings(settings: SoundSettings): void {
    this.enabled = settings.enabled;
    this.volume = settings.volume / 100;
    this.events = settings.events;
    for (const audio of this.cache.values()) audio.volume = this.volume;
    for (const asset of Object.values(this.events)) {
      if (asset?.startsWith('custom:')) void this.loadCustom(asset);
    }
  }

  playEvent(event: SoundEvent): void {
    const asset = this.events[event];
    if (!asset) return;
    if (asset.startsWith('custom:')) {
      void this.loadCustom(asset).then(() => this.play(asset));
      return;
    }
    this.play(asset);
  }

  private async loadCustom(asset: string): Promise<void> {
    if (this.cache.has(asset)) return;
    const url = await window.settingsAPI.getCustomSoundUrl(asset as SoundSettings['events'][SoundEvent]);
    if (!url) return;
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = this.volume;
    audio.load();
    this.cache.set(asset, audio);
  }
}
