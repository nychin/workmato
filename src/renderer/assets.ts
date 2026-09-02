/**
 * 资产清单 + 加载 + 蒙版/包围盒提取
 *
 * 素材源：D:\AI\tomato_asset\tomato_UI_asset（只读，已拷贝至 static）
 */
import * as PIXI from 'pixi.js';

export const CANVAS_W = 491;
export const CANVAS_H = 407;
const ASSET_BASE = './tomato_UI_asset';

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── 素材清单 ──
export const ASSET_PATHS: Record<string, string> = {
  // 05 背景
  bg_sun: '05_background/background_sun.png',
  bg_cloud_01: '05_background/background_cloud_01.png',
  bg_cloud_02: '05_background/background_cloud_02.png',
  bg_night_sky: '05_background/background_night_sky.png',
  bg_night_moon: '05_background/background_night_moon.png',
  bg_night_starlight: '05_background/background_night_starlight.png',
  bg_night_moonlight: '05_background/background_night_moonlight.png',
  // 04 石头组
  rock_close: '04_rock/mushroom_close.png',
  rock_base: '04_rock/rock.png',
  rock_billboard: '04_rock/billboard.png',
  rock_billboard_hover: '04_rock/billboard_02.png',
  rock_minimize: '04_rock/mushroom_minimize.png',
  rock_button: '04_rock/rock_button.png',
  rock_snail: '04_rock/snail.png',
  rock_snail_rage: '04_rock/snail_rage.png',
  // 03 番茄身体
  body_base: '03_tomato_body/tomato_body.png',
  body_clockboard: '03_tomato_body/tomato_clockboard.png',
  body_hand: '03_tomato_body/tomato_hand.png',
  body_stem_down: '03_tomato_body/tomato_stem_down.png',
  body_stem_up: '03_tomato_body/tomato_stem_up.png',
  // 02 表情
  expr_focus: '02_tomato_expression/focus.png',
  expr_happy: '02_tomato_expression/happy.png',
  expr_rage: '02_tomato_expression/rage.png',
  expr_idie_face: '02_tomato_expression/idie_face.png',
  expr_idie_note_01: '02_tomato_expression/idie_note_01.png',
  expr_idie_note_02: '02_tomato_expression/idie_note_02.png',
  expr_pro_bubble: '02_tomato_expression/prolongation_bubble.png',
  expr_pro_face: '02_tomato_expression/prolongation_face.png',
  expr_die: '02_tomato_expression/die.png',
  expr_pro_zzz_01: '02_tomato_expression/prolongation_ZZZ_01.png',
  expr_pro_zzz_02: '02_tomato_expression/prolongation_ZZZ_02.png',
  expr_rest_cap: '02_tomato_expression/rest_cap.png',
  expr_rest_face: '02_tomato_expression/rest_face.png',
  expr_rest_bubble: '02_tomato_expression/rest_bubble.png',
  expr_rest_zzz_01: '02_tomato_expression/rest_ZZZ_01.png',
  expr_rest_zzz_02: '02_tomato_expression/rest_ZZZ_02.png',
  expr_happy_angle_01: '02_tomato_expression/happy_angle_01.png',
  expr_happy_angle_02: '02_tomato_expression/happy_angle_02.png',
  expr_happy_firework_01: '02_tomato_expression/happy_firework_01.png',
  expr_happy_firework_02: '02_tomato_expression/happy_firework_02.png',
  // 01 按钮与数字
  btn_start: '01_button_number/button_start.png',
  btn_pause: '01_button_number/button_pause.png',
  btn_reset: '01_button_number/button_Reset.png',
  btn_continue: '01_button_number/button_continue.png',
  btn_rest: '01_button_number/button_rest.png',
  ui_colon: '01_button_number/number_colon.png',
  ui_cursor: '01_button_number/number_TextCursor.png',
};

