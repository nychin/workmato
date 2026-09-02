/**
 * 缓动函数库 + 注册表
 *
 * 设计目标：
 * - Timeline JSON 中通过「名称」引用缓动（可序列化，供 P5 动画后台面板编辑）
 * - 支持 CSS 风格三次贝塞尔自定义（对应需求文档的"贝塞尔自定义"选项）
 * - 新缓动通过 registerEasing() 扩展，无需改动引擎其他部分
 *
 * 使用方式（JSON 中）：
 *   "easing": "easeOutCirc"                —— 注册名
 *   "easing": { "bezier": [0.25, 0.1, 0.25, 1] }  —— 自定义贝塞尔
 */

/**
 * 缓动函数：输入线性进度 t∈[0,1]，输出缓动后的「插值比例」。
 * ⚠️ 约定：输出恒为 0→1（引擎乘以值域差还原为属性值）。
 *    即使是下降段（如 2→1），缓动也必须从 0 递增到 1，
 *    切勿返回"值的下降形状"——会导致段首跳变 + 重复上升。
 */
export type EasingFn = (t: number) => number;

/**
 * JSON 中的缓动描述：
 * - string：注册表中的名称（如 'easeOutCirc'）
 * - { bezier: [x1, y1, x2, y2] }：CSS cubic-bezier 参数
 * - 缺省：线性
 */
export type EasingSpec = string | { bezier: [number, number, number, number] };

// ── 注册表 ──

const registry = new Map<string, EasingFn>();

/** 注册新缓动（重复注册会覆盖并告警，便于调试预设冲突） */
export function registerEasing(name: string, fn: EasingFn): void {
  if (registry.has(name)) {
    console.warn(`[anim:easing] 覆盖已注册的缓动: ${name}`);
  }
  registry.set(name, fn);
}

/**
 * 把 JSON 缓动描述解析为函数。
 * 未知名称不抛错（防御性），回退线性并告警——动画跑歪好过动画崩溃。
 */
export function resolveEasing(spec?: EasingSpec): EasingFn {
  if (spec === undefined) return linear;
  if (typeof spec === 'string') {
    const fn = registry.get(spec);
    if (!fn) {
      console.warn(`[anim:easing] 未知缓动 "${spec}"，回退 linear`);
      return linear;
    }
    return fn;
  }
  if (typeof spec === 'object' && Array.isArray(spec.bezier)) {
    return cubicBezier(spec.bezier[0], spec.bezier[1], spec.bezier[2], spec.bezier[3]);
  }
  console.warn('[anim:easing] 非法缓动描述，回退 linear');
  return linear;
}

/** 列出全部已注册缓动名（动画后台面板下拉框用） */
export function listEasingNames(): string[] {
  return Array.from(registry.keys());
}

// ── 内置缓动 ──

const linear: EasingFn = (t) => t;

/**
 * 生成 CSS cubic-bezier(x1, y1, x2, y2) 缓动函数。
 * 标准实现：Newton-Raphson 迭代求解，失败时二分回退（保证数值稳定）。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  // 三次贝塞尔多项式系数：B(t) = a·t³ + b·t² + c·t
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton-Raphson：从 t=x 出发迭代逼近 sampleX(t)=x
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break; // 导数过小，退出迭代走二分
      t -= err / d;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
    }
    // 二分回退（保证收敛）
    let lo = 0;
    let hi = 1;
    t = x;
    while (hi - lo > 1e-6) {
      if (sampleX(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

// ── 注册内置缓动 ──

registerEasing('linear', linear);

// 二次：最常见的 Q 弹分段缓动
registerEasing('easeInQuad', (t) => t * t);
registerEasing('easeOutQuad', (t) => t * (2 - t));
registerEasing('easeInOutQuad', (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t));

// 三次：更强的加减速感
registerEasing('easeInCubic', (t) => t * t * t);
registerEasing('easeOutCubic', (t) => --t * t * t + 1);
registerEasing('easeInOutCubic', (t) =>
  t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1
);

// 圆形：极端先快后慢（需求文档"类似半圆形"，庆祝 firework 放大用）
registerEasing('easeOutCirc', (t) => Math.sqrt(1 - (t - 1) * (t - 1)));
registerEasing('easeInCirc', (t) => 1 - Math.sqrt(1 - t * t));

// 回弹：过冲后归位（弹动动画可选风格）
const BACK_C1 = 1.70158;
registerEasing('easeOutBack', (t) => {
  const u = t - 1;
  return 1 + (BACK_C1 + 1) * u * u * u + BACK_C1 * u * u;
});
registerEasing('easeInBack', (t) => (BACK_C1 + 1) * t * t * t - BACK_C1 * t * t);

// 正弦：最柔和的渐变（透明度淡入淡出的默认推荐）
registerEasing('easeInOutSine', (t) => -(Math.cos(Math.PI * t) - 1) / 2);

// 正弦半波：sin(u·π/2) 与 1-cos(u·π/2)。
// 两段拼接（升=Out、降=In）在数学上严格等于 sin(k·π) 脉冲波——呼吸动画迁移用
registerEasing('easeOutSine', (t) => Math.sin((t * Math.PI) / 2));
registerEasing('easeInSine', (t) => 1 - Math.cos((t * Math.PI) / 2));

// smoothstep：t²(3-2t)，两端导数为零（延时状态同步呼吸的原始缓动）
registerEasing('easeInOutSmooth', (t) => t * t * (3 - 2 * t));

// 弹性：Q 弹一击完成（备选，弹动预设默认用多关键帧而非弹性缓动）
registerEasing('easeOutElastic', (t) => {
  if (t === 0 || t === 1) return t;
  const p = 0.3;
  return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (2 * Math.PI)) / p) + 1;
});
