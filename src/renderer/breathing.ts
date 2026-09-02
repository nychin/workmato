/**
 * 呼吸动画编排器 —— M3（P0 重构：迁移至 Timeline 引擎）
 *
 * ⚠️ 行为与 M3 验收版逐帧等价，本文件只做实现方式迁移，不改任何视觉参数。
 * 回滚版本见：D:\AI\tomato_kimi\备份\2026-07-30_P0引擎改造前\breathing.ts
 *
 * 等价映射（旧实现 → Timeline 表达）：
 * | 旧实现                                   | 新实现                                              |
 * |------------------------------------------|-----------------------------------------------------|
 * | sin(k·π) 脉冲 tween                      | easeOutSine+easeInSine 双段关键帧（数学严格相等）    |
 * | bg_sun 辉光 sin(k²·π)                    | 自定义分段缓动 bgSunGlowIn/Out（严格相等，峰值1414ms）|
 * | 延时 sync smoothstep 双段                 | easeInOutSmooth 双段关键帧                           |
 * | 鼻涕泡幂次1.5缓动                          | 自定义缓动 bubbleIn/bubbleOut（严格相等）             |
 * | schedule 递归循环（2000活跃+4000间隔）     | duration=6000 + loop:true                           |
 * | tween(delay) 仅首轮生效                   | play(def, { startDelay }) 只生效一次                 |
 * | epoch 递增优雅暂停                        | Playback.finishAfterLoop()                          |
 * | stopKind 立即取消                         | Playback.cancel()                                   |
 * | 快速暂停→恢复（新增）                      | ensureLoop 幂等启动：撤销停止、相位连续复用          |
 *
 * 生命周期由 TimelinePlayer 句柄统一管理，epoch 代际号机制退役。
 * 两帧轮播（note/ZZZ）不属于数值插值，继续使用 anime.frameSwap 基元。
 */
import * as PIXI from 'pixi.js';
import { AssetStore, SUNLIGHT_KEYS } from './assets';
import { AnimHandle, frameSwap } from './anime';
import { RecolorKit, colorize } from './recolor';
import {
  Playback,
  TargetRegistry,
  TimelinePlayer,
  TimelineDef,
  TrackDef,
  registerEasing,
} from './anim';

// ── 参数（与 M3 验收版一致，勿动） ──
const PULSE_AMP_FOCUS = 0.15;
const PULSE_AMP_RAGE = 0.25;
const PULSE_STEP_MS = 150;
const PULSE_DURATION_MS = 500;
const PULSE_GAP_MS = 4000;
const GLOW_HALO = 0.6; // 辉光光晕最大不透明度（精确变亮由重着色孪生承担）
const BG_SUN_GLOW_LEAD_MS = 1250; // 辉光提前 sunlight01 启动 1.25s（原 750ms，2026-07-30 提前 0.5s）
const BG_SUN_GLOW_COLOR = 0xffde75; // bg_sun 辉光精确色（colorize 纯色纹理 + NORMAL blend）
/** 一轮脉冲活跃时长：(11-1)×150 + 500 = 2000ms */
const PULSE_ROUND_MS = (SUNLIGHT_KEYS.length - 1) * PULSE_STEP_MS + PULSE_DURATION_MS;
/** 辉光变亮段时长：sin(k²·π) 在 k=1/√2 处取峰 → 1414ms（保持验收版，不变亮速） */
const BG_SUN_GLOW_PEAK_MS = Math.round(PULSE_ROUND_MS / Math.SQRT2);
/** 辉光还原结束时刻：4000ms（原 2000ms，2026-07-30 还原段拉长 1.5s 更柔和） */
const BG_SUN_GLOW_END_MS = 4000;

const SYNC_BASE_SCALE = 0.85; // 延时状态基准（专注的 85%）
const SYNC_AMP = 0.1; // 放大到 110% 再回 100%
const SYNC_PERIOD_MS = 6000; // 比原来 4000ms 慢 50%