// 太阳光芒 11 帧
for (let i = 1; i <= 11; i++) {
  const pad = String(i).padStart(2, '0');
  ASSET_PATHS[`bg_sunlight_${pad}`] = `05_background/background_sun_sunlight_${pad}.png`;
}
// 按钮点击动画 5 帧（62×62，非全画布）
for (let i = 1; i <= 5; i++) {
  ASSET_PATHS[`anime_0${i}`] = `01_button_number/anime/button_anime_0${i}.png`;
}
// 数字
for (let n = 0; n <= 9; n++) {
  ASSET_PATHS[`num_mt_${n}`] = `01_button_number/minute_tens/minute_tens_${n}.png`;
  ASSET_PATHS[`num_mo_${n}`] = `01_button_number/minute_ones/minute_ones_${n}.png`;
  ASSET_PATHS[`num_so_${n}`] = `01_button_number/second_ones/second_ones_${n}.png`;
}
for (let n = 0; n <= 6; n++) {
  ASSET_PATHS[`num_st_${n}`] = `01_button_number/second_tens/second_tens_${n}.png`;
}

/** 太阳光芒 11 层的 key 列表 */
export const SUNLIGHT_KEYS = Array.from(
  { length: 11 },
  (_, i) => `bg_sunlight_${String(i + 1).padStart(2, '0')}`
);

/** 需要提取蒙版的可交互素材 */
export const INTERACTIVE_KEYS = [
  'btn_start',
  'btn_pause',
  'btn_reset',
  'btn_continue',
  'btn_rest',
  'rock_close',
  'rock_billboard',
  'rock_minimize',
  'rock_snail',
  'rock_button',
  'body_clockboard',
  'body_stem_down',
  'body_stem_up',
];

export interface AssetStore {
  images: Map<string, HTMLImageElement>;
  sprites: Map<string, PIXI.Sprite>;
  masks: Map<string, Uint8Array>;
  bboxes: Map<string, Bbox>;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed: ${url}`));
    img.src = url;
  });
}

/** 提取 alpha 蒙版（仅全画布素材可用） */
function extractAlphaMask(img: HTMLImageElement): Uint8Array {
  const c = document.createElement('canvas');
  c.width = CANVAS_W;
  c.height = CANVAS_H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
  const mask = new Uint8Array(CANVAS_W * CANVAS_H);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] > 128 ? 1 : 0;
  }
  return mask;
}

/** 从蒙版计算不透明像素包围盒 */
function getBbox(mask: Uint8Array): Bbox {
  let x1 = CANVAS_W;
  let y1 = CANVAS_H;
  let x2 = 0;
  let y2 = 0;
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      if (mask[y * CANVAS_W + x]) {
        if (x < x1) x1 = x;
        if (y < y1) y1 = y;
        if (x > x2) x2 = x;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x1 > x2 || y1 > y2) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

/**
 * 测量任意图片的不透明像素包围盒（复用蒙版提取管线）。
 * 用途：过渡动画锚点的程序自动检测，如需求文档要求的
 * 「body 部件不透明区域底部中心」= (bbox.x + bbox.w/2, bbox.y + bbox.h)。
 */
export function measureOpaqueBbox(img: HTMLImageElement): Bbox {
  return getBbox(extractAlphaMask(img));
}

/** 加载全部素材，构建精灵与蒙版 */
export async function loadAssets(): Promise<AssetStore> {
  const images = new Map<string, HTMLImageElement>();
  const keys = Object.keys(ASSET_PATHS);
  for (let i = 0; i < keys.length; i += 10) {
    const batch = keys.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (k) => {
        try {
          return { k, img: await loadImage(`${ASSET_BASE}/${ASSET_PATHS[k]}`) };
        } catch {
          // 素材缺失时警告并跳过（布局/动画均有空值守卫），保证整体可启动
          console.warn(`[assets] skip missing: ${ASSET_PATHS[k]}`);
          return { k, img: null as HTMLImageElement | null };
        }
      })
    );
    results.forEach((r) => {
      if (r.img) images.set(r.k, r.img);
    });
  }

  const sprites = new Map<string, PIXI.Sprite>();
  const masks = new Map<string, Uint8Array>();
  const bboxes = new Map<string, Bbox>();

  for (const [key, img] of images) {
    const s = new PIXI.Sprite(PIXI.Texture.from(img));
    s.name = key;
    sprites.set(key, s);
  }

  for (const key of INTERACTIVE_KEYS) {
    const img = images.get(key);
    if (!img) continue;
    const mask = extractAlphaMask(img);
    masks.set(key, mask);
    bboxes.set(key, getBbox(mask));
  }

  return { images, sprites, masks, bboxes };
}
