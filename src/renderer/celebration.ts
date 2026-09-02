/**
 * 庆祝动画编排器 —— P2
 *
 * 触发：任务管理器任务完成（当前用调试键 H，P7 接真实源）。
 * 条件（FSM 把关）：仅 专注/延时/鞭策 状态；庆祝中再触发忽略；计时暂停，完全结束后恢复。
 *
 * 六阶段时序（沟通文档"庆祝动画"节，总时长 6s + 复原段 360ms）：
 * ① 0s    02 表情弹动切 happy（鞭策态临时打开 hand 层）；番茄组四层 Q 弹
 *         happy_angle_01/02 以最上层弹入（速度 ×2 = 180ms）；
 *         (143,173) 与 (408,190) 播放 150% 慢放一倍的特殊按钮动画
 * ② 0.5s  firework_01/02 以 1% 缩放出现（angle 下层），easeOutCirc 3s 放大到 100%
 *         缩放中心：01=(359,201)、02=(201,157)；1.5s~3s 透明度匀速降到 0
 * ③ 1.5s  四色彩带（E880F1/8FC9FF/FF858E/65DD6C）落叶式飘落，第 3s 停止生成
 *         （彩带层位：firework 下层、01 按钮层上层）
 * ④ 持续  sunlight 循环加强（幅度 +5%；专注间隔 0 / 延时周期减半）——breathing 庆祝模式
 * ⑤ 4.5~6s 彩带容器整体透明度匀速降到 0
 * ⑥ 6s    angle 直接消失 + 两坐标重播特殊按钮动画；02 表情弹动 + 淡入淡出回到原状态
 *         （鞭策态重新关闭 hand）；全部结束后回调 celebrate:done 恢复计时
 *
 * 层级（顶→底）：angle > firework > 彩带 > btn(01) > digit > expr > body > rock > bg
 * （庆祝容器挂在 stage 最顶层，内部按此顺序装配）
 */
import * as PIXI from 'pixi.js';
import { AssetStore, measureOpaqueBbox, CANVAS_W, CANVAS_H } from './assets';
import {
  BOUNCE_ANCHOR,
  ParticleEmitter,
  TargetRegistry,
  TimelineDef,
  TimelinePlayer,
  TrackDef,
  buildBounceTracks,
  pinAt,
  unpin,
} from './anim';
import { playFrameAnime } from './anime';
import { BreathingController } from './breathing';
import { ButtonController } from './buttons';

// ── 时序参数（文档定值） ──
const CELEBRATE_DURATION_MS = 6000;
const RESTORE_DURATION_MS = 360; // 复原段 = 一个弹动周期
const ANGEL_BOUNCE_MS = 360; // angle 弹入时长（2026-08-01 v3：时长 ×2 恢复常速）
const FIREWORK_DELAY_MS = 500;
const FIREWORK_SCALE_MS = 3000;
const FIREWORK_FADE_DELAY_MS = 1500; // 相对庆祝起点（firework 出现后 1000ms）
const FIREWORK_FADE_MS = 1500; // 1.5s→3s 匀速到 0
const FIREWORK_SRC_DELAY_MS = 400; // 比 firework 放大动画（500ms）早 0.1s 启动
const FIREWORK_SRC_SPAWN_MS = 1500;
// 彩带（2026-08-01 用户定版 v3）：0.62s 后出现（再后延 0.5s）、第 3s 停止；顶部 25px 淡入区；
// 随机缩放 100%~200%、飘落速度随机 50%~120%、密度 -30%（28/s）；
// 背层位于 05 背景之下（缩放 70%~150%，明度压暗 20%）
const CONFETTI_SPAWN_DELAY_MS = 870; // 再后延 0.25s
const CONFETTI_SPAWN_MS = 2130; // 870ms 开始 → 第 3s 停止出现
const CONFETTI_FADE_IN_ZONE_PX = 25;
const CONFETTI_FADE_DELAY_MS = 4500;
// 番茄弹动强度 ×2；angle 弹动强度 ×2（2026-08-01 用户定版 v3）
const TOMATO_BOUNCE_INTENSITY = 2;
const ANGEL_BOUNCE_INTENSITY = 2;
// bg_sun 辉光（2026-08-01 用户定版 v2）：
// 快速亮起（0.2s）→ 保持 → 末 1000ms 熄灭（非简单拉长循环）
const GLOW_IN_MS = 200;
const GLOW_OUT_START_MS = 5000; // 末 1000ms 变暗
const EXPR_FADE_DELAY_MS = 60; // 表情切换：弹动 60ms 后，60ms 完成（与过渡同参数）
const EXPR_FADE_MS = 60;

