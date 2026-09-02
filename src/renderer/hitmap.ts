/**
 * 命中表生成 —— 合成当前布局的不透明像素蒙版
 * 发送给主进程用于点击穿透轮询。
 */
import { AssetStore, CANVAS_W, CANVAS_H, Bbox } from './assets';
import { LayoutConfig, ROCK_LAYER_KEYS } from './layout';
import { TIME_HIT_PAD, TIME_HIT_RADIUS, roundedRectContains } from './buttons';

/**
 * 把时间按钮的圆角矩形热区写入命中表。
 * 否则光标落在扩大后的热区时，主进程穿透轮询会把窗口判定为
 * 透明区域而忽略鼠标，点击直接穿透到桌面。
 */
function fillTimeButtonZones(
  hitmap: Uint8Array,
  store: AssetStore,
  btnKeys: string[]
): void {
  for (const key of btnKeys) {
    const bbox: Bbox | undefined = store.bboxes.get(key);
    if (!bbox) continue;
    const x1 = Math.max(0, bbox.x - TIME_HIT_PAD);
    const y1 = Math.max(0, bbox.y - TIME_HIT_PAD);
    const x2 = Math.min(CANVAS_W - 1, bbox.x + bbox.w - 1 + TIME_HIT_PAD);
    const y2 = Math.min(CANVAS_H - 1, bbox.y + bbox.h - 1 + TIME_HIT_PAD);
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if (roundedRectContains(x, y, bbox, TIME_HIT_PAD, TIME_HIT_RADIUS)) {
          hitmap[y * CANVAS_W + x] = 1;
        }
      }
    }
  }
}

export function generateHitmap(store: AssetStore, layout: LayoutConfig): Uint8Array {
  const c = document.createElement('canvas');
  c.width = CANVAS_W;
  c.height = CANVAS_H;
  const ctx = c.getContext('2d')!;

  const draw = (key: string): void => {
    const img = store.images.get(key);
    if (img) ctx.drawImage(img, 0, 0);
  };

  layout.bgKeys.forEach(draw);
  ROCK_LAYER_KEYS.forEach(draw);
  ['body_base', 'body_clockboard', 'body_hand', layout.stemKey].forEach(draw);
  layout.exprKeys.forEach(draw);
  // 数字区域（用代表性数字合成命中范围）
  ['num_mt_3', 'num_mo_0', 'ui_colon', 'num_st_0', 'num_so_0'].forEach(draw);
  layout.btnKeys.forEach(draw);

  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
  const hitmap = new Uint8Array(CANVAS_W * CANVAS_H);
  for (let i = 0; i < hitmap.length; i++) {
    hitmap[i] = data[i * 4 + 3] > 128 ? 1 : 0;
  }

  // 时间按钮热区外扩（与 buttons.ts hitTest 同参数）
  fillTimeButtonZones(hitmap, store, layout.btnKeys);

  return hitmap;
}
