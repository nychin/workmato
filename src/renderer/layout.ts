/**
 * 布局系统 —— 状态 → 图层装配
 *
 * 图层组（底→顶）：bg / rock / body / expr / digit / fx / btn
 * fx 层独立于状态切换，保证点击动画在按钮消失后仍播放完。
 */
import * as PIXI from 'pixi.js';
import { AssetStore, measureOpaqueBbox, SUNLIGHT_KEYS } from './assets';
import { TimerDisplayState } from './types';
import { BUTTON_DEFS, ROCK_INTERACTIVE_KEYS, TrackedButton } from './buttons';
import { RecolorKit } from './recolor';

export { SUNLIGHT_KEYS };

/** 告示牌文字的像素化滤镜（PIXI v6 自定义 shader） */
const PIXELATE_VERT = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
uniform mat3 projectionMatrix;
uniform mat3 filterMatrix;
varying vec2 vTextureCoord;
varying vec2 vFilterCoord;
void main(void) {
  gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = aTextureCoord;
  vFilterCoord = (filterMatrix * vec3(aTextureCoord, 1.0)).xy;
}
`;

const PIXELATE_FRAG = `
precision mediump float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float pixelSize;
uniform vec4 filterArea;
void main(void) {
  vec2 uv = vTextureCoord;
  vec2 px = uv * filterArea.xy;
  vec2 snapped = floor(px / pixelSize) * pixelSize + pixelSize * 0.5;
  vec2 snappedUV = snapped / filterArea.xy;
  vec4 color = texture2D(uSampler, snappedUV);
  color.a = step(0.5, color.a);
  gl_FragColor = color;
}
`;

/** 告示牌文字像素化：保留字形原本的笔画覆盖率，再量化成少量透明度阶梯。 */
const BINARY_FRAG = `
precision mediump float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
void main(void) {
  vec4 color = texture2D(uSampler, vTextureCoord);
  // 不使用硬阈值：硬切会让细笔画丢失，降低阈值又会把整字加粗。
  // 仅保留 50% 与 100% 两档可见透明度，兼顾笔画完整和像素感。
  color.a = color.a < 0.25 ? 0.0 : (color.a < 0.75 ? 0.5 : 1.0);
  gl_FragColor = color;
}
`;

/** 告示牌文字像素块大小（px） */
const BILLBOARD_PIXEL_SIZE = 2;

/** 石头组层序（底→顶）：close、rock、billboard、minimize、rock_button、snail */
export const ROCK_LAYER_KEYS = [
  'rock_close',
  'rock_base',
  'rock_billboard',
  'rock_minimize',
  'rock_button',
  'rock_snail',
];

/** 表情组（底→顶）。呼吸帧动画的部件先用 01 帧静态显示（M3 接管） */
const EXPR_KEYS: Record<string, string[]> = {
  idie: ['expr_idie_face', 'expr_idie_note_01'],
  focus: ['expr_focus'],
  prolongation: ['expr_pro_bubble', 'expr_pro_zzz_01', 'expr_pro_face'],
  die: ['expr_die'],
  rest: ['expr_rest_zzz_01', 'expr_rest_cap', 'expr_rest_face', 'expr_rest_bubble'],
  happy: ['expr_happy'],
  rage: ['expr_rage'],
};

/** FSM button 字段 → 按钮 key 列表（reset 状态显示 继续+重置 两个独立按钮） */
const BTN_STATE_MAP: Record<string, string[]> = {
  start: ['btn_start'],
  pause: ['btn_pause'],
  reset: ['btn_continue', 'btn_reset'],
  rest: ['btn_rest'],
  none: [],
};

export interface LayoutConfig {
  bgKeys: string[];
  exprKeys: string[];
  btnKeys: string[];
  stemKey: string;
  isProlongation: boolean;
  /** celebrating 时背景保持不变 */
  keepBg: boolean;
  /** 鞭策（P3）：snail→snail_rage、隐藏 hand（集成到 02 表情层）、snail 不可交互 */
  isRage: boolean;
}

export function getLayout(state: TimerDisplayState): LayoutConfig {
  const bg = state.background;
  let bgKeys: string[] = [];
  // 注意：sunlight 光芒必须垫在 bg_sun **底下**。
  // 光芒素材的根部是平切设计，要靠太阳圆盘遮住；
  // 呼吸动画时光芒放大探出圆盘外的部分才可见。
  if (bg === 'sun') bgKeys = [...SUNLIGHT_KEYS, 'bg_sun'];
  else if (bg === 'sun+cloud') {
    bgKeys = [...SUNLIGHT_KEYS, 'bg_sun', 'bg_cloud_01', 'bg_cloud_02'];
  }
  else if (bg === 'night') {
    bgKeys = ['bg_night_sky', 'bg_night_moon', 'bg_night_starlight', 'bg_night_moonlight'];
  }

  return {
    bgKeys,
    exprKeys: EXPR_KEYS[state.expression] || [],
    btnKeys: BTN_STATE_MAP[state.button] || [],
    stemKey: state.isPinned ? 'body_stem_up' : 'body_stem_down',
    isProlongation: state.state === 'prolongation',
    keepBg: bg === 'keep',
    isRage: state.state === 'rageFocus',
  };
}

export class LayoutRenderer {
  private currentLayout: LayoutConfig | null = null;
  private opaqueBboxCache = new Map<string, ReturnType<typeof measureOpaqueBbox>>();
  private pinnedTaskTitle = '';
  private billboardTitle: PIXI.Text | null = null;

  constructor(
    private store: AssetStore,
    private groups: Map<string, PIXI.Container>,
    private glowTwins?: Map<string, PIXI.Sprite>,
    private recolor?: RecolorKit
  ) {}

  get layout(): LayoutConfig | null {
    return this.currentLayout;
  }

  /** 应用状态布局，返回需要交互追踪的按钮列表 */
  apply(state: TimerDisplayState): TrackedButton[] {
    const layout = getLayout(state);
    const prevBgKeys = this.currentLayout?.bgKeys;
    // keepBg（庆祝）保持前状态的太阳处理：延时触发的庆祝若按新状态判断，
    // 85% 缩小与 FF9554 落日色会被重置（2026-08-01 bug 修复）
    if (layout.keepBg && this.currentLayout) {
      layout.isProlongation = this.currentLayout.isProlongation;
    }
    this.currentLayout = layout;

    // 清空（fx 层除外，点击动画可能仍在播放）
    for (const [gk, ct] of this.groups) {
      if (gk !== 'fx') ct.removeChildren();
    }

    // ── bg ──
    // 每个光芒的层序：辉光孪生 → 光芒原图 → 重着色孪生（全部垫在 bg_sun 底下）
    const bgCt = this.groups.get('bg')!;
    const bgKeys = layout.keepBg && prevBgKeys ? prevBgKeys : layout.bgKeys;
    for (const bk of bgKeys) {
      const glow = this.glowTwins?.get(bk);
      if (glow) {
        glow.alpha = 0;
        bgCt.addChild(glow);
      }
      const s = this.store.sprites.get(bk);
      if (s) bgCt.addChild(s);
      const colorTwin = this.recolor?.colorTwins.get(bk);
      if (colorTwin) {
        colorTwin.alpha = 0;
        bgCt.addChild(colorTwin);
      }
      // 太阳重着色孪生紧随其后
      if (bk === 'bg_sun' && this.recolor?.sunTwin) {
        this.recolor.sunTwin.alpha = 0;
        bgCt.addChild(this.recolor.sunTwin);
      }
    }
    // 延时状态：太阳与光芒保持缩小后的 85% 基准，
    // 颜色通过 FF9554 重着色孪生（alpha=1）精确呈现落日色
    const sunScale = layout.isProlongation ? 0.85 : 1;
    const sunsetAlpha = layout.isProlongation ? 1 : 0;
    const sunSprite = this.store.sprites.get('bg_sun');
    if (sunSprite) {
      sunSprite.tint = 0xffffff;
      sunSprite.scale.set(sunScale);
    }
    if (this.recolor?.sunTwin) {
      this.recolor.sunTwin.scale.set(sunScale);
      this.recolor.sunTwin.alpha = sunsetAlpha;
    }
    for (const sk of SUNLIGHT_KEYS) {
      const s = this.store.sprites.get(sk);
      if (s) {
        s.tint = 0xffffff;
        s.scale.set(sunScale);
      }
      const colorTwin = this.recolor?.colorTwins.get(sk);
      if (colorTwin) {
        if (layout.isProlongation) {
          const tex = this.recolor?.sunsetTex.get(sk);
          if (tex) colorTwin.texture = tex;
        }
        colorTwin.scale.set(sunScale);
        colorTwin.alpha = sunsetAlpha;
      }
      const glow = this.glowTwins?.get(sk);
      if (glow) {
        glow.scale.set(sunScale);
        glow.alpha = 0;
      }
    }
    // 夜晚光晕初始 0% 透明度（呼吸动画从 0 渐入接管）
    for (const nk of ['bg_night_starlight', 'bg_night_moonlight']) {
      const s = this.store.sprites.get(nk);
      if (s) s.alpha = 0;
    }

    // ── rock（鞭策：snail 替换为 snail_rage） ──
    const rockCt = this.groups.get('rock')!;
    const rockKeys = layout.isRage
      ? ROCK_LAYER_KEYS.map((k) => (k === 'rock_snail' ? 'rock_snail_rage' : k))
      : ROCK_LAYER_KEYS;
    for (const rk of rockKeys) {
      const s = this.store.sprites.get(rk);
      if (s) rockCt.addChild(s);
    }
    this.renderPinnedTaskTitle();

    // ── body（鞭策：hand 隐藏——已集成到 02 表情层） ──
    const bodyCt = this.groups.get('body')!;
    const bodyKeys = layout.isRage
      ? ['body_base', 'body_clockboard', layout.stemKey]
      : ['body_base', 'body_clockboard', 'body_hand', layout.stemKey];
    for (const bk of bodyKeys) {
      const s = this.store.sprites.get(bk);
      if (s) {
        // 防御性复位：庆祝/鞭策路径会动 visible（对象在 AssetStore 复用）
        s.visible = true;
        bodyCt.addChild(s);
      }
    }

    // ── expr ──
    const exprCt = this.groups.get('expr')!;
    for (const ek of layout.exprKeys) {
      const s = this.store.sprites.get(ek);
      if (s) {
        // 防御性复位：过渡动画淡出的精灵可能残留 alpha=0（对象在 AssetStore 复用）
        s.alpha = 1;
        exprCt.addChild(s);
      }
    }

    // ── digit ──
    this.updateDigits(state);

    // ── btn ──
    const btnCt = this.groups.get('btn')!;
    for (const bk of layout.btnKeys) {
      const s = this.store.sprites.get(bk);
      if (s) {
        s.alpha = 1;
        s.scale.set(1);
        s.tint = 0xffffff;
        btnCt.addChild(s);
      }
    }

    // 鞭策：expr（02 表情层）提到 btn（01 按钮层）之上
    // 原始顺序 bg→rock→body→expr→digit→fx→btn，rage 时 expr 移到 btn 后
    const stage = this.groups.get('btn')!.parent;
    if (stage) {
      const exprCt = this.groups.get('expr')!;
      const btnCt = this.groups.get('btn')!;
      if (layout.isRage) {
        stage.setChildIndex(exprCt, stage.getChildIndex(btnCt));
      } else if (stage.getChildIndex(exprCt) > stage.getChildIndex(btnCt)) {
        // 退出鞭策时恢复 expr 到 body 之上、digit 之下
        const bodyIdx = stage.getChildIndex(this.groups.get('body')!);
        stage.setChildIndex(exprCt, bodyIdx + 1);
      }
    }

    return this.buildTracked(layout);
  }

  /** 切换告示牌悬停贴图。 */
  setBillboardHover(hovered: boolean): void {
    const billboard = this.store.sprites.get('rock_billboard');
    const image = this.store.images.get(hovered ? 'rock_billboard_hover' : 'rock_billboard');
    if (!billboard || !image) return;
    billboard.texture = PIXI.Texture.from(image);
  }

  /** 更新告示牌显示的当前任务标题。 */
  setPinnedTaskTitle(title: string): void {
    this.pinnedTaskTitle = title.trim();
    this.renderPinnedTaskTitle();
  }

  private renderPinnedTaskTitle(): void {
    this.billboardTitle?.destroy();
    this.billboardTitle = null;

    if (!this.pinnedTaskTitle) return;
    const rockCt = this.groups.get('rock');
    if (!rockCt) return;

// 关键修复：shader 不能做"像素合并"（PIXELATE_FRAG 按 filterArea 屏幕尺寸合并，
    // 会吞掉字号变化导致看不出尺寸差异）。
    // 正确做法：resolution = 1，backing 纹理 = fontSize 像素/字，1:1 上屏；
    // 只用 BINARY_FRAG 对字体抗锯齿边缘做二值化，这样每个 backing 像素 = 1 屏像素 = 1 UI 像素块。
    // fontSize 直接决定屏像素字高，改字号就真的变大。
    // 告示牌纸片可用宽度约 100px；字号缩小后可容纳约 7 个字符。
    const title = new PIXI.Text(this.pinnedTaskTitle.slice(0, 7), {
      fontFamily: 'ResourceHanRoundedCN-Bold, sans-serif',
      fontSize: 16,
      fill: 0x4a3426,
      align: 'left',
      padding: 2,
    });
    // 左对齐，最左端从第 135 像素开始；垂直居中于告示牌纸片
    title.anchor.set(0, 0.5);
    const titleX = this.pinnedTaskTitle.length >= 5 ? 131 : 135;
    title.position.set(titleX, 315);
    title.roundPixels = true;
    title.texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
    title.filters = [new PIXI.Filter(PIXELATE_VERT, BINARY_FRAG)];
    rockCt.addChild(title);
    this.billboardTitle = title;
  }

  /** 字体加载完成后重新绘制告示牌文字。 */
  refreshPinnedTaskTitle(): void {
    this.renderPinnedTaskTitle();
  }

  /** 每秒 tick：仅更新数字 */
  updateDigits(state: TimerDisplayState): void {
    this.renderDigits(state.minutes, state.seconds);
  }

  /** 时间输入预览：隐藏正常时间，只显示用户输入的分钟数字和闪烁光标。 */
  updateTimeInput(value: string, cursorVisible: boolean): void {
    const digitCt = this.groups.get('digit')!;
    digitCt.removeChildren();

    if (value.length >= 1) {
      const first = Number.parseInt(value[0], 10);
      const firstKey = value.length === 1 ? `num_mo_${first}` : `num_mt_${first}`;
      const firstSprite = this.store.sprites.get(firstKey);
      if (firstSprite) digitCt.addChild(firstSprite);
    }

    if (value.length >= 2) {
      const second = Number.parseInt(value[1], 10);
      const secondSprite = this.store.sprites.get(`num_mo_${second}`);
      if (secondSprite) digitCt.addChild(secondSprite);
    }

    if (!cursorVisible) return;
    const cursor = this.store.sprites.get('ui_cursor');
    const cursorImage = this.store.images.get('ui_cursor');
    if (cursor && cursorImage) {
      const cursorBbox = this.getOpaqueBbox('ui_cursor', cursorImage);
      let cursorLeft = cursorBbox.x;
      if (value.length >= 1) {
        const lastDigit = Number.parseInt(value[value.length - 1], 10);
        const lastKey = `num_mo_${lastDigit}`;
        const lastImage = this.store.images.get(lastKey);
        if (lastImage) {
          const digitBbox = this.getOpaqueBbox(lastKey, lastImage);
          cursorLeft = digitBbox.x + digitBbox.w + 2;
        }
      }
      cursor.position.set(cursorLeft - cursorBbox.x, 0);
      cursor.visible = true;
      cursor.alpha = 1;
      digitCt.addChild(cursor);
    }
  }

  private getOpaqueBbox(
    key: string,
    image: HTMLImageElement
  ): ReturnType<typeof measureOpaqueBbox> {
    let bbox = this.opaqueBboxCache.get(key);
    if (!bbox) {
      bbox = measureOpaqueBbox(image);
      this.opaqueBboxCache.set(key, bbox);
    }
    return bbox;
  }

  private renderDigits(minutes: number, seconds: number): void {
    // 分钟数字素材只有两位（最高 99:59）；专注时长超过 99 分钟时按显示上限渲染，避免十位缺失。
    if (minutes > 99) {
      minutes = 99;
      seconds = 59;
    }
    const digitCt = this.groups.get('digit')!;
    digitCt.removeChildren();

    const pick = (prefix: string, val: number): PIXI.Sprite | undefined =>
      this.store.sprites.get(`${prefix}_${val}`);

    const seq = [
      pick('num_mt', Math.floor(minutes / 10)),
      pick('num_mo', minutes % 10),
      this.store.sprites.get('ui_colon'),
      pick('num_st', Math.floor(seconds / 10)),
      pick('num_so', seconds % 10),
    ];
    for (const s of seq) {
      if (s) {
        s.visible = true;
        digitCt.addChild(s);
      }
    }
  }

  /** 构建按钮追踪列表（时间按钮 + 石头组常驻按钮） */
  private buildTracked(layout: LayoutConfig): TrackedButton[] {
    const list: TrackedButton[] = [];
    const push = (key: string) => {
      const def = BUTTON_DEFS[key];
      const sprite = this.store.sprites.get(key);
      const mask = this.store.masks.get(key);
      const bbox = this.store.bboxes.get(key);
      if (def && sprite && mask && bbox) {
        list.push({ def, sprite, mask, bbox, isHovered: false, isPressed: false });
      }
    };
    for (const rk of ROCK_INTERACTIVE_KEYS) {
      // 鞭策：snail 被 snail_rage 替换，不追踪（snail_rage 为纯装饰）
      if (layout.isRage && rk === 'rock_snail') continue;
      push(rk);
    }
    for (const bk of layout.btnKeys) push(bk);
    // 番茄蒂置顶按钮（P5 加入按钮系统）
    push(layout.stemKey);
    return list;
  }
}