const GLOW_PERIOD_MS = 6000;
const GLOW_OFFSET_MS = 4000;

/** 各两帧动画的单帧时长（note/ZZZ 节奏不同） */
const FRAME_MS_MAP: Record<string, number> = {
  expr_idie_note: 1200, // 1.2s 一切，循环 2.4s
  expr_pro_zzz: 1200, // 1.2s 一切，循环 2.4s
  expr_rest_zzz: 1500, // 1.5s 一切，循环 3s
};

const BUBBLE_PERIOD_MS = 7000; // 鼻涕泡 1→2→1，3.5s 涨 3.5s 缩

/**
 * 庆祝脉冲参数（2026-08-01 用户定版 v2）：
 * - 紧接着播放：去掉每轮开头的辉光提前量空档（leadMs=0），全列播完立即下一轮
 * - 脉冲速度 +30%（step/duration 同步除以 1.3）
 * - 变亮更亮 + 辉光加强：亮黄孪生换更浅颜色、光晕 alpha 上限 0.6→0.95、
 *   bg_sun 辉光换更浅色（快速亮起 0.2s 的轨道在庆祝主时间轴上）
 */
const CELEBRATE_PULSE_SPEED = 1.3;
const CELEBRATE_HALO = 0.95;
const CELEBRATE_BRIGHT_COLOR = 0xfff1b8;
const CELEBRATE_GLOW_COLOR = 0xfff0a0;
/** 庆祝脉冲循环次数：6s ÷ 周期 1538ms ≈ 3.9 → 3 个完整循环（砍掉末尾不完整的循环） */
const CELEBRATE_PULSE_LOOPS = 3;

// ── 自定义缓动：精确复刻 M3 验收版的非标准曲线 ──
// ⚠️ 约定：缓动输出是「插值比例」，必须 0→1 单调（引擎再乘值域差还原为属性值）。
//    即使是下降段，缓动同样从 0 递增到 1——返回"值的下降形状"会导致
//    段首跳变 + 重复上升（本次 bug 的教训）。
// bg_sun 辉光 alpha = sin(k²·π)，k∈[0,1]，峰值在 k=1/√2。
// 升段（值 0→1）：比例 = sin(u²·π/2)。
// 降段（值 1→0）：值 = sin(k²·π)，k=1/√2+u·(1-1/√2) → 比例 = 1-sin(k²·π)。
registerEasing('bgSunGlowIn', (u) => Math.sin((u * u * Math.PI) / 2));
registerEasing('bgSunGlowOut', (u) => {
  const k = 1 / Math.SQRT2 + u * (1 - 1 / Math.SQRT2);
  return 1 - Math.sin(k * k * Math.PI);
});
// 鼻涕泡：旧版 eased = 0.5(2k)^1.5 / 1-0.5(2(1-k))^1.5，再取 sin(eased·π)，scale=1+sin(eased·π)。
// 升段（值 1→2）：比例 = sin(π/2·u^1.5)。
// 降段（值 2→1）：值 = 1+sin(π/2·(1-u)^1.5) → 比例 = 1-sin(π/2·(1-u)^1.5)。
registerEasing('bubbleIn', (u) => Math.sin((Math.PI / 2) * Math.pow(u, 1.5)));
registerEasing('bubbleOut', (u) => 1 - Math.sin((Math.PI / 2) * Math.pow(1 - u, 1.5)));

type LoopKind = 'pulse' | 'sync' | 'glow' | 'frames' | 'bubble';

/**
 * 具名循环键：TimelinePlayer.ensureLoop 幂等复用的依据。
 * 快速 暂停→恢复 时同名循环仍活跃（含优雅停止途中），
 * ensureLoop 会撤销停止请求、相位连续复用，动画"顺着播"不打断。
 */
