/**
 * 动画预设构建器 —— 常用编排的工厂函数
 *
 * 预设只生产 TimelineDef/TrackDef「数据」，不触碰场景对象：
 * - 参数（时长/幅度/缓动）全部暴露在函数签名上
 * - P5 动画后台面板编辑的正是这些参数生成的 JSON，改参数 = 改数据，不改引擎
 *
 * 包含：
 * - pinAt / unpin        变换中心设置（围绕画布任意点缩放）
 * - buildBounceTracks    Q弹弹动（需求文档"弹一下"，过渡/庆祝共用）
 * - buildCrossfadeTracks 表情淡入淡出（两个 alpha 轨道）
 */
import * as PIXI from 'pixi.js';
import { EasingSpec } from './easing';
import { TrackDef } from './timeline';

// ── 变换中心 ──

/**
 * 把对象的变换中心钉到画布坐标 (cx, cy)：之后的缩放/旋转围绕该点。
 * 适用于未设置 anchor 的容器（如图层组）；
 * 已设 anchor 的精灵（太阳光芒/bg_sun）天然以锚点为变换中心，无需调用。
 */
export function pinAt(obj: PIXI.DisplayObject, cx: number, cy: number): void {
  obj.pivot.set(cx, cy);
  obj.position.set(cx, cy);
}

/** 解除 pinAt（恢复默认原点，避免影响后续布局/命中表计算） */
export function unpin(obj: PIXI.DisplayObject): void {
  obj.pivot.set(0, 0);
  obj.position.set(0, 0);
}

// ── Q弹弹动 ──

/**
 * 弹动缩放中心（2026-07-31 用户定版 v2）：固定画布坐标 (282, 349)。
 * 注：文档原方案是"body 不透明区域底部中心程序自动检测"，
 * 用户验收后指定固定点；assets.measureOpaqueBbox 仍保留（P4 太阳动画用）。
 */
export const BOUNCE_ANCHOR = { x: 282, y: 349 };

export interface BounceOptions {
  /** 目标名（可多个，多层同步弹动） */
  target: string | string[];
  /** 总时长 ms（默认 480 = 6 态 × 80ms；按比例伸缩各态时间点） */
  duration?: number;
  /** 幅度倍率（默认 1 = 下表基准；偏移量按倍率缩放） */
  intensity?: number;
  /** 轨道延迟 ms */
  delay?: number;
}

/**
 * 挤压拉伸弹动序列（2026-08-01 用户定版 v6，中态加强到 20%）：
 * 横拉10%/纵压10% → 正常 → 横压20%/纵拉20% → 正常 → 横拉7%/纵压7% → 正常
 * 每态 60ms，总 360ms。统一 easeOutQuad 取脆感。
 * 表项：[时间点ms, scaleX, scaleY]
 */
const BOUNCE_PROFILE: Array<[number, number, number]> = [
  [0, 1.1, 0.9],
  [60, 1, 1],
  [120, 0.8, 1.2],
  [180, 1, 1],
  [240, 1.07, 0.93],
  [300, 1, 1],
  [360, 1, 1],
];
/** 弹动基准时长（profile 末态时间点，duration 选项按此比例伸缩） */
const BOUNCE_BASE_MS = 360;

export function buildBounceTracks(opts: BounceOptions): TrackDef[] {
  const duration = opts.duration ?? BOUNCE_BASE_MS;
  const amp = opts.intensity ?? 1;
  const scale = duration / BOUNCE_BASE_MS;
  const targets = Array.isArray(opts.target) ? opts.target : [opts.target];
  // intensity：以 1 为基准的偏移量按倍率缩放
  const keysX = BOUNCE_PROFILE.map(([t, x]) => ({
    at: Math.round(t * scale),
    value: 1 + (x - 1) * amp,
    easing: 'easeOutQuad' as const,
  }));
  const keysY = BOUNCE_PROFILE.map(([t, , y]) => ({
    at: Math.round(t * scale),
    value: 1 + (y - 1) * amp,
    easing: 'easeOutQuad' as const,
  }));
  return targets.flatMap((target) => [
    { target, property: 'scaleX', delay: opts.delay, keys: keysX },
    { target, property: 'scaleY', delay: opts.delay, keys: keysY },
  ]);
}

// ── 表情淡入淡出 ──

/**
 * 交叉淡入淡出轨道：from 1→0、to 0→1。
 * 注意：to 目标需先以 alpha=0 加入场景并注册，动画结束后由布局系统接管。
 */
export function buildCrossfadeTracks(
  from: string,
  to: string,
  duration: number,
  delay = 0
): TrackDef[] {
  return [
    {
      target: from,
      property: 'alpha',
      delay,
      keys: [
        { at: 0, value: 1, easing: 'easeInOutSine' },
        { at: duration, value: 0 },
      ],
    },
    {
      target: to,
      property: 'alpha',
      delay,
      keys: [
        { at: 0, value: 0, easing: 'easeInOutSine' },
        { at: duration, value: 1 },
      ],
    },
  ];
}
