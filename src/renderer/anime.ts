/**
 * 动画引擎基元
 *
 * - addTick / installTicker：帧回调注册表
 * - tween：通用插值动画（delay / loop / 循环边界回调）
 * - schedule：可取消的延时调度
 * - frameSwap：两帧循环切换
 * - playFrameAnime：一次性帧序列播放
 *
 * M3 呼吸动画、M5 过渡动画、M4 庆祝动画均基于此构建。
 */
import * as PIXI from 'pixi.js';

/** 每帧回调，返回 false 时自动移除 */
type TickFn = (dtMs: number) => boolean;

const tickers: TickFn[] = [];
let installed = false;

export function addTick(fn: TickFn): void {
  tickers.push(fn);
}

/** 挂接到 PixiJS ticker（只执行一次） */
export function installTicker(app: PIXI.Application): void {
  if (installed) return;
  installed = true;
  app.ticker.add(() => {
    const dt = app.ticker.deltaMS;
    for (let i = tickers.length - 1; i >= 0; i--) {
      if (!tickers[i](dt)) tickers.splice(i, 1);
    }
  });
}

// ── 句柄 ──

export interface AnimHandle {
  cancel: () => void;
}

// ── Tween ──

export interface TweenOpts {
  /** 单次时长 ms */
  duration: number;
  /** 起始延迟 ms */
  delay?: number;
  /** 无限循环 */
  loop?: boolean;
  /** 缓动函数（默认线性） */
  easing?: (t: number) => number;
  /** 每帧回调，k 为缓动后的 0..1 */
  onUpdate: (k: number) => void;
  /**
   * 循环边界回调（k 到达 1 时触发）：
   * 返回 false 则停止循环（此时 onUpdate(1) 已执行，处于"初始状态"）
   */
  onLoopEnd?: () => boolean;
  /** 结束回调（一次性完成或循环被终止时触发） */
  onDone?: () => void;
}

export function tween(opts: TweenOpts): AnimHandle {
  let elapsed = -(opts.delay ?? 0);
  let cancelled = false;
  const easing = opts.easing ?? ((t: number) => t);

  addTick((dt) => {
    if (cancelled) return false;
    elapsed += dt;
    if (elapsed < 0) return true;
    const k = Math.min(elapsed / opts.duration, 1);
    opts.onUpdate(easing(k));
    if (k >= 1) {
      if (opts.loop) {
        if (opts.onLoopEnd && !opts.onLoopEnd()) {
          opts.onDone?.();
          return false;
        }
        elapsed = 0;
        return true;
      }
      opts.onDone?.();
      return false;
    }
    return true;
  });

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

// ── 延时调度 ──

export function schedule(delayMs: number, fn: () => void): AnimHandle {
  let elapsed = 0;
  let cancelled = false;
  addTick((dt) => {
    if (cancelled) return false;
    elapsed += dt;
    if (elapsed >= delayMs) {
      fn();
      return false;
    }
    return true;
  });
  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

// ── 两帧循环切换 ──

export function frameSwap(
  sprite: PIXI.Sprite,
  texA: PIXI.Texture,
  texB: PIXI.Texture,
  frameMs: number
): AnimHandle {
  let elapsed = 0;
  let showB = false;
  let cancelled = false;
  addTick((dt) => {
    if (cancelled) return false;
    elapsed += dt;
    if (elapsed >= frameMs) {
      elapsed = 0;
      showB = !showB;
      sprite.texture = showB ? texB : texA;
    }
    return true;
  });
  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

// ── 一次性帧动画 ──

/**
 * 播放一次性帧动画
 *
 * @param container 目标容器
 * @param textures  帧序列
 * @param cx        中心点 x（画布坐标）
 * @param cy        中心点 y（画布坐标）
 * @param fps       播放帧率
 * @param scale     缩放（默认 1）
 * @param slowFactor 慢放倍数（默认 1，2 = 慢一倍）
 * @param onDone    播放完毕回调
 */
export function playFrameAnime(
  container: PIXI.Container,
  textures: PIXI.Texture[],
  cx: number,
  cy: number,
  fps: number,
  scale = 1,
  slowFactor = 1,
  onDone?: () => void
): void {
  if (textures.length === 0) return;
  const sprite = new PIXI.Sprite(textures[0]);
  sprite.anchor.set(0.5);
  sprite.position.set(cx, cy);
  sprite.scale.set(scale);
  container.addChild(sprite);

  const frameMs = (1000 / fps) * slowFactor;
  let elapsed = 0;
  let frame = 0;

  addTick((dt) => {
    elapsed += dt;
    const f = Math.floor(elapsed / frameMs);
    if (f >= textures.length) {
      container.removeChild(sprite);
      sprite.destroy();
      onDone?.();
      return false;
    }
    if (f !== frame) {
      frame = f;
      sprite.texture = textures[f];
    }
    return true;
  });
}