const LOOP_KEYS = {
  pulse: 'breath:pulse',
  sync: 'breath:sync',
  glowStar: 'breath:glow:starlight',
  glowMoon: 'breath:glow:moonlight',
  bubble: 'breath:bubble',
  // 庆祝模式（P2）：与常规循环不同的具名键，避免 ensureLoop 复用冲突
  pulseCelebrate: 'breath:pulse:celebration',
  syncCelebrate: 'breath:sync:celebration',
} as const;

interface BreathSpec {
  pulse?: number; // 脉冲幅度（focus/rageFocus）
  sync?: boolean; // 延时同步慢呼吸
  glow?: boolean; // 夜晚光晕
  frames?: string; // 两帧素材前缀：expr_idie_note / expr_pro_zzz / expr_rest_zzz
  bubble?: boolean; // 鼻涕泡缩放呼吸（rest）
}

/** Timeline 引擎依赖（由 main.ts 注入，全局唯一实例） */
export interface BreathAnimDeps {
  targets: TargetRegistry;
  player: TimelinePlayer;
}

// ── 轨道构建小工具 ──

/** sin(k·π) 缩放脉冲轨道：1→peak→1（正弦半波双段 = 旧版 tween onUpdate 严格相等） */
function sinScaleTrack(
  target: string,
  delay: number,
  peak: number,
  waveMs = PULSE_DURATION_MS
): TrackDef {
  return {
    target,
    property: 'scale',
    delay,
    keys: [
      { at: 0, value: 1, easing: 'easeOutSine' },
      { at: waveMs / 2, value: peak, easing: 'easeInSine' },
      { at: waveMs, value: 1 },
    ],
  };
}

/** sin(k·π) 透明度脉冲轨道：0→peak→0 */
function sinAlphaTrack(
  target: string,
  delay: number,
  peak: number,
  waveMs = PULSE_DURATION_MS
): TrackDef {
  return {
    target,
    property: 'alpha',
    delay,
    keys: [
      { at: 0, value: 0, easing: 'easeOutSine' },
      { at: waveMs / 2, value: peak, easing: 'easeInSine' },
      { at: waveMs, value: 0 },
    ],
  };
}

export class BreathingController {
  /** 各类循环的播放句柄（cancel / finishAfterLoop 的载体） */
  private playbacks = new Map<LoopKind, Playback[]>();
  /** 两帧轮播句柄（frameSwap 基元，非 Timeline） */
  private frameHandle: AnimHandle | null = null;
  /** 帧动画停止时用于恢复 01 帧的上下文 */
  private framesRestore: { sprite: PIXI.Sprite; tex: PIXI.Texture } | null = null;
  /** bg_sun 的辉光叠加层（NORMAL blend，colorize 纯色纹理） */
  private bgSunGlow: PIXI.Sprite | null = null;
  /** 当前脉冲幅度（专注 0.15 / 鞭策 0.25）：幅度变化时旧循环不可复用 */
  private pulseAmp: number | undefined;
  private active: BreathSpec = {};

  constructor(
    private store: AssetStore,
    private glowTwins: Map<string, PIXI.Sprite> | undefined,
    private recolor: RecolorKit | undefined,
    private anim: BreathAnimDeps
  ) {}

  /** 注册动画目标（同名覆盖为正常用法：辉光精灵每次重建后重新注册） */
  private reg(name: string, obj: PIXI.DisplayObject): string {
    this.anim.targets.register(name, obj);
    return name;
  }

