/**
 * Timeline 动画引擎 —— 统一导出入口
 *
 * 模块组成：
 * - easing.ts    缓动函数库 + 注册表（内置常用缓动，支持 cubic-bezier 自定义）
 * - property.ts  可动画属性注册表（number/color/step 三类插值）
 * - targets.ts   目标/动作注册表（JSON 数据 ↔ 场景对象的桥梁）
 * - timeline.ts  Timeline 数据定义 + 校验 + 编译 + 求值
 * - player.ts    播放器（Playback 生命周期：cancel / finishAfterLoop / loop）
 * - particles.ts 粒子发射器（程序化动画基元，庆祝彩带）
 * - presets.ts   预设构建器（Q弹弹动 / 交叉淡入淡出 / 变换中心）
 *
 * 与旧基元 anime.ts 的关系：
 * - 本引擎构建在 anime.addTick 时钟之上，不修改 anime.ts
 * - anime.ts 的 tween/schedule/frameSwap/playFrameAnime 仍是合法基元
 *   （按钮点击动画、两帧轮播继续使用）；复杂编排一律走 Timeline
 *
 * 扩展方式（新增动画需求时对照此表，避免改引擎核心）：
 * - 新缓动     → registerEasing()
 * - 新属性类型 → registerProperty()
 * - 新时间点副作用 → ActionRegistry.register()
 * - 新常用编排 → presets.ts 加工厂函数
 */
export {
  registerEasing,
  resolveEasing,
  listEasingNames,
  cubicBezier,
} from './easing';
export type { EasingFn, EasingSpec } from './easing';

export {
  registerProperty,
  getPropertyAccessor,
  listPropertyNames,
  parseColor,
  interpolate,
} from './property';
export type { PropertyAccessor, PropertyKind, PropValue } from './property';

export { TargetRegistry, ActionRegistry } from './targets';
export type { ActionFn } from './targets';

export {
  validateTimeline,
  compileTimeline,
  evaluateTrack,
  evaluateTimeline,
} from './timeline';
export type {
  KeyframeDef,
  TrackDef,
  EventDef,
  TimelineDef,
  CompiledTimeline,
} from './timeline';

export { TimelinePlayer } from './player';
export type { Playback, PlaybackResult, PlayOptions } from './player';

export { ParticleEmitter } from './particles';
export type { ParticleEmitterDef, Range } from './particles';

export {
  BOUNCE_ANCHOR,
  pinAt,
  unpin,
  buildBounceTracks,
  buildCrossfadeTracks,
} from './presets';
export type { BounceOptions } from './presets';