/** 特殊按钮动画坐标与参数（文档定值） */
const SPECIAL_ANIM_POINTS = [
  { x: 143, y: 173 },
  { x: 408, y: 190 },
];
const SPECIAL_ANIM_FPS = 24;
const SPECIAL_ANIM_SCALE = 1.5;
const SPECIAL_ANIM_SLOW = 2; // 慢放一倍

/** firework 缩放中心（文档定值） */
const FIREWORK_ANCHORS: Record<string, { x: number; y: number }> = {
  fw01: { x: 359, y: 201 },
  fw02: { x: 201, y: 157 },
};

/** firework 彩带粒子源中心（2026-08-01 用户定版，15×15 方形） */
const FIREWORK_SRC_CENTERS = [
  { x: 367, y: 200 },
  { x: 192, y: 161 },
];

/** 彩带四色（文档定值） */
const CONFETTI_COLORS = [0xe880f1, 0x8fc9ff, 0xff858e, 0x65dd6c];

/** 颜色明度缩放（逐通道 ×factor，背层彩带压暗 20% 用） */
function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (Math.min(255, r) << 16) | (Math.min(255, g) << 8) | Math.min(255, b);
}

/** 参与弹动的图层组（01 数字/按钮、02 表情、03 身体） */
const BOUNCE_LAYERS = ['body', 'expr', 'digit', 'btn'] as const;

export class CelebrationController {
  private container: PIXI.Container | null = null;
  /** 背层彩带容器（挂在 stage 最底层 = 05 background 之下） */
  private behindContainer: PIXI.Container | null = null;
  /** 全部粒子发射器（前层/背层彩带 + firework 粒子源 ×2） */
  private emitters: ParticleEmitter[] = [];
  private prevExprSprites: PIXI.DisplayObject[] = [];
  private pinned: PIXI.Container[] = [];
  private running = false;

  constructor(
    private app: PIXI.Application,
    private store: AssetStore,
    private groups: Map<string, PIXI.Container>,
    private targets: TargetRegistry,
    private player: TimelinePlayer,
    private breathing: BreathingController,
    private animeTextures: PIXI.Texture[]
  ) {}

  /** 在布局 apply() 之前调用：捕获将被 happy 替换的原表情（复原段淡回用） */
  capturePrevExpression(): void {
    const exprCt = this.groups.get('expr');
    this.prevExprSprites = exprCt ? [...exprCt.children] : [];
  }

  /** 播放完整庆祝流程；全部结束（含复原段）后 resolve */
  async run(prevState: string): Promise<void> {
    if (this.running) {
      console.warn('[celebration] 庆祝进行中，忽略重复触发');
      return;
    }
    this.running = true;
    try {
      // 呼吸切庆祝加强循环（sunlight 幅度+5%/间隔0 或 延时周期减半）
      this.breathing.enterCelebration(prevState);
      // 鞭策态：hand 层平时隐藏（P3），庆祝期间临时打开
      if (prevState === 'rageFocus') this.setHandVisible(true);

      this.assemble();
      this.playSpecialAnims();

      // 主体 6s
      const main = this.player.play(this.buildMainTimeline());
      await main.finished;

      // 复原段：angle 直接消失 + 重播特殊按钮动画 + 表情弹回原状态
      this.removeAngels();
      this.playSpecialAnims();
      const restore = this.player.play(this.buildRestoreTimeline());
      await restore.finished;

      // 鞭策态：庆祝结束重新关闭 hand
      if (prevState === 'rageFocus') this.setHandVisible(false);
    } finally {
      this.teardown();
      this.breathing.exitCelebration();
      this.running = false;
    }
  }

  // ── 装配 ──