  /** 状态切换入口（在布局应用之后调用）
   *  @param easterEgg 延时上限彩蛋（die 表情）：停用 ZZZ 帧动画与 sync，保持静置 */
  startForState(state: string, prevState: string, easterEgg = false): void {
    const next = this.specFor(state);
    if (easterEgg) {
      next.frames = undefined;
      next.sync = undefined;
    }

    // ── 停止不需要的 loop ──
    if (this.active.pulse !== undefined && next.pulse === undefined) {
      // 专注暂停：脉冲播完当前一轮后停（各层回 100%）
      if (prevState === 'focus' && state === 'focusPaused') this.finishKind('pulse');
      else this.stopKind('pulse');
    }
    if (this.active.sync && !next.sync) this.stopKind('sync');
    if (this.active.glow && !next.glow) {
      // 休息暂停：光晕播完当前一轮后停（回 0% 透明度）
      if (prevState === 'rest' && state === 'restPaused') this.finishKind('glow');
      else this.stopKind('glow');
    }
    if (this.active.frames && this.active.frames !== next.frames) {
      this.stopKind('frames');
    }
    if (this.active.bubble && !next.bubble) {
      // 休息暂停：鼻涕泡播完当前一轮后停（回 100% 缩放）
      if (prevState === 'rest' && state === 'restPaused') this.finishKind('bubble');
      else this.stopKind('bubble');
    }

    // ── 启动新 loop（同类同参已在跑则不重复启动，保证无缝） ──
    // 脉冲幅度变化（专注 15% ↔ 鞭策 25%）视为不同循环，需要重启装配
    if (next.pulse !== undefined && this.active.pulse !== next.pulse) {
      this.startPulse(next.pulse);
    } else if (next.pulse !== undefined) {
      // 同状态刷新（例如切换置顶）会让布局清空并重装 bg 层，
      // 将仍在运行的太阳辉光精灵重新挂回，保持当前动画相位不中断。
      this.reattachBgSunGlow();
    }
    if (next.sync && !this.active.sync) this.startSync();
    if (next.glow && !this.active.glow) this.startGlow();
    if (next.frames && this.active.frames !== next.frames) {
      this.startFrames(next.frames);
    }
    if (next.bubble && !this.active.bubble) this.startBubble();

    this.active = { ...next };
  }

  /** 全部立即停止（过渡动画开始时调用，M5 使用） */
  stopAll(): void {
    for (const kind of ['pulse', 'sync', 'glow', 'frames', 'bubble'] as LoopKind[]) {
      this.stopKind(kind);
    }
    this.active = {};
  }

  // ── 庆祝模式（P2） ──
  // 文档规则：庆祝期间 sunlight 循环继续但加强——
  //   专注/鞭策触发：幅度 +5%、循环间隔缩为 0（紧接着播放）
  //   延时触发：幅度 +5%、循环时长减半
  // 其余循环（帧动画等）停止；庆祝结束由 exitCelebration + startForState 恢复。

  /** 进入庆祝模式（state = 触发庆祝前的状态：focus / prolongation / rageFocus） */
  enterCelebration(state: string): void {
    this.stopKind('frames');
    if (state === 'prolongation') {
      this.stopKind('sync');
      const { playback } = this.anim.player.ensureLoop(
        LOOP_KEYS.syncCelebrate,
        () => this.buildSyncDef(SYNC_AMP + 0.05, SYNC_PERIOD_MS / 2),
        { loop: true }
      );
      // 占用同 kind 槽位：exitCelebration 的 stopKind 一并管理
      this.playbacks.set('sync', [playback]);
    } else {
      this.stopKind('pulse');
      const amp = (state === 'rageFocus' ? PULSE_AMP_RAGE : PULSE_AMP_FOCUS) + 0.05;
      const { playback } = this.anim.player.ensureLoop(
        LOOP_KEYS.pulseCelebrate,
        // 紧接着播放（leadMs=0）+ 加速 30%；周期 = 全列脉冲实际长度
        // 辉光轨道剥离：改由庆祝主时间轴做"快速亮起→保持→熄灭"
        () =>
          this.buildPulseDef(amp, {
            durationMs: PULSE_ROUND_MS / CELEBRATE_PULSE_SPEED,
            withGlow: false,
            leadMs: 0,
            speed: CELEBRATE_PULSE_SPEED,
            halo: CELEBRATE_HALO,
            brightColor: CELEBRATE_BRIGHT_COLOR,
            glowColor: CELEBRATE_GLOW_COLOR,
          }),
        // 只播 3 个完整循环（4.6s），末尾不完整的第 4 循环砍掉；
        // 播完自动 settle，exitCelebration 的 stopKind 对其为无操作
        { loop: CELEBRATE_PULSE_LOOPS }
      );
      this.playbacks.set('pulse', [playback]);
    }
    // 常规 spec 清空（恢复时由 startForState 重建，避免误判"已在运行"）
    this.active = {};
  }

