/**
 * 粒子发射器 —— 程序化动画基元（庆祝彩带等）
 *
 * 需求来源（庆祝动画）：
 * - 彩带从上方不断出现，像落叶那样左右飘落（正弦摇摆 + 旋转）
 * - 四色：E880F1 / 8FC9FF / FF858E / 65DD6C
 * - 时间窗由使用方控制：生成窗口（1.5s~3s）、整体淡出（4.5s~6s）
 *
 * 设计说明：
 * - 发射器只负责「生成 + 运动 + 生命周期」，整体透明度变化不归它管——
 *   把 emitter.container 注册为 Timeline 目标，用普通 alpha 轨道做整体淡出
 *   （引擎各件正交组合，不在粒子系统里内置时间轴逻辑）
 * - 纹理全实例共享一张白色小矩形（tint 上色），每粒子只建一个 Sprite
 * - 生成停止后存活粒子继续走完生命周期；全部消亡后帧回调自动摘除
 */
import * as PIXI from 'pixi.js';
import { addTick } from '../anime';
import { CANVAS_H } from '../assets';

export interface Range {
  min: number;
  max: number;
}

export interface ParticleEmitterDef {
  /** 颜色池（十六进制数），每粒子随机取一色 */
  colors: number[];
  /**
   * 生成区域：默认顶部一条水平线段（y 固定）；
   * h > 0 时扩展为矩形区域（y ∈ [y, y+h] 随机）——用于"从某区域喷出"的粒子源
   */
  area: { x: number; y: number; w: number; h?: number };
  /** start() 后延迟多少 ms 开始生成（默认 0） */
  spawnDelay?: number;
  /** 生成窗口长度 ms（窗口过后自动停止生成；burstCount 模式下忽略） */
  spawnDuration: number;
  /** 生成速率：个/秒（burstCount 模式下忽略） */
  ratePerSec: number;
  /**
   * 一次性大量发射（可选）：到达 spawnDelay 时瞬间生成 N 个粒子，
   * 之后不再生成（ratePerSec/spawnDuration 被忽略）。用于 firework 爆点式喷溅。
   */
  burstCount?: number;
  /** 彩带条尺寸（像素，基准纹理 4×8 的缩放目标） */
  width: Range;
  height: Range;
  /** 尺寸随机倍率（默认 1）：最终尺寸 = 基准尺寸 × 倍率（如 100%~250% → {1, 2.5}） */
  sizeScale?: Range;
  /** 速度随机倍率（默认 1）：最终速度 = 基准速度 × 倍率（如 50%~120% → {0.5, 1.2}） */
  speedScale?: Range;
  /** 顶部淡入区高度 px（默认 0 = 不淡入）：粒子 y∈[0, h] 内 alpha 线性 0→1 */
  fadeInZonePx?: number;
  /**
   * 初速度喷射（可选）：粒子以 (dirX, dirY) 单位方向、随机初速度喷出，
   * decayMs 内线性衰减到 0（之后正常下落）。用于 firework 定向喷溅。
   * jitterDeg：每粒子方向随机偏转角度上限（±jitter°，0 关闭）
   * speedJitter：初速度随机因子范围（默认 0.9~1.1，逐粒子乘算）
   */
  burst?: {
    dirX: number;
    dirY: number;
    speed: Range;
    decayMs: number;
    jitterDeg?: number;
    speedJitter?: Range;
  };
  /** 下落速度 px/s */
  fallSpeed: Range;
  /**
   * 摇摆渐入（可选）：粒子生成后 delayMs 内不摇摆，
   * 之后 rampMs 内摇摆幅度 0%→100% 线性渐入（默认 undefined = 生成即全幅摇摆）
   */
  swayRamp?: { delayMs: number; rampMs: number };
  /** 左右摇摆：振幅 px / 频率 Hz（落叶感来源） */
  swayAmp: Range;
  swayFreq: Range;
  /** 旋转速度 度/s（可为负=反向） */
  rotSpeed: Range;
  /** 单个粒子寿命 ms（超时强制消亡，兜底防滞留） */
  lifeMs: Range;
}

