/**
 * 可动画属性注册表
 *
 * 把「目标对象的一个可动画属性」抽象为访问器（PropertyAccessor）：
 * - Timeline 轨道只通过名称引用属性，不感知 PixiJS 细节
 * - 新增属性类型（如未来的纹理切换、滤镜参数）只需 registerProperty() 一项注册
 * - kind 决定插值方式：
 *     number —— 数值线性插值（x/y/scale/alpha/rotation…）
 *     color  —— RGB 通道插值（tint，JSON 值 '#FF9554' 或 0xFF9554）
 *     step   —— 阶梯保持不插值（visible 等开关量，段内保持段首值）
 */
import * as PIXI from 'pixi.js';

/** JSON 侧的属性值：数值或颜色字符串 */
export type PropValue = number | string;

export type PropertyKind = 'number' | 'color' | 'step';

export interface PropertyAccessor {
  readonly kind: PropertyKind;
  set(target: PIXI.DisplayObject, value: PropValue): void;
}

// ── 注册表 ──

const registry = new Map<string, PropertyAccessor>();

export function registerProperty(name: string, accessor: PropertyAccessor): void {
  if (registry.has(name)) {
    console.warn(`[anim:property] 覆盖已注册的属性: ${name}`);
  }
  registry.set(name, accessor);
}

export function getPropertyAccessor(name: string): PropertyAccessor | null {
  return registry.get(name) ?? null;
}

/** 列出全部已注册属性名（动画后台面板下拉框用） */
export function listPropertyNames(): string[] {
  return Array.from(registry.keys());
}

// ── 插值 ──

/** 解析颜色值：'#FF9554' / 'FF9554' / 0xFF9554 → [r, g, b] */
export function parseColor(value: PropValue): [number, number, number] {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else {
    const s = value.startsWith('#') ? value.slice(1) : value;
    n = parseInt(s, 16);
  }
  if (!Number.isFinite(n)) {
    console.warn(`[anim:property] 非法颜色值 ${String(value)}，回退白色`);
    n = 0xffffff;
  }
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** 按属性类别插值。step 不插值：段内恒为段首值，跨段瞬间跳变 */
export function interpolate(
  kind: PropertyKind,
  from: PropValue,
  to: PropValue,
  k: number
): PropValue {
  switch (kind) {
    case 'number': {
      const a = typeof from === 'number' ? from : parseFloat(from);
      const b = typeof to === 'number' ? to : parseFloat(to);
      return a + (b - a) * k;
    }
    case 'color': {
      const [r1, g1, b1] = parseColor(from);
      const [r2, g2, b2] = parseColor(to);
      const r = Math.round(r1 + (r2 - r1) * k);
      const g = Math.round(g1 + (g2 - g1) * k);
      const b = Math.round(b1 + (b2 - b1) * k);
      return (r << 16) | (g << 8) | b;
    }
    case 'step':
      return from;
  }
}

// ── 内置属性 ──

registerProperty('alpha', {
  kind: 'number',
  set: (t, v) => {
    t.alpha = Number(v);
  },
});

registerProperty('x', {
  kind: 'number',
  set: (t, v) => {
    t.x = Number(v);
  },
});

registerProperty('y', {
  kind: 'number',
  set: (t, v) => {
    t.y = Number(v);
  },
});

registerProperty('scaleX', {
  kind: 'number',
  set: (t, v) => {
    t.scale.x = Number(v);
  },
});

registerProperty('scaleY', {
  kind: 'number',
  set: (t, v) => {
    t.scale.y = Number(v);
  },
});

/** 等比缩放（X/Y 同步） */
registerProperty('scale', {
  kind: 'number',
  set: (t, v) => {
    t.scale.set(Number(v));
  },
});

registerProperty('rotation', {
  kind: 'number',
  set: (t, v) => {
    t.rotation = Number(v);
  },
});

/** 着色（乘法混合，只能变暗——精确亮色请用 recolor.colorize 孪生叠加，见交接文档） */
registerProperty('tint', {
  kind: 'color',
  set: (t, v) => {
    // tint 只在 Sprite 上存在；目标类型不符时防御性跳过
    if (t instanceof PIXI.Sprite) {
      t.tint = typeof v === 'number' ? v : parseInt(v.replace('#', ''), 16);
    } else {
      console.warn('[anim:property] tint 目标不是 Sprite，跳过');
    }
  },
});

/** 显隐开关：0=隐藏，非 0=显示（阶梯属性，不做中间插值） */
registerProperty('visible', {
  kind: 'step',
  set: (t, v) => {
    t.visible = Number(v) !== 0;
  },
});
