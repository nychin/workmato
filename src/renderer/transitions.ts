/**
 * 过渡动画编排器 —— P1（握手协议渲染侧）+ P4（四个状态过渡）
 *
 * 职责：
 * - 状态切换携带 transition 信息时，在新布局之上播放过渡 Timeline
 * - 播放完毕由调用方（main.ts）通知主进程起表（transition:done）
 * - 互斥防御：新过渡取消未播完的旧过渡，清理现场后再开播
 *
 * 协作时序（main.ts onTimerState 内）：
 *   1. capturePrevExpression()   —— 布局 apply 前捕获旧表情+旧背景层
 *   2. layoutRenderer.apply()    —— 新状态布局就位（由 main.ts 执行）
 *   3. breathing.stopAll()       —— 呼吸全停（文档规则，由 main.ts 执行）
 *   4. play(info)                —— 播过渡；结束后 main.ts 启动新状态呼吸 + 回调主进程
 */
import * as PIXI from 'pixi.js';
import { AssetStore, SUNLIGHT_KEYS } from './assets';
import {
  BOUNCE_ANCHOR,
  Playback,
  TargetRegistry,
  TimelineDef,
  TimelinePlayer,
  TrackDef,
  buildBounceTracks,
  pinAt,
  unpin,
} from './anim';
import { RecolorKit } from './recolor';
import { TransitionInfo } from './types';

const BOUNCE_MS = 360;
const CROSSFADE_DELAY_MS = 60;
const CROSSFADE_DURATION_MS = 60;
const TRANSITION_DURATION_MS = Math.max(BOUNCE_MS, CROSSFADE_DELAY_MS + CROSSFADE_DURATION_MS);
const BOUNCE_LAYERS = ['body', 'expr', 'digit', 'btn'] as const;

/** 延时→休息、休息→闲置的太阳缩放中心。 */
const SUN_BURST_CENTER = { x: 235, y: 345 };

export class TransitionController {
  private current: Playback | null = null;
  private prevExprSprites: PIXI.DisplayObject[] = [];
  private prevBgSprites: PIXI.DisplayObject[] = [];
  private pinned: PIXI.Container[] = [];
  private tempContainers: PIXI.Container[] = [];
  private cleanupCbs: Array<() => void> = [];

  constructor(
    private store: AssetStore,
    private groups: Map<string, PIXI.Container>,
    private targets: TargetRegistry,
    private player: TimelinePlayer,
    private recolor?: RecolorKit
  ) {}

  capturePrevExpression(): void {
    const exprCt = this.groups.get('expr');
    this.prevExprSprites = exprCt ? [...exprCt.children] : [];
    const bgCt = this.groups.get('bg');
    this.prevBgSprites = bgCt ? [...bgCt.children] : [];
  }

  async play(info: TransitionInfo): Promise<void> {
    this.current?.cancel();
    this.current = null;
    const builder = this.builders[info.id];
    if (!builder) {
      console.warn(`[transitions] 未注册的过渡: ${info.id}，直接完成`);
      this.cleanup();
      return;
    }
    try {
      const def = builder(info);
      if (!def) return;
      const playback = this.player.play(def);
      this.current = playback;
      await playback.finished;
    } finally {
      this.cleanup();
      this.current = null;
    }
  }

  // ── 过渡注册表 ──

  private get builders(): Record<string, (info: TransitionInfo) => TimelineDef | null> {
    return {
      idle_to_focus: () => this.buildSimple('idle_to_focus'),
      enter_rage: () => this.buildSimple('enter_rage'),
      focus_to_prolongation: () => this.buildFocusToProlongation(),
      prolongation_to_waitingRest: () => this.buildProlongationToWaitingRest(),
      rest_to_idle: () => this.buildRestToIdle(),
    };
  }

  // ── 简单过渡（idle→focus / enter_rage） ──

  private buildSimple(name: string): TimelineDef | null {
    const exprCt = this.groups.get('expr');
    if (!exprCt) return null;
    const tracks: TrackDef[] = [];
    this.addBounceCrossfade(tracks);
    return { name: `transition:${name}`, duration: TRANSITION_DURATION_MS, tracks };
  }