  private assemble(): void {
    // 庆祝容器挂 stage 最顶层
    const ct = new PIXI.Container();
    ct.name = 'celebration';
    this.app.stage.addChild(ct);
    this.container = ct;

    // 彩带公共参数（前层/背层/firework 粒子源共用运动特征）
    const baseConfetti = {
      colors: CONFETTI_COLORS,
      spawnDelay: CONFETTI_SPAWN_DELAY_MS,
      spawnDuration: CONFETTI_SPAWN_MS,
      ratePerSec: 28, // 密度 -30%
      width: { min: 3, max: 5 },
      height: { min: 6, max: 12 },
      fallSpeed: { min: 60, max: 120 },
      speedScale: { min: 0.5, max: 1.2 },
      swayAmp: { min: 10, max: 30 },
      swayFreq: { min: 0.5, max: 1.5 },
      rotSpeed: { min: -180, max: 180 },
      lifeMs: { min: 2500, max: 4000 },
      fadeInZonePx: CONFETTI_FADE_IN_ZONE_PX,
    };

    // 背层彩带（05 background 之下，缩放 70%~150%，明度压暗 20%）：容器挂 stage 最底层
    const behind = new PIXI.Container();
    behind.name = 'celebration-behind';
    this.app.stage.addChildAt(behind, 0);
    this.behindContainer = behind;
    const backEmitter = new ParticleEmitter(
      {
        ...baseConfetti,
        colors: CONFETTI_COLORS.map((c) => darken(c, 0.8)),
        area: { x: 0, y: -12, w: CANVAS_W },
        sizeScale: { min: 0.7, max: 1.5 },
      },
      behind
    );
    backEmitter.start();

    // 前层彩带（firework 下层、01 按钮层上层，缩放 100%~200%）
    const frontEmitter = new ParticleEmitter(
      { ...baseConfetti, area: { x: 0, y: -12, w: CANVAS_W }, sizeScale: { min: 1, max: 2 } },
      ct
    );
    frontEmitter.start();
    this.emitters = [backEmitter, frontEmitter];

    // firework ×2：固定缩放中心，初始 1% 缩放 + 隐藏（500ms 时 step 轨道现身）
    (['fw01', 'fw02'] as const).forEach((k, i) => {
      const s = this.store.sprites.get(`expr_happy_firework_0${i + 1}`);
      if (!s) return;
      const a = FIREWORK_ANCHORS[k];
      s.anchor.set(a.x / CANVAS_W, a.y / CANVAS_H);
      s.position.set(a.x, a.y);
      s.scale.set(0.01);
      s.alpha = 1;
      s.visible = false;
      ct.addChild(s);
      this.targets.register(`ce:${k}`, s);

      // firework 彩带粒子源：固定 15×15 方形源，一次性 30 个爆发（非持续发射）；
      // 初速度 ×2（400~640px/s）衰减 ×1.5（400ms），速度随机 0.7~1.3，方向 ±20° 抖动，
      // 摇摆 0.5s 后 1s 内渐入（2026-08-01 用户定版 v4）
      const center = FIREWORK_SRC_CENTERS[i];
      {
        const src = new ParticleEmitter(
          {
            colors: CONFETTI_COLORS,
            area: { x: center.x - 7.5, y: center.y - 7.5, w: 15, h: 15 },
            spawnDelay: FIREWORK_SRC_DELAY_MS,
            spawnDuration: FIREWORK_SRC_SPAWN_MS, // burstCount 模式下忽略
            ratePerSec: 17.5, // burstCount 模式下忽略
            burstCount: 30,
            burst:
              i === 0
                ? {
                    dirX: -1,
                    dirY: 0,
                    speed: { min: 400, max: 640 },
                    decayMs: 400,
                    jitterDeg: 20,
                    speedJitter: { min: 0.7, max: 1.3 },
                  }
                : {
                    dirX: Math.cos(Math.PI / 6),
                    dirY: -Math.sin(Math.PI / 6),
                    speed: { min: 400, max: 640 },
                    decayMs: 400,
                    jitterDeg: 20,
                    speedJitter: { min: 0.7, max: 1.3 },
                  },
            swayRamp: { delayMs: 500, rampMs: 1000 },
            width: { min: 3, max: 5 },
            height: { min: 6, max: 12 },
            sizeScale: { min: 0.7, max: 1.5 },
            fallSpeed: { min: 60, max: 120 },
            speedScale: { min: 0.5, max: 1.2 },
            swayAmp: { min: 10, max: 30 },
            swayFreq: { min: 0.5, max: 1.5 },
            rotSpeed: { min: -180, max: 180 },
            lifeMs: { min: 1500, max: 2500 },
          },
          ct
        );
        src.start();
        this.emitters.push(src);
      }
    });

    // happy_angle ×2：锚点 = 各自不透明像素 bbox 中心（弹动围绕自身中心）
    (['01', '02'] as const).forEach((n, i) => {
      const s = this.store.sprites.get(`expr_happy_angle_${n}`);
      const img = this.store.images.get(`expr_happy_angle_${n}`);
      if (!s || !img) return;
      ButtonController.anchorAtBboxCenter(s, measureOpaqueBbox(img));
      s.alpha = 1;
      ct.addChild(s);
      this.targets.register(`ce:angel${i}`, s);
    });

    // 番茄组弹动锚定
    for (const n of BOUNCE_LAYERS) {
      const g = this.groups.get(n);
      if (!g) continue;
      pinAt(g, BOUNCE_ANCHOR.x, BOUNCE_ANCHOR.y);
      this.pinned.push(g);
      this.targets.register(`ce:${n}`, g);
    }
  }