  /** 退出庆祝模式：停庆祝加强循环；常规循环由 startForState 恢复 */
  exitCelebration(): void {
    this.stopKind('pulse');
    this.stopKind('sync');
  }

  // ── 状态 → 呼吸配置 ──

  private specFor(state: string): BreathSpec {
    switch (state) {
      case 'idle':
        return { frames: 'expr_idie_note' };
      case 'focus':
        return { pulse: PULSE_AMP_FOCUS };
      case 'focusPaused':
        return { frames: 'expr_idie_note' };
      case 'rageFocus':
        return { pulse: PULSE_AMP_RAGE };
      case 'prolongation':
        return { sync: true, frames: 'expr_pro_zzz' };
      case 'waitingRest':
        // 等待休息：静态展示夜间背景+ZZZ表情，无呼吸动画
        return {};
      case 'rest':
        return { glow: true, frames: 'expr_rest_zzz', bubble: true };
      case 'restPaused':
        // 休息暂停：静态展示（ZZZ 轮播属于 rest，暂停时停帧回 01；光晕/鼻涕泡优雅停止）
        return {};
      default:
        return {};
    }
  }

  // ── 太阳光芒依次脉冲（专注/鞭策） ──
  // 一条 Timeline 承载全部轨道：周期 = 2000ms 活跃 + 4000ms 间隔，无限循环。
  // 辉光轨道从 0 开始；光芒轨道延迟 750+i·150（辉光提前量在此体现）。

  private startPulse(amp: number): void {
    // 幅度不同（专注 15% / 鞭策 25%）则波形不同，旧循环不可复用，先硬停
    if (this.pulseAmp !== undefined && this.pulseAmp !== amp) {
      this.stopKind('pulse');
    }
    // 幂等启动（"顺着播"）：旧循环仍活跃（含优雅停止途中）→ 撤销停止、
    // 相位连续复用，def 工厂不执行（无任何装配副作用）；否则全新装配启动
    const { playback, reused } = this.anim.player.ensureLoop(
      LOOP_KEYS.pulse,
      () => this.buildPulseDef(amp),
      { loop: true }
    );
    if (reused) {
      // 布局 apply 已摘除辉光精灵，挂回即可（光芒/孪生属性由循环每帧覆写）
      this.reattachBgSunGlow();
    }
    this.playbacks.set('pulse', [playback]);
    this.pulseAmp = amp;
  }

  /** buildPulseDef 选项 */
  private static readonly PULSE_DEFAULTS = {
    /** 循环间隔（常规 4000ms；与 durationMs 二选一） */
    gapMs: PULSE_GAP_MS,
    /** 显式总周期（庆祝模式用 CELEBRATE_PULSE_DURATION_MS，覆盖 gapMs 计算） */
    durationMs: 0,
    /** 是否包含 bg_sun 辉光轨道（庆祝模式 false——辉光由庆祝主时间轴统一控制） */
    withGlow: true,
  };

