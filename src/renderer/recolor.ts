/**
 * 精确重着色模块
 *
 * 背景：PixiJS 的 tint 是乘法混合（只能变暗），ADD 加色受底色影响，
 * 都无法保证最终显示颜色精确等于目标色号。
 *
 * 方案：运行时把素材重绘为"保留 alpha 通道的纯色纹理"，
 * 用孪生精灵叠在原精灵上，alpha 即过渡进度——
 * alpha=1 时显示的就是精确的目标颜色。
 */
import * as PIXI from 'pixi.js';
import { AssetStore, SUNLIGHT_KEYS } from './assets';

/** 脉冲变亮色（专注） */
export const BRIGHT_COLOR = 0xffe588;
/** 落日色（延时） */
export const SUNSET_COLOR = 0xff9554;

export interface RecolorKit {
  /** 各光芒的重着色孪生（置于对应光芒之上、太阳之下） */
  colorTwins: Map<string, PIXI.Sprite>;
  /** 太阳的重着色孪生（置于太阳之上） */
  sunTwin: PIXI.Sprite | null;
  /** FFE588 纯色纹理（脉冲变亮用） */
  brightTex: Map<string, PIXI.Texture>;
  /** FF9554 纯色纹理（落日用） */
  sunsetTex: Map<string, PIXI.Texture>;
}

/** 生成保留 alpha 通道的纯色重着色纹理 */
export function colorize(img: HTMLImageElement, color: number): PIXI.Texture {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, c.width, c.height);
  const d = imageData.data;
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return PIXI.Texture.from(c);
}

/** 构建太阳+全部光芒的重着色孪生（锚点/位置继承原精灵） */
export function buildRecolorKit(store: AssetStore): RecolorKit {
  const brightTex = new Map<string, PIXI.Texture>();
  const sunsetTex = new Map<string, PIXI.Texture>();
  for (const key of [...SUNLIGHT_KEYS, 'bg_sun']) {
    const img = store.images.get(key);
    if (!img) continue;
    brightTex.set(key, colorize(img, BRIGHT_COLOR));
    sunsetTex.set(key, colorize(img, SUNSET_COLOR));
  }

  const colorTwins = new Map<string, PIXI.Sprite>();
  for (const sk of SUNLIGHT_KEYS) {
    const src = store.sprites.get(sk);
    const tex = brightTex.get(sk);
    if (!src || !tex) continue;
    const twin = new PIXI.Sprite(tex);
    twin.anchor.copyFrom(src.anchor);
    twin.position.copyFrom(src.position);
    twin.alpha = 0;
    colorTwins.set(sk, twin);
  }

  let sunTwin: PIXI.Sprite | null = null;
  const sun = store.sprites.get('bg_sun');
  const sunTex = sunsetTex.get('bg_sun');
  if (sun && sunTex) {
    sunTwin = new PIXI.Sprite(sunTex);
    sunTwin.anchor.copyFrom(sun.anchor);
    sunTwin.position.copyFrom(sun.position);
    sunTwin.alpha = 0;
  }

  return { colorTwins, sunTwin, brightTex, sunsetTex };
}