  // ── 主 Timeline（6s） ──

  private buildMainTimeline(): TimelineDef {
    const tracks: TrackDef[] = [];
    const exprCt = this.groups.get('expr');

    // ① 番茄组弹动（强度 ×2）+ 表情淡入淡出切 happy
    tracks.push(
      ...buildBounceTracks({
        target: BOUNCE_LAYERS.map((n) => `ce:${n}`),
        duration: RESTORE_DURATION_MS,
        intensity: TOMATO_BOUNCE_INTENSITY,
      })
    );
    if (exprCt) {
      const happy = [...exprCt.children];
      happy.forEach((s, i) => {
        s.alpha = 0;
        this.targets.register(`ce:exprNew${i}`, s);
        tracks.push({
          target: `ce:exprNew${i}`,
          property: 'alpha',
          delay: EXPR_FADE_DELAY_MS,
          keys: [
            { at: 0, value: 0, easing: 'easeInOutSine' },
            { at: EXPR_FADE_MS, value: 1 },
          ],
        });
      });
      this.prevExprSprites.forEach((s, i) => {
        exprCt.addChild(s); // 原表情置于 happy 之上淡出
        this.targets.register(`ce:exprOld${i}`, s);
        tracks.push({
          target: `ce:exprOld${i}`,
          property: 'alpha',
          delay: EXPR_FADE_DELAY_MS,
          keys: [
            { at: 0, value: 1, easing: 'easeInOutSine' },
            { at: EXPR_FADE_MS, value: 0 },
          ],
        });
      });
    }

    // ① angle 弹入（速度 ×2 + 强度 ×3）
    tracks.push(
      ...buildBounceTracks({
        target: ['ce:angel0', 'ce:angel1'],
        duration: ANGEL_BOUNCE_MS,
        intensity: ANGEL_BOUNCE_INTENSITY,
      })
    );

    // ① bg_sun 辉光"整段同步大循环"：首次亮起后保持，末 1000ms 变暗
    // （目标由 breathing 庆祝脉冲装配注册；延时触发时无此目标，跳过）
    if (this.targets.has('br:bgSunGlow')) {
      tracks.push({
        target: 'br:bgSunGlow',
        property: 'alpha',
        keys: [
          { at: 0, value: 0, easing: 'bgSunGlowIn' },
          { at: GLOW_IN_MS, value: 1 },
          { at: GLOW_OUT_START_MS, value: 1, easing: 'bgSunGlowOut' },
          { at: CELEBRATE_DURATION_MS, value: 0 },
        ],
      });
    }

    // ② firework：500ms 现身，1%→100%（easeOutCirc 半圆曲线），1.5s~3s 淡出
    for (const k of ['fw01', 'fw02'] as const) {
      tracks.push({
        target: `ce:${k}`,
        property: 'visible',
        delay: FIREWORK_DELAY_MS,
        keys: [{ at: 0, value: 1 }],
      });
      tracks.push({
        target: `ce:${k}`,
        property: 'scale',
        delay: FIREWORK_DELAY_MS,
        keys: [
          { at: 0, value: 0.01, easing: 'easeOutCirc' },
          { at: FIREWORK_SCALE_MS, value: 1 },
        ],
      });
      tracks.push({
        target: `ce:${k}`,
        property: 'alpha',
        delay: FIREWORK_FADE_DELAY_MS,
        keys: [
          { at: 0, value: 1, easing: 'linear' },
          { at: FIREWORK_FADE_MS, value: 0 },
        ],
      });
    }

    // ⑤ 前层/背层彩带容器 4.5s~6s 整体淡出（粒子生成/飘落由发射器自治）
    this.targets.register('ce:confetti', this.emitters[1].container);
    this.targets.register('ce:confettiBack', this.emitters[0].container);
    for (const n of ['ce:confetti', 'ce:confettiBack']) {
      tracks.push({
        target: n,
        property: 'alpha',
        keys: [
          { at: 0, value: 1 },
          { at: CONFETTI_FADE_DELAY_MS, value: 1, easing: 'linear' },
          { at: CELEBRATE_DURATION_MS, value: 0 },
        ],
      });
    }

    return { name: 'celebration:main', duration: CELEBRATE_DURATION_MS, tracks };
  }