  /**
   * 构建脉冲 Timeline（仅 ensureLoop 全新启动时执行）：
   * 装配 bg_sun 辉光精灵 + 注册全部动画目标 + 生成轨道。
   */
  private buildPulseDef(
    amp: number,
    opts: {
      gapMs?: number;
      durationMs?: number;
      withGlow?: boolean;
      /** 光芒起始延迟（默认 1250 辉光提前量；庆祝"紧接着播放"传 0） */
      leadMs?: number;
      /** 脉冲速度倍率（庆祝 1.3；step/波宽同步缩放） */
      speed?: number;
      /** 光晕 alpha 上限（默认 GLOW_HALO 0.6） */
      halo?: number;
      /** 亮黄孪生颜色覆盖（默认 recolor.brightTex 的 FFE588） */
      brightColor?: number;
      /** bg_sun 辉光颜色覆盖（默认 FFDE75） */
      glowColor?: number;
    } = {}
  ): TimelineDef {
    const gapMs = opts.gapMs ?? BreathingController.PULSE_DEFAULTS.gapMs;
    const withGlow = opts.withGlow ?? BreathingController.PULSE_DEFAULTS.withGlow;
    const leadMs = opts.leadMs ?? BG_SUN_GLOW_LEAD_MS;
    const speed = opts.speed ?? 1;
    const halo = opts.halo ?? GLOW_HALO;
    const stepMs = PULSE_STEP_MS / speed;
    const waveMs = PULSE_DURATION_MS / speed;
    const durationMs = opts.durationMs || PULSE_ROUND_MS + gapMs;
    const sprites = SUNLIGHT_KEYS.map((k) => this.store.sprites.get(k)).filter(
      (s): s is PIXI.Sprite => !!s
    );
    const bgSun = this.store.sprites.get('bg_sun');
    const tracks: TrackDef[] = [];

    // ── bg_sun 辉光：colorize() 重绘 FFDE75 纯色纹理 + NORMAL blend 孪生精灵 ──
    // alpha=1 时显示精确 FFDE75（脉冲 colorTwin 同一机制）。
    // 暂停时 finishAfterLoop 让活跃波自然 fade-out 到周期末，下轮不再启动。
    if (bgSun) {
      if (this.bgSunGlow) {
        this.bgSunGlow.parent?.removeChild(this.bgSunGlow);
        this.bgSunGlow.destroy();
        this.bgSunGlow = null;
      }
      const sunImg = this.store.images.get('bg_sun');
      const glowTex = sunImg ? colorize(sunImg, opts.glowColor ?? BG_SUN_GLOW_COLOR) : null;
      if (glowTex) {
        const glow = new PIXI.Sprite(glowTex);
        glow.anchor.copyFrom(bgSun.anchor);
        // NORMAL blend（默认），alpha=1 即显示精确 FFDE75
        glow.alpha = 0;
        glow.position.copyFrom(bgSun.position);
        glow.scale.copyFrom(bgSun.scale);
        const parent = bgSun.parent;
        if (parent) {
          parent.addChild(glow);
          parent.setChildIndex(glow, parent.getChildIndex(bgSun) + 1);
        }
        this.bgSunGlow = glow;
        this.reg('br:bgSunGlow', glow);
        if (withGlow) {
          // 辉光 alpha：变亮段 1414ms（sin(k²·π) 复刻验收版），还原段拉长至 4000ms
          tracks.push({
            target: 'br:bgSunGlow',
            property: 'alpha',
            keys: [
              { at: 0, value: 0, easing: 'bgSunGlowIn' },
              { at: BG_SUN_GLOW_PEAK_MS, value: 1, easing: 'bgSunGlowOut' },
              { at: BG_SUN_GLOW_END_MS, value: 0 },
            ],
          });
        }
      }
    }

    sprites.forEach((s, i) => {
      const key = SUNLIGHT_KEYS[i];
      const delay = leadMs + i * stepMs;
      const colorTwin = this.recolor?.colorTwins.get(key);
      const glowTwin = this.glowTwins?.get(key);
      // 精确亮黄孪生纹理一次到位（庆祝模式可覆盖为更亮色）
      if (colorTwin) {
        if (opts.brightColor !== undefined) {
          const img = this.store.images.get(key);
          if (img) colorTwin.texture = colorize(img, opts.brightColor);
        } else {
          const tex = this.recolor?.brightTex.get(key);
          if (tex) colorTwin.texture = tex;
        }
      }
      tracks.push(sinScaleTrack(this.reg(`br:p:${key}`, s), delay, 1 + amp, waveMs));
      if (colorTwin) {
        const n = this.reg(`br:pc:${key}`, colorTwin);
        tracks.push(
          sinScaleTrack(n, delay, 1 + amp, waveMs),
          sinAlphaTrack(n, delay, 1, waveMs)
        );
      }
      if (glowTwin) {
        const n = this.reg(`br:pg:${key}`, glowTwin);
        tracks.push(
          sinScaleTrack(n, delay, 1 + amp, waveMs),
          sinAlphaTrack(n, delay, halo, waveMs)
        );
      }
    });

    return {
      name: LOOP_KEYS.pulse,
      duration: durationMs,
      tracks,
    };
  }

