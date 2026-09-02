/**
 * Timeline 数据定义 + 校验 + 编译 + 求值
 *
 * 数据流：
 *   TimelineDef（纯 JSON，可序列化）
 *     → validateTimeline()  加载期严格校验，数据结构有问题尽早报错
 *     → compileTimeline()   解析目标/缓动为运行时引用（缺目标告警丢轨，不崩溃）
 *     → evaluateTimeline()  每帧求值：所有轨道在时刻 t 写属性
 *
 * 求值语义（务必保持稳定，动画表现依赖这些约定）：
 * - 轨道局部时间 tl = t - delay；tl < 0 时轨道不写值
 * - tl 在首关键帧之前 → 保持首帧值；末关键帧之后 → 保持末帧值
 *   （保证 t=0 起每一帧的画面都是确定的，重放无残影）
 * - 段内缓动取「段首关键帧」的 easing
 * - step 类属性不插值，段内恒为段首值
 */
import * as PIXI from 'pixi.js';
import { EasingFn, EasingSpec, resolveEasing } from './easing';
import {
  PropertyAccessor,
  PropValue,
  getPropertyAccessor,
  interpolate,
} from './property';
import { TargetRegistry } from './targets';

// ── JSON 数据定义 ──

export interface KeyframeDef {
  /** 轨道内绝对时间 ms（≥0，升序） */
  at: number;
  /** 目标值（数值或颜色 '#FF9554' / 0xFF9554） */
  value: PropValue;
  /** 到下一关键帧的缓动（默认 linear） */
  easing?: EasingSpec;
}

export interface TrackDef {
  /** TargetRegistry 中的目标名 */
  target: string;
  /** 属性注册表中的属性名 */
  property: string;
  keys: KeyframeDef[];
  /** 轨道起始延迟 ms（默认 0） */
  delay?: number;
}

export interface EventDef {
  /** 触发时间 ms（时间轴首次经过该点时触发一次；循环时每轮重置） */
  at: number;
  /** ActionRegistry 中的动作名 */
  action: string;
  args?: Record<string, unknown>;
}

export interface TimelineDef {
  name: string;
  /** 总时长 ms（一个循环周期的长度） */
  duration: number;
  tracks?: TrackDef[];
  events?: EventDef[];
}

// ── 编译产物 ──

export interface CompiledKey {
  at: number;
  value: PropValue;
  easing: EasingFn;
}

export interface CompiledTrack {
  accessor: PropertyAccessor;
  target: PIXI.DisplayObject;
  keys: CompiledKey[];
  delay: number;
}

export interface CompiledEvent {
  at: number;
  action: string;
  args?: Record<string, unknown>;
}

export interface CompiledTimeline {
  name: string;
  duration: number;
  tracks: CompiledTrack[];
  /** 按 at 升序 */
  events: CompiledEvent[];
}

// ── 校验 ──

/**
 * 加载期校验。数据非法时抛 Error（带 [anim:timeline] 前缀与动画名），
 * 让问题在 play() 调用点暴露，而不是在动画跑到一半时表现诡异。
 */
export function validateTimeline(def: TimelineDef): void {
  const tag = `[anim:timeline] "${def?.name ?? '?'}"`;
  if (!def || typeof def !== 'object') throw new Error(`${tag} 定义不是对象`);
  if (typeof def.name !== 'string' || def.name.length === 0) {
    throw new Error(`${tag} 缺少 name`);
  }
  if (typeof def.duration !== 'number' || !Number.isFinite(def.duration) || def.duration <= 0) {
    throw new Error(`${tag} duration 必须为正数，got ${String(def.duration)}`);
  }

  for (const [ti, track] of (def.tracks ?? []).entries()) {
    const ttag = `${tag} tracks[${ti}]`;
    if (typeof track.target !== 'string' || track.target.length === 0) {
      throw new Error(`${ttag} 缺少 target`);
    }
    const accessor = getPropertyAccessor(track.property);
    if (!accessor) throw new Error(`${ttag} 未注册的属性 "${track.property}"`);
    if (track.delay !== undefined && (track.delay < 0 || !Number.isFinite(track.delay))) {
      throw new Error(`${ttag} delay 必须 ≥ 0`);
    }
    if (!Array.isArray(track.keys) || track.keys.length === 0) {
      throw new Error(`${ttag} keys 不能为空`);
    }
    let prevAt = -1;
    for (const [ki, key] of track.keys.entries()) {
      const ktag = `${ttag}.keys[${ki}]`;
      if (typeof key.at !== 'number' || !Number.isFinite(key.at) || key.at < 0) {
        throw new Error(`${ktag} at 必须 ≥ 0`);
      }
      if (key.at < prevAt) throw new Error(`${ktag} at 必须升序`);
      prevAt = key.at;
      // 值类型与属性类别匹配（color 接受字符串/数字，其余要求数字）
      if (accessor.kind !== 'color' && typeof key.value !== 'number') {
        throw new Error(`${ktag} 属性 "${track.property}" 要求数值，got ${JSON.stringify(key.value)}`);
      }
    }
  }

  for (const [ei, ev] of (def.events ?? []).entries()) {
    const etag = `${tag} events[${ei}]`;
    if (typeof ev.at !== 'number' || ev.at < 0) throw new Error(`${etag} at 必须 ≥ 0`);
    if (typeof ev.action !== 'string' || ev.action.length === 0) {
      throw new Error(`${etag} 缺少 action`);
    }
  }
}

// ── 编译 ──

/**
 * 编译 Timeline：校验 → 解析目标与缓动。
 * 目标未注册的轨道告警后丢弃（其余轨道照常播放）；
 * 若校验抛错则数据结构本身有问题，交给调用方尽早发现。
 */
export function compileTimeline(
  def: TimelineDef,
  targets: TargetRegistry
): CompiledTimeline {
  validateTimeline(def);

  const tracks: CompiledTrack[] = [];
  for (const track of def.tracks ?? []) {
    const target = targets.resolve(track.target);
    if (!target) continue; // resolve 已告警
    tracks.push({
      accessor: getPropertyAccessor(track.property)!, // validate 已保证存在
      target,
      delay: track.delay ?? 0,
      keys: track.keys.map((k) => ({
        at: k.at,
        value: k.value,
        easing: resolveEasing(k.easing),
      })),
    });
  }

  const events: CompiledEvent[] = (def.events ?? [])
    .map((e) => ({ at: e.at, action: e.action, args: e.args }))
    .sort((a, b) => a.at - b.at);

  return { name: def.name, duration: def.duration, tracks, events };
}

// ── 求值 ──

/** 单轨道在时刻 t 求值并写属性（t 为时间轴时间 ms，内部处理 delay） */
export function evaluateTrack(track: CompiledTrack, t: number): void {
  const tl = t - track.delay;
  if (tl < 0) return;
  const keys = track.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];

  // 首帧之前保持首帧值：保证画面从 t=0 起确定
  if (tl <= first.at) {
    track.accessor.set(track.target, first.value);
    return;
  }
  // 末帧之后保持末帧值
  if (tl >= last.at) {
    track.accessor.set(track.target, last.value);
    return;
  }
  // 定位所在段（keys 已升序校验）
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].at <= tl) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const k = (tl - a.at) / (b.at - a.at);
  const eased = a.easing(k);
  track.accessor.set(
    track.target,
    interpolate(track.accessor.kind, a.value, b.value, eased)
  );
}

/** 整条 Timeline 在时刻 t 求值（事件不在此触发，由播放器负责） */
export function evaluateTimeline(tl: CompiledTimeline, t: number): void {
  for (const track of tl.tracks) evaluateTrack(track, t);
}