  // ── 复原段（360ms）：表情弹动 + 淡入淡出回到原状态 ──

  private buildRestoreTimeline(): TimelineDef {
    const tracks: TrackDef[] = [];
    const exprCt = this.groups.get('expr');
    tracks.push(
      ...buildBounceTracks({
        target: BOUNCE_LAYERS.map((n) => `ce:${n}`),
        duration: RESTORE_DURATION_MS,
        intensity: TOMATO_BOUNCE_INTENSITY,
      })
    );
    if (exprCt) {
      // happy 淡出、原表情淡回（原表情在 ① 淡出后一直留在 expr 组中）
      exprCt.children.forEach((s, i) => {
        if (this.prevExprSprites.includes(s)) return;
        this.targets.register(`ce:exprHappy${i}`, s);
        tracks.push({
          target: `ce:exprHappy${i}`,
          property: 'alpha',
          delay: EXPR_FADE_DELAY_MS,
          keys: [
            { at: 0, value: 1, easing: 'easeInOutSine' },
            { at: EXPR_FADE_MS, value: 0 },
          ],
        });
      });
      this.prevExprSprites.forEach((s, i) => {
        this.targets.register(`ce:exprBack${i}`, s);
        tracks.push({
          target: `ce:exprBack${i}`,
          property: 'alpha',
          delay: EXPR_FADE_DELAY_MS,
          keys: [
            { at: 0, value: 0, easing: 'easeInOutSine' },
            { at: EXPR_FADE_MS, value: 1 },
          ],
        });
      });
    }
    return { name: 'celebration:restore', duration: RESTORE_DURATION_MS, tracks };
  }

  // ── 工具 ──

  /** 两坐标播放特殊按钮动画（150% + 慢放一倍） */
  private playSpecialAnims(): void {
    if (!this.container) return;
    for (const p of SPECIAL_ANIM_POINTS) {
      playFrameAnime(
        this.container,
        this.animeTextures,
        p.x,
        p.y,
        SPECIAL_ANIM_FPS,
        SPECIAL_ANIM_SCALE,
        SPECIAL_ANIM_SLOW
      );
    }
  }

  private removeAngels(): void {
    if (!this.container) return;
    for (const n of ['ce:angel0', 'ce:angel1']) {
      const s = this.targets.resolve(n);
      if (s) this.container.removeChild(s);
    }
  }

  private setHandVisible(v: boolean): void {
    const hand = this.store.sprites.get('body_hand');
    if (hand) hand.visible = v;
  }

  /** 清场：容器/发射器销毁、图层组还原、表情终态确定（原表情可见、happy 隐藏） */
  private teardown(): void {
    this.pinned.forEach(unpin);
    this.pinned = [];
    for (const e of this.emitters) e.destroy();
    this.emitters = [];
    if (this.behindContainer) {
      this.behindContainer.removeChildren();
      this.app.stage.removeChild(this.behindContainer);
      this.behindContainer.destroy();
      this.behindContainer = null;
    }
    if (this.container) {
      // 注意不能 destroy children：angle/firework 精灵属于 AssetStore，下次还要复用
      this.container.removeChildren();
      this.app.stage.removeChild(this.container);
      this.container.destroy();
      this.container = null;
    }
    const exprCt = this.groups.get('expr');
    if (exprCt) {
      for (const s of exprCt.children) {
        s.alpha = this.prevExprSprites.includes(s) ? 1 : 0;
      }
    }
    this.prevExprSprites = [];
  }
}