  // ── 公共编排件：弹动 + 表情交叉淡入淡出 ──

  private addBounceCrossfade(tracks: TrackDef[]): void {
    const exprCt = this.groups.get('expr');
    if (!exprCt) return;
    const bounceTargets: string[] = [];
    for (const n of BOUNCE_LAYERS) {
      const ct = this.groups.get(n);
      if (!ct) continue;
      pinAt(ct, BOUNCE_ANCHOR.x, BOUNCE_ANCHOR.y);
      this.pinned.push(ct);
      this.targets.register(`tr:${n}`, ct);
      bounceTargets.push(`tr:${n}`);
    }
    [...exprCt.children].forEach((s, i) => {
      s.alpha = 0;
      this.targets.register(`tr:eN${i}`, s);
      tracks.push({
        target: `tr:eN${i}`, property: 'alpha', delay: CROSSFADE_DELAY_MS,
        keys: [{ at: 0, value: 0, easing: 'easeInOutSine' }, { at: CROSSFADE_DURATION_MS, value: 1 }],
      });
    });
    this.prevExprSprites.forEach((s, i) => {
      exprCt.addChild(s);
      this.targets.register(`tr:eO${i}`, s);
      tracks.push({
        target: `tr:eO${i}`, property: 'alpha', delay: CROSSFADE_DELAY_MS,
        keys: [{ at: 0, value: 1, easing: 'easeInOutSine' }, { at: CROSSFADE_DURATION_MS, value: 0 }],
      });
    });
    tracks.push(...buildBounceTracks({ target: bounceTargets, duration: BOUNCE_MS }));
  }

  // ── P4 工具 ──

  /** 判断精灵是否为云朵（引用比对） */
  private isCloud(s: PIXI.DisplayObject): boolean {
    return s === this.store.sprites.get('bg_cloud_01') || s === this.store.sprites.get('bg_cloud_02');
  }

  /**
   * 把精灵移入临时容器（不改 pivot/position/scale），容器 pinAt 到缩放中心。
   * 容器 scale=1 时精灵视觉位置与原状态一致。
   */
  private moveToContainer(
    sprites: PIXI.DisplayObject[],
    parent: PIXI.Container,
    name: string,
    center: { x: number; y: number },
    insertBefore?: PIXI.DisplayObject
  ): PIXI.Container {
    const ct = new PIXI.Container();
    for (const s of sprites) ct.addChild(s);
    if (insertBefore && insertBefore.parent === parent) {
      parent.addChildAt(ct, parent.getChildIndex(insertBefore));
    } else {
      parent.addChild(ct);
    }
    this.tempContainers.push(ct);
    pinAt(ct, center.x, center.y);
    this.pinned.push(ct);
    this.targets.register(name, ct);
    return ct;
  }

  // ── P4: focus → prolongation ──
  // 太阳变色 3s + 缩小 3s（围绕现有锚点 238,242）；云朵延迟 1s 滑入

  private buildFocusToProlongation(): TimelineDef | null {
    const tracks: TrackDef[] = [];
    const FADE = 3000, CLOUD_DELAY = 1000;
    const sunKeys = [...SUNLIGHT_KEYS, 'bg_sun'];

    for (const key of sunKeys) {
      const orig = this.store.sprites.get(key);
      const twin = key === 'bg_sun' ? this.recolor?.sunTwin : this.recolor?.colorTwins.get(key);
      if (orig) {
        orig.scale.set(1);
        this.targets.register(`tr:so_${key}`, orig);
        tracks.push({
          target: `tr:so_${key}`, property: 'scale',
          keys: [{ at: 0, value: 1, easing: 'easeInOutQuad' }, { at: FADE, value: 0.85 }],
        });
      }
      if (twin) {
        twin.scale.set(1);
        twin.alpha = 0;
        this.targets.register(`tr:st_${key}`, twin);
        tracks.push(
          { target: `tr:st_${key}`, property: 'scale',
            keys: [{ at: 0, value: 1, easing: 'easeInOutQuad' }, { at: FADE, value: 0.85 }] },
          { target: `tr:st_${key}`, property: 'alpha',
            keys: [{ at: 0, value: 0, easing: 'easeInOutQuad' }, { at: FADE, value: 1 }] },
        );
      }
    }

    this.addCloudTracks(tracks, 'bg_cloud_01', -80, CLOUD_DELAY, FADE);
    this.addCloudTracks(tracks, 'bg_cloud_02', 60, CLOUD_DELAY, 2500);
    this.addBounceCrossfade(tracks);

    // 终态兜底（取消路径下确保正确）
    this.cleanupCbs.push(() => {
      for (const key of sunKeys) {
        const s = this.store.sprites.get(key);
        if (s) s.scale.set(0.85);
        const t = key === 'bg_sun' ? this.recolor?.sunTwin : this.recolor?.colorTwins.get(key);
        if (t) { t.scale.set(0.85); t.alpha = 1; }
      }
      const c1 = this.store.sprites.get('bg_cloud_01');
      if (c1) { c1.x = 0; c1.alpha = 1; }
      const c2 = this.store.sprites.get('bg_cloud_02');
      if (c2) { c2.x = 0; c2.alpha = 1; }
    });

    return { name: 'transition:focus_to_prolongation', duration: CLOUD_DELAY + FADE, tracks };
  }

