/**
 * 目标注册表 + 动作注册表
 *
 * Timeline 是纯 JSON 数据，不持有任何场景对象引用：
 * - 轨道用「名称」引用场景对象 → TargetRegistry 解析为 PIXI.DisplayObject
 * - 事件用「名称」引用副作用  → ActionRegistry 解析为回调
 *
 * 两个注册表是「数据」与「场景」之间的唯一桥梁，好处：
 * - Timeline 定义可序列化（P5 动画后台面板直接编辑/保存预设）
 * - 布局切换时可动态注册临时目标（如过渡中用于淡入的新表情精灵），用完注销
 * - 同一份 Timeline 可在不同目标集合上重放（预览场景/正式场景）
 */
import * as PIXI from 'pixi.js';

// ── 目标注册表 ──

export class TargetRegistry {
  private map = new Map<string, PIXI.DisplayObject>();

  /**
   * 注册目标。同名覆盖是正常用法（如呼吸动画重建辉光精灵后重新注册），
   * 不告警；拼错名称会在 resolve/play 时以 warn 暴露。
   */
  register(name: string, obj: PIXI.DisplayObject): void {
    this.map.set(name, obj);
  }

  registerAll(entries: Record<string, PIXI.DisplayObject>): void {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, v);
  }

  /** 解析目标；未注册时告警并返回 null（编译期会丢弃对应轨道，不崩溃） */
  resolve(name: string): PIXI.DisplayObject | null {
    const obj = this.map.get(name) ?? null;
    if (!obj) console.warn(`[anim:targets] 未注册的目标: ${name}`);
    return obj;
  }

  /** 静默查询是否已注册（不告警；用于条件性添加轨道） */
  has(name: string): boolean {
    return this.map.has(name);
  }

  unregister(name: string): void {
    this.map.delete(name);
  }

  clear(): void {
    this.map.clear();
  }
}

// ── 动作注册表 ──

/** 事件动作回调（如播放音效、停止粒子生成） */
export type ActionFn = (args?: Record<string, unknown>) => void;

export class ActionRegistry {
  private map = new Map<string, ActionFn>();

  register(name: string, fn: ActionFn): void {
    if (this.map.has(name)) {
      console.warn(`[anim:actions] 覆盖已注册的动作: ${name}`);
    }
    this.map.set(name, fn);
  }

  /** 执行动作；未注册时告警跳过（防御性，不中断动画） */
  run(name: string, args?: Record<string, unknown>): void {
    const fn = this.map.get(name);
    if (!fn) {
      console.warn(`[anim:actions] 未注册的动作: ${name}`);
      return;
    }
    fn(args);
  }
}