interface Particle {
  sprite: PIXI.Sprite;
  x0: number; // 基准横坐标（摇摆围绕它）
  y: number;
  vy: number; // px/s
  swayAmp: number;
  swayFreq: number;
  phase: number; // 摇摆初相
  rotSpeed: number; // 弧度/s
  age: number; // ms
  life: number; // ms
  /** 喷射位移累积（burst 用） */
  bx: number;
  by: number;
  /** 喷射初速度（px/s，随时间线性衰减） */
  bvx: number;
  bvy: number;
  /** 本粒子的喷射衰减时长（burst.decayMs × 0.9~1.1 随机） */
  decayMs: number;
}

function rand(r: Range): number {
  return r.min + Math.random() * (r.max - r.min);
}

// ── 共享纹理 ──
// 白色 4×8 矩形：tint 上色为任意彩带色，scale 调整尺寸。
// 像素风格下矩形彩带条正合适，无需美术素材。
const RIBBON_W = 4;
const RIBBON_H = 8;
let ribbonTexture: PIXI.Texture | null = null;

function getRibbonTexture(): PIXI.Texture {
  if (!ribbonTexture) {
    const c = document.createElement('canvas');
    c.width = RIBBON_W;
    c.height = RIBBON_H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, RIBBON_W, RIBBON_H);
    ribbonTexture = PIXI.Texture.from(c);
  }
  return ribbonTexture;
}

export class ParticleEmitter {
  /** 粒子容器：可注册为 Timeline 目标做整体淡出/移动 */
  readonly container: PIXI.Container;

  private particles: Particle[] = [];
  private spawning = false;
  private elapsed = 0;
  private spawnAcc = 0;
  private ticking = false;
  private destroyed = false;

  constructor(
    private def: ParticleEmitterDef,
    parent: PIXI.Container
  ) {
    this.container = new PIXI.Container();
    this.container.name = 'particle-emitter';
    parent.addChild(this.container);
  }

  /** 开始生成（内部按 spawnDelay/spawnDuration 自动管理生成窗口） */
  start(): void {
    if (this.destroyed || this.spawning) return;
    this.spawning = true;
    this.ensureTick();
  }

  /** 停止生成；存活粒子继续走完各自生命 */
  stopSpawning(): void {
    this.spawning = false;
  }

  get aliveCount(): number {
    return this.particles.length;
  }

  /** 立即清场并销毁容器（播放结束/状态切换时调用） */
  destroy(): void {
    this.destroyed = true;
    for (const p of this.particles) p.sprite.destroy();
    this.particles = [];
    this.container.destroy({ children: true });
  }

  private ensureTick(): void {
    if (!this.ticking && !this.destroyed) {
      this.ticking = true;
      addTick(this.tick);
    }
  }

