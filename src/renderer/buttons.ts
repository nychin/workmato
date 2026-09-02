/**
 * 按钮系统 —— 三类行为
 *
 * time（时间按钮：start/pause/Reset/continue/rest）
 *   悬停放大 15%（bbox 中心缩放），按下回到正常大小并播放
 *   点击帧动画（24fps，中心对齐按钮 bbox 中心），
 *   点击事件 0.1s 后按钮消失并触发切换。
 * icon（蜗牛/番茄蒂/窗口按钮）
 *   悬停缩小 10%，按下放大到 110%，松开后缓动回正常大小。
 *   点击后的当前悬停会被抑制，鼠标移出再移入后才重新缩小。
 * stealth（rock_button 鞭策彩蛋钮）
 *   可点击，无任何视觉反馈。
 */
import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H, Bbox } from './assets';
import { playFrameAnime } from './anime';

export type ButtonBehavior = 'time' | 'icon' | 'stealth';

export interface ButtonDef {
  key: string;
  action: string;
  behavior: ButtonBehavior;
}

export const BUTTON_DEFS: Record<string, ButtonDef> = {
  btn_start: { key: 'btn_start', action: 'start', behavior: 'time' },
  btn_pause: { key: 'btn_pause', action: 'pause', behavior: 'time' },
  btn_reset: { key: 'btn_reset', action: 'reset', behavior: 'time' },
  btn_continue: { key: 'btn_continue', action: 'continue', behavior: 'time' },
  btn_rest: { key: 'btn_rest', action: 'rest', behavior: 'time' },
  rock_close: { key: 'rock_close', action: 'close', behavior: 'icon' },
  rock_billboard: { key: 'rock_billboard', action: 'taskflow', behavior: 'stealth' },
  rock_minimize: { key: 'rock_minimize', action: 'minimize', behavior: 'icon' },
  rock_snail: { key: 'rock_snail', action: 'snail', behavior: 'icon' },
  rock_button: { key: 'rock_button', action: 'rockButton', behavior: 'stealth' },
  body_stem_down: { key: 'body_stem_down', action: 'stem', behavior: 'icon' },
  body_stem_up: { key: 'body_stem_up', action: 'stem', behavior: 'icon' },
};

/** 石头组中常驻的可交互按钮 */
export const ROCK_INTERACTIVE_KEYS = [
  'rock_close',
  'rock_billboard',
  'rock_minimize',
  'rock_snail',
  'rock_button',
];

export interface TrackedButton {
  def: ButtonDef;
  sprite: PIXI.Sprite;
  mask: Uint8Array;
  bbox: Bbox;
  isHovered: boolean;
  isPressed: boolean;
}

const CLICK_ANIME_FPS = 24;
const ICON_RETURN_DURATION_MS = 140;

/**
 * 时间按钮热区：bbox 外扩一圈的圆角矩形
 * （像素级命中不方便；pause 这类中空按钮也要求中空处可点。
 * 注意：hitmap.ts 的穿透命中表使用同一组参数，必须保持同步）
 */
export const TIME_HIT_PAD = 6;
export const TIME_HIT_RADIUS = 6;

/** 点是否落在 bbox 外扩 pad 的圆角矩形内 */
export function roundedRectContains(
  x: number,
  y: number,
  bbox: Bbox,
  pad: number,
  radius: number
): boolean {
  const rx = bbox.x - pad;
  const ry = bbox.y - pad;
  const rw = bbox.w + pad * 2;
  const rh = bbox.h + pad * 2;
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  // 四个圆角区域单独判定
  const cx1 = rx + radius;
  const cx2 = rx + rw - radius;
  const cy1 = ry + radius;
  const cy2 = ry + rh - radius;
  const inCorner =
    (x < cx1 && y < cy1) ||
    (x > cx2 && y < cy1) ||
    (x < cx1 && y > cy2) ||
    (x > cx2 && y > cy2);
  if (!inCorner) return true;
  const nx = Math.max(cx1, Math.min(x, cx2));
  const ny = Math.max(cy1, Math.min(y, cy2));
  return (x - nx) * (x - nx) + (y - ny) * (y - ny) <= radius * radius;
}