  // ── 太阳光芒同步慢呼吸（延时，基准 85%） ──
  // 每周期两段：扩张（0→50%）+ 收缩（50%→100%），smoothstep 头尾零导数

  private startSync(): void {
    const { playback } = this.anim.player.ensureLoop(
      LOOP_KEYS.sync,
      () => this.buildSyncDef(),
      { loop: true }
    );
    this.playbacks.set('sync', [playback]);
  }

  /**
   * 构建延时同步呼吸 Timeline。
   * amp/periodMs 默认常规参数；庆祝模式传 amp+0.05、period/2（文档规则）。
   */
  private buildSyncDef(amp = SYNC_AMP, periodMs = SYNC_PERIOD_MS): TimelineDef {
    const tracks: TrackDef[] = [];
    const push = (name: string, obj: PIXI.DisplayObject | undefined): void => {
      if (!obj) return;
      tracks.push({
        target: this.reg(name, obj),
        property: 'scale',
        keys: [
          { at: 0, value: SYNC_BASE_SCALE, easing: 'easeInOutSmooth' },
          {
            at: periodMs / 2,
            value: SYNC_BASE_SCALE * (1 + amp),
            easing: 'easeInOutSmooth',
          },
          { at: periodMs, value: SYNC_BASE_SCALE },
        ],
      });
    };
    for (const sk of SUNLIGHT_KEYS) {
      push(`br:s:${sk}`, this.store.sprites.get(sk));
      push(`br:sc:${sk}`, this.recolor?.colorTwins.get(sk));
      push(`br:sg:${sk}`, this.glowTwins?.get(sk));
    }
    return { name: LOOP_KEYS.sync, duration: periodMs, tracks };
  }

  // ── 夜晚光晕（rest） ──
  // 两条独立 Playback：startDelay 只生效一次（等价旧 tween delay 语义），
  // 之后各自 6s 连续循环，moonlight 与 starlight 保持 4s 相位差。

  private startGlow(): void {
    const mk = (
      sprite: PIXI.Sprite | undefined,
      loopKey: string,
      startDelay: number
    ): Playback | null => {
      if (!sprite) return null;
      // 复用时沿用原实例配置（startDelay 不再生效——相位连续正是目的）
      const { playback } = this.anim.player.ensureLoop(
        loopKey,
        () => {
          this.reg(loopKey, sprite);
          return {
            name: loopKey,
            duration: GLOW_PERIOD_MS,
            tracks: [
              {
                target: loopKey,
                property: 'alpha',
                keys: [
                  { at: 0, value: 0, easing: 'easeOutSine' },
                  { at: GLOW_PERIOD_MS / 2, value: 1, easing: 'easeInSine' },
                  { at: GLOW_PERIOD_MS, value: 0 },
                ],
              },
            ],
          };
        },
        { loop: true, startDelay }
      );
      return playback;
    };
    const hs = [
      mk(this.store.sprites.get('bg_night_starlight'), LOOP_KEYS.glowStar, 0),
      mk(this.store.sprites.get('bg_night_moonlight'), LOOP_KEYS.glowMoon, GLOW_OFFSET_MS),
    ].filter((h): h is Playback => !!h);
    this.playbacks.set('glow', hs);
  }