  private addCloudTracks(tracks: TrackDef[], key: string, offsetX: number, delay: number, dur: number): void {
    const s = this.store.sprites.get(key);
    if (!s) return;
    s.x = offsetX;
    s.alpha = 0;
    this.targets.register(`tr:${key}`, s);
    tracks.push(
      { target: `tr:${key}`, property: 'x', delay,
        keys: [{ at: 0, value: offsetX, easing: 'easeOutQuad' }, { at: dur, value: 0 }] },
      { target: `tr:${key}`, property: 'alpha', delay,
        keys: [{ at: 0, value: 0, easing: 'easeOutQuad' }, { at: dur, value: 1 }] },
    );
  }

  // ── P4: prolongation → waitingRest ──
  // 太阳放大115%(0.3s)→缩小5%(0.2s)，缩放中心(235,345)；
  // 太阳与夜空淡入同时进行，太阳层级在夜空之上

  private buildProlongationToWaitingRest(): TimelineDef | null {
    const tracks: TrackDef[] = [];
    const GROW = 300, SHRINK = 200;
    const SUN_MS = GROW + SHRINK; // 500
    const NIGHT_MS = 1500;
    const bgCt = this.groups.get('bg')!;

    // apply(waitingRest) 已复位复用精灵；旧太阳退场期间恢复延时态的落日色与 85% 基准。
    for (const key of SUNLIGHT_KEYS) {
      const sprite = this.store.sprites.get(key);
      if (sprite && this.prevBgSprites.includes(sprite)) sprite.scale.set(0.85);
      const twin = this.recolor?.colorTwins.get(key);
      if (twin && this.prevBgSprites.includes(twin)) {
        const sunsetTexture = this.recolor?.sunsetTex.get(key);
        if (sunsetTexture) twin.texture = sunsetTexture;
        twin.scale.set(0.85);
        twin.alpha = 1;
      }
    }
    const sun = this.store.sprites.get('bg_sun');
    if (sun && this.prevBgSprites.includes(sun)) sun.scale.set(0.85);
    const sunTwin = this.recolor?.sunTwin;
    if (sunTwin && this.prevBgSprites.includes(sunTwin)) {
      const sunsetTexture = this.recolor?.sunsetTex.get('bg_sun');
      if (sunsetTexture) sunTwin.texture = sunsetTexture;
      sunTwin.scale.set(0.85);
      sunTwin.alpha = 1;
    }

    // 旧太阳容器（在夜空之上）：精灵保持原 pivot/position/scale(0.85)，容器 scale=1 起步
    const sunOnly = this.prevBgSprites.filter((s) => !this.isCloud(s));
    const oldSun = this.moveToContainer(sunOnly, bgCt, 'tr:oldSun', SUN_BURST_CENTER);
    oldSun.scale.set(1, 1);

    // 容器缩放（相对值：目标总缩放 / 精灵个体缩放0.85）
    tracks.push(
      { target: 'tr:oldSun', property: 'scale', keys: [
        { at: 0, value: 1, easing: 'easeOutQuad' },
        { at: GROW, value: 1.15 / 0.85, easing: 'easeInQuad' },
        { at: SUN_MS, value: 0.05 / 0.85 }] },
    );

    // 云朵随太阳淡出
    const cloudSprites = this.prevBgSprites.filter((s) => this.isCloud(s));
    cloudSprites.forEach((cs, i) => {
      bgCt.addChild(cs);
      this.targets.register(`tr:cOut${i}`, cs);
      tracks.push({ target: `tr:cOut${i}`, property: 'alpha',
        keys: [{ at: 0, value: 1 }, { at: SUN_MS, value: 0 }] });
    });

    // 夜空淡入（1.5s，与太阳动画同时开始）
    for (const nk of ['bg_night_sky', 'bg_night_moon']) {
      const s = this.store.sprites.get(nk);
      if (!s) continue;
      s.alpha = 0;
      this.targets.register(`tr:n_${nk}`, s);
      tracks.push({ target: `tr:n_${nk}`, property: 'alpha',
        keys: [{ at: 0, value: 0, easing: 'easeInOutQuad' }, { at: NIGHT_MS, value: 1 }] });
    }

    this.addBounceCrossfade(tracks);

    this.cleanupCbs.push(() => {
      for (const nk of ['bg_night_sky', 'bg_night_moon']) {
        const s = this.store.sprites.get(nk);
        if (s) s.alpha = 1;
      }
      for (const s of this.prevBgSprites) s.parent?.removeChild(s);
    });

    return { name: 'transition:prolongation_to_waitingRest', duration: Math.max(SUN_MS, NIGHT_MS), tracks };
  }