export class ButtonController {
  private tracked: TrackedButton[] = [];
  private hovered: TrackedButton | null = null;
  private pressed: TrackedButton | null = null;
  private hoverSuppressedKey: string | null = null;
  private iconReturnFrame: number | null = null;
  private iconReturnSprite: PIXI.Sprite | null = null;
  private locked = false;

  /** 过渡动画播放期间锁定：点击/悬停均不产生任何反馈 */
  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) {
      this.cancelIconReturnAnimation(true);
      this.hoverSuppressedKey = null;
      this.hovered = null;
      this.pressed = null;
    }
  }

  constructor(
    private fxContainer: PIXI.Container,
    private animeTextures: PIXI.Texture[],
    private dispatch: (action: string) => void
  ) {}

  /** 状态切换后重建追踪列表 */
  setTracked(list: TrackedButton[]): void {
    this.cancelIconReturnAnimation(true);
    this.tracked = list;
    this.hoverSuppressedKey = null;
    this.hovered = null;
    this.pressed = null;
  }

  hitTest(x: number, y: number): TrackedButton | null {
    // 1) 时间按钮：圆角矩形热区；continue/reset 相邻区域重叠时
    //    取 bbox 中心距离最近者，避免互相冲突
    let best: TrackedButton | null = null;
    let bestDist = Infinity;
    for (const tb of this.tracked) {
      if (tb.def.behavior !== 'time') continue;
      if (!roundedRectContains(x, y, tb.bbox, TIME_HIT_PAD, TIME_HIT_RADIUS)) continue;
      const cx = tb.bbox.x + tb.bbox.w / 2;
      const cy = tb.bbox.y + tb.bbox.h / 2;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = tb;
      }
    }
    if (best) return best;

    // 2) 蜗牛/蘑菇/彩蛋钮：像素蒙版精确命中
    for (let i = this.tracked.length - 1; i >= 0; i--) {
      const tb = this.tracked[i];
      if (tb.def.behavior === 'time') continue;
      if (tb.def.key === 'rock_billboard' && (x < 129 || x > 204)) continue;
      const idx = y * CANVAS_W + x;
      if (idx >= 0 && idx < tb.mask.length && tb.mask[idx] === 1) return tb;
    }
    return null;
  }

  onHover(x: number, y: number): void {
    if (this.locked) return;
    const hit = this.hitTest(x, y);
    const suppressHover =
      hit?.def.behavior === 'icon' && hit.def.key === this.hoverSuppressedKey;

    // 只有鼠标真正离开刚点击的按钮，才允许下一次移入重新触发缩小。
    if (this.hoverSuppressedKey && !suppressHover) {
      this.hoverSuppressedKey = null;
    }
    if (hit === this.hovered) return;
    if (this.hovered) {
      const prev = this.hovered;
      prev.isHovered = false;
      if (!prev.isPressed) this.resetVisual(prev);
    }
    this.hovered = hit;
    if (hit) {
      hit.isHovered = true;
      if (!hit.isPressed) {
        if (suppressHover) this.resetVisual(hit);
        else this.applyHoverVisual(hit);
      }
    }
    this.dispatch(`hover:${hit?.def.action ?? 'none'}`);
  }

  /** 返回 true 表示命中按钮（调用方不进入拖拽） */
  onPress(x: number, y: number): boolean {
    if (this.locked) return true;
    const hit = this.hitTest(x, y);
    if (!hit) return false;
    this.pressed = hit;
    hit.isPressed = true;
    if (hit.def.behavior === 'time') {
      // 回到正常大小 + 播放点击帧动画
      hit.sprite.scale.set(1.0);
      this.playClickAnime(hit);
    } else if (hit.def.behavior === 'icon') {
      this.cancelIconReturnAnimation(false, hit.sprite);
      hit.sprite.scale.set(1.1);
      hit.sprite.tint = 0xffffff;
    }
    // stealth：无任何反馈
    return true;
  }

  onRelease(x: number, y: number): void {
    if (this.locked) return;
    const pressed = this.pressed;
    if (!pressed) return;
    this.pressed = null;
    pressed.isPressed = false;

    const hit = this.hitTest(x, y);
    if (hit !== pressed) {
      // 移出按钮松开：取消点击
      this.resetVisual(pressed);
      if (this.hovered === pressed) this.applyHoverVisual(pressed);
      return;
    }

    if (pressed.def.behavior === 'time') {
      // 立即触发切换（点击动画在 fx 层继续播完）
      this.dispatch(pressed.def.action);
    } else if (pressed.def.behavior === 'icon') {
      this.dispatch(pressed.def.action);

      // stem 操作会在 down/up 两个资源之间切换，按 action 接续到切换后的按钮。
      const current =
        this.tracked.find(tb => tb.def.key === pressed.def.key) ??
        this.tracked.find(
          tb => tb.def.behavior === 'icon' && tb.def.action === pressed.def.action
        ) ??
        pressed;
      this.hoverSuppressedKey = current.def.key;
      this.hovered = current;
      current.isHovered = true;
      this.animateIconToRest(current.sprite);
    } else {
      this.dispatch(pressed.def.action);
      this.resetVisual(pressed);
      if (this.hovered === pressed) this.applyHoverVisual(pressed);
    }
  }

  private applyHoverVisual(tb: TrackedButton): void {
    this.cancelIconReturnAnimation(false, tb.sprite);
    if (tb.def.behavior === 'time') {
      tb.sprite.scale.set(1.15);
    } else if (tb.def.behavior === 'icon') {
      tb.sprite.scale.set(0.9);
      tb.sprite.tint = 0xffffff;
    }
  }

  private resetVisual(tb: TrackedButton): void {
    this.cancelIconReturnAnimation(false, tb.sprite);
    tb.sprite.scale.set(1);
    tb.sprite.tint = 0xffffff;
  }

  private animateIconToRest(sprite: PIXI.Sprite): void {
    this.cancelIconReturnAnimation(true);
    this.iconReturnSprite = sprite;
    sprite.scale.set(1.1);
    sprite.tint = 0xffffff;
    const startedAt = performance.now();

    const tick = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / ICON_RETURN_DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      sprite.scale.set(1.1 - eased * 0.1);
      if (progress < 1) {
        this.iconReturnFrame = requestAnimationFrame(tick);
      } else {
        sprite.scale.set(1);
        this.iconReturnFrame = null;
        this.iconReturnSprite = null;
      }
    };

    this.iconReturnFrame = requestAnimationFrame(tick);
  }

  private cancelIconReturnAnimation(reset: boolean, sprite?: PIXI.Sprite): void {
    if (sprite && this.iconReturnSprite !== sprite) return;
    if (this.iconReturnFrame !== null) cancelAnimationFrame(this.iconReturnFrame);
    if (reset && this.iconReturnSprite) this.iconReturnSprite.scale.set(1);
    this.iconReturnFrame = null;
    this.iconReturnSprite = null;
  }

  private playClickAnime(tb: TrackedButton): void {
    const cx = tb.bbox.x + tb.bbox.w / 2;
    const cy = tb.bbox.y + tb.bbox.h / 2;
    playFrameAnime(this.fxContainer, this.animeTextures, cx, cy, CLICK_ANIME_FPS);
  }

  /**
   * 把精灵锚点设置为不透明像素 bbox 中心。
   * 修复悬停缩放时按钮往左上漂移的问题
   * （此前缩放围绕整张 491×407 纹理的左上角原点）。
   */
  static anchorAtBboxCenter(sprite: PIXI.Sprite, bbox: Bbox): void {
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    sprite.anchor.set(cx / CANVAS_W, cy / CANVAS_H);
    sprite.position.set(cx, cy);
  }
}