  // ── 鼻涕泡缩放呼吸（rest） ──

  private startBubble(): void {
    const s = this.store.sprites.get('expr_rest_bubble');
    if (!s) return;
    const { playback } = this.anim.player.ensureLoop(
      LOOP_KEYS.bubble,
      () => {
        s.scale.set(1); // 仅全新启动时归位；复用保持当前相位（"顺着播"）
        return {
          name: LOOP_KEYS.bubble,
          duration: BUBBLE_PERIOD_MS,
          tracks: [
            {
              target: this.reg(LOOP_KEYS.bubble, s),
              property: 'scale',
              keys: [
                { at: 0, value: 1, easing: 'bubbleIn' },
                { at: BUBBLE_PERIOD_MS / 2, value: 2, easing: 'bubbleOut' },
                { at: BUBBLE_PERIOD_MS, value: 1 },
              ],
            },
          ],
        };
      },
      { loop: true }
    );
    this.playbacks.set('bubble', [playback]);
  }

  // ── 两帧轮播（note / ZZZ）：非数值插值，继续用 frameSwap 基元 ──

  private startFrames(prefix: string): void {
    this.stopKind('frames');
    const sprite = this.store.sprites.get(`${prefix}_01`);
    const img1 = this.store.images.get(`${prefix}_01`);
    const img2 = this.store.images.get(`${prefix}_02`);
    if (!sprite || !img1 || !img2) return;
    const texA = PIXI.Texture.from(img1);
    const texB = PIXI.Texture.from(img2);
    sprite.texture = texA;
    this.framesRestore = { sprite, tex: texA };
    const frameMs = FRAME_MS_MAP[prefix] ?? 500;
    this.frameHandle = frameSwap(sprite, texA, texB, frameMs);
  }

  // ── 工具 ──

  /** 优雅停止：当前循环跑到周期末尾自然结束（等价旧 epoch 递增） */
  private finishKind(kind: LoopKind): void {
    const ps = this.playbacks.get(kind);
    if (ps) ps.forEach((p) => p.finishAfterLoop());
    // 辉光精灵在布局重建（apply 清空 bg 组）时会被摘除，
    // 优雅停止期间需挂回 bg_sun 之上，当前波才能在画面上完整播完
    if (kind === 'pulse') this.reattachBgSunGlow();
  }

  /**
   * 把 bgSunGlow 重新挂到 bg_sun 之上。
   * 仅在优雅停止窗口内、且精灵被布局重建摘除后才有实际动作。
   * （main.ts 的调用顺序是 apply() → startForState()，执行到这里时
   *   bg_sun 已被重新装配，glow 处于无父状态）
   */
  private reattachBgSunGlow(): void {
    const glow = this.bgSunGlow;
    const bgSun = this.store.sprites.get('bg_sun');
    if (!glow || !bgSun || glow.parent) return;
    const parent = bgSun.parent;
    if (!parent) return;
    parent.addChild(glow);
    parent.setChildIndex(glow, parent.getChildIndex(bgSun) + 1);
  }

  /** 立即停止并做终态清理（等价旧 stopKind） */
  private stopKind(kind: LoopKind): void {
    const ps = this.playbacks.get(kind);
    if (ps) {
      ps.forEach((p) => p.cancel());
      this.playbacks.delete(kind);
    }

    if (kind === 'frames') {
      if (this.frameHandle) {
        this.frameHandle.cancel();
        this.frameHandle = null;
      }
      if (this.framesRestore) {
        this.framesRestore.sprite.texture = this.framesRestore.tex;
        this.framesRestore = null;
      }
    }
    if (kind === 'bubble') {
      const s = this.store.sprites.get('expr_rest_bubble');
      if (s) s.scale.set(1);
    }
    if (kind === 'pulse') {
      if (this.bgSunGlow) this.bgSunGlow.alpha = 0;
    }
  }
}