  // ── P4: rest → idle ──
  // 新太阳 5%→120%(0.3s)→95%(0.2s)→100%(0.1s)，缩放中心(235,345)；
  // 太阳与旧夜空淡出同时进行，太阳层级在夜空之上

  private buildRestToIdle(): TimelineDef | null {
    const tracks: TrackDef[] = [];
    const GROW = 1200;
    const SUN_MS = GROW; // 1200
    const NIGHT_MS = 1500;
    const bgCt = this.groups.get('bg')!;

    // 旧夜空容器（淡出，放在底层）
    const oldNight = new PIXI.Container();
    for (const s of this.prevBgSprites) oldNight.addChild(s);
    bgCt.addChild(oldNight);
    this.tempContainers.push(oldNight);
    this.targets.register('tr:oldNight', oldNight);
    tracks.push({ target: 'tr:oldNight', property: 'alpha',
      keys: [{ at: 0, value: 1, easing: 'easeInOutQuad' }, { at: NIGHT_MS, value: 0 }] });

    // 新太阳容器（在旧夜空之上）：精灵 scale=1，容器控制整体缩放
    const newSun = this.moveToContainer([...bgCt.children.filter(c => c !== oldNight)], bgCt, 'tr:newSun', SUN_BURST_CENTER);
    newSun.scale.set(0.05);
    tracks.push(
      { target: 'tr:newSun', property: 'scale', keys: [
        { at: 0, value: 0.05, easing: { bezier: [0.05, 1, 0.1, 1] } },
        { at: SUN_MS, value: 1 }] },
    );

    this.addBounceCrossfade(tracks);

    // 清理：太阳精灵移回 bg 组（呼吸动画需要在 bg 组内）
    this.cleanupCbs.push(() => {
      for (const s of [...newSun.children]) bgCt.addChild(s);
    });

    return { name: 'transition:rest_to_idle', duration: Math.max(SUN_MS, NIGHT_MS), tracks };
  }

  // ── 现场清理 ──

  private cleanup(): void {
    this.pinned.forEach(unpin);
    this.pinned = [];
    for (const cb of this.cleanupCbs) cb();
    this.cleanupCbs = [];
    for (const tc of this.tempContainers) tc.parent?.removeChild(tc);
    this.tempContainers = [];
    for (const s of this.prevExprSprites) {
      s.parent?.removeChild(s);
      s.alpha = 1;
    }
    this.prevExprSprites = [];
    this.prevBgSprites = [];
    const exprCt = this.groups.get('expr');
    exprCt?.children.forEach((c) => { c.alpha = 1; });
  }
}