  private tick = (dt: number): boolean => {
    if (this.destroyed) {
      this.ticking = false;
      return false;
    }
    this.elapsed += dt;

    // ── 生成窗口 ──
    const delay = this.def.spawnDelay ?? 0;
    if (this.spawning && this.def.burstCount) {
      // 一次性大量发射：到达 spawnDelay 瞬间全量生成，之后停止
      if (this.elapsed >= delay) {
        for (let n = 0; n < this.def.burstCount; n++) this.spawn();
        this.spawning = false;
      }
    } else {
      const inWindow =
        this.spawning &&
        this.elapsed >= delay &&
        this.elapsed <= delay + this.def.spawnDuration;
      if (inWindow) {
        this.spawnAcc += (dt / 1000) * this.def.ratePerSec;
        while (this.spawnAcc >= 1) {
          this.spawnAcc -= 1;
          this.spawn();
        }
      }
    }

    // ── 粒子运动 ──
    const fadeZone = this.def.fadeInZonePx ?? 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      p.y += (p.vy * dt) / 1000;
      // 喷射初速度：本粒子 decayMs 内线性衰减到 0
      if ((p.bvx !== 0 || p.bvy !== 0) && p.age < p.decayMs) {
        const k = 1 - p.age / p.decayMs;
        p.bx += (p.bvx * k * dt) / 1000;
        p.by += (p.bvy * k * dt) / 1000;
      }
      // 落叶式摇摆：x = x0 + sin(2πf·t + φ)·A·ramp（ramp = 摇摆渐入系数 0→1）
      let swayMul = 1;
      if (this.def.swayRamp) {
        const { delayMs, rampMs } = this.def.swayRamp;
        swayMul = Math.max(0, Math.min(1, (p.age - delayMs) / rampMs));
      }
      const sway =
        Math.sin((p.age / 1000) * p.swayFreq * Math.PI * 2 + p.phase) * p.swayAmp * swayMul;
      p.sprite.position.set(p.x0 + sway + p.bx, p.y + p.by);
      p.sprite.rotation += (p.rotSpeed * dt) / 1000;
      // 顶部淡入区：y∈[0, fadeZone] 内 alpha 线性爬升，区外恒 1
      if (fadeZone > 0) {
        p.sprite.alpha = Math.max(0, Math.min(1, p.y / fadeZone));
      }

      // 消亡：寿命到期或落出画布下缘
      if (p.age >= p.life || p.y > CANVAS_H + 20) {
        this.container.removeChild(p.sprite);
        p.sprite.destroy();
        this.particles.splice(i, 1);
      }
    }

    // 全部结束 → 自动摘除帧回调（可再次 start 复活）
    if (!this.spawning && this.particles.length === 0) {
      this.ticking = false;
      return false;
    }
    return true;
  };

  private spawn(): void {
    const d = this.def;
    const sizeMul = d.sizeScale ? rand(d.sizeScale) : 1;
    const speedMul = d.speedScale ? rand(d.speedScale) : 1;
    const sprite = new PIXI.Sprite(getRibbonTexture());
    sprite.anchor.set(0.5);
    sprite.tint = d.colors[Math.floor(Math.random() * d.colors.length)];
    sprite.scale.set((rand(d.width) * sizeMul) / RIBBON_W, (rand(d.height) * sizeMul) / RIBBON_H);
    const x0 = d.area.x + Math.random() * d.area.w;
    const y0 = d.area.y + (d.area.h ? Math.random() * d.area.h : 0);
    sprite.position.set(x0, y0);
    this.container.addChild(sprite);

    // 喷射初速度（无 burst 配置则为 0）；方向按 jitterDeg 随机偏转，
    // 速度乘 speedJitter 随机因子、衰减时长乘 0.9~1.1 随机
    let bvx = 0;
    let bvy = 0;
    let decayMs = 0;
    if (d.burst) {
      const jitter = d.burst.jitterDeg ?? 0;
      const theta =
        (((Math.random() * 2 - 1) * jitter * Math.PI) / 180) || 0;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const speed = rand(d.burst.speed) * rand(d.burst.speedJitter ?? { min: 0.9, max: 1.1 });
      bvx = (d.burst.dirX * cos - d.burst.dirY * sin) * speed;
      bvy = (d.burst.dirX * sin + d.burst.dirY * cos) * speed;
      decayMs = d.burst.decayMs * (0.9 + Math.random() * 0.2);
    }
    this.particles.push({
      sprite,
      x0,
      y: y0,
      vy: rand(d.fallSpeed) * speedMul,
      swayAmp: rand(d.swayAmp),
      swayFreq: rand(d.swayFreq),
      phase: Math.random() * Math.PI * 2,
      rotSpeed: (rand(d.rotSpeed) * Math.PI) / 180,
      age: 0,
      life: rand(d.lifeMs),
      bx: 0,
      by: 0,
      bvx,
      bvy,
      decayMs,
    });
  }
}
