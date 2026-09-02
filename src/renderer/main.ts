/**
 * 番茄钟渲染进程入口 —— M2+
 *
 * 模块化重构：资产 / 布局 / 按钮 / 命中表 / 音效 / 动画基元
 */
import * as PIXI from 'pixi.js';
import { loadAssets, CANVAS_W, CANVAS_H } from './assets';
import { installTicker } from './anime';
import { ButtonController } from './buttons';
import { LayoutRenderer, SUNLIGHT_KEYS } from './layout';
import { generateHitmap } from './hitmap';
import { SoundManager } from './sound';
import { BreathingController } from './breathing';
import { TransitionController } from './transitions';
import { CelebrationController } from './celebration';
import { buildRecolorKit, colorize } from './recolor';
import {
  BOUNCE_ANCHOR,
  TargetRegistry,
  ActionRegistry,
  TimelinePlayer,
  ParticleEmitter,
  buildBounceTracks,
  pinAt,
  unpin,
} from './anim';
import { TimerDisplayState } from './types';
import { setLocale, t } from '../shared/i18n';

// 太阳光芒呼吸的缩放中心（文档指定坐标）
const SUNLIGHT_ANCHOR = { x: 238, y: 242 };

async function main(): Promise<void> {
  PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;

  const app = new PIXI.Application({
    width: CANVAS_W,
    height: CANVAS_H,
    backgroundAlpha: 0,
    antialias: false,
    resolution: 1,
    autoDensity: false,
  });

  const container = document.getElementById('pixi-container');
  if (!container) throw new Error('Missing #pixi-container');
  container.appendChild(app.view);

  const applyPanelDisplayScale = (scale: number): void => {
    const normalized = Math.min(2, Math.max(0.5, scale));
    document.documentElement.classList.add('panel-scaled');
    document.documentElement.style.setProperty('--panel-display-scale', String(normalized));
    document.documentElement.style.setProperty('--panel-display-width', `${CANVAS_W * normalized}px`);
    document.documentElement.style.setProperty('--panel-display-height', `${CANVAS_H * normalized}px`);
  };
  void window.settingsAPI.load().then((settings) => applyPanelDisplayScale(settings.tomatoPanelScale));

  const api = window.tomatoAPI;

  // ── 加载素材 ──
  console.log('[tomato] loading assets...');
  const store = await loadAssets();
  console.log(`[tomato] loaded ${store.images.size} images`);

  // ── 设置特殊锚点 ──
  // 按钮：锚点 = 不透明像素 bbox 中心（修复悬停缩放漂移）
  for (const [key, bbox] of store.bboxes) {
    const sprite = store.sprites.get(key);
    if (sprite) ButtonController.anchorAtBboxCenter(sprite, bbox);
  }
  // 太阳光芒：锚点 = 文档指定的呼吸中心 (238, 242)
  // bg_sun 使用同一锚点，保证延时状态 0.85 缩放时圆盘与光芒对齐
  for (const sk of [...SUNLIGHT_KEYS, 'bg_sun']) {
    const sprite = store.sprites.get(sk);
    if (sprite) {
      sprite.anchor.set(SUNLIGHT_ANCHOR.x / CANVAS_W, SUNLIGHT_ANCHOR.y / CANVAS_H);
      sprite.position.set(SUNLIGHT_ANCHOR.x, SUNLIGHT_ANCHOR.y);
    }
  }

  // 鼻涕泡：锚点 = 文档指定的呼吸中心 (281, 219)
  {
    const bubble = store.sprites.get('expr_rest_bubble');
    if (bubble) {
      bubble.anchor.set(281 / CANVAS_W, 219 / CANVAS_H);
      bubble.position.set(281, 219);
    }
  }

  // ── 为光芒创建辉光孪生（模糊+叠加混合，脉冲时同步缩放与透明度） ──
  const glowTwins = new Map<string, PIXI.Sprite>();
  for (const sk of SUNLIGHT_KEYS) {
    const src = store.sprites.get(sk);
    if (!src) continue;
    const twin = new PIXI.Sprite(src.texture);
    twin.anchor.copyFrom(src.anchor);
    twin.position.copyFrom(src.position);
    twin.blendMode = PIXI.BLEND_MODES.ADD;
    twin.tint = 0xffe588; // 亮黄色加色增亮（tint 是乘法只能变暗，加色混合才能变亮）
    twin.alpha = 0;
    const blur = new PIXI.filters.BlurFilter();
    blur.blur = 5;
    twin.filters = [blur];
    glowTwins.set(sk, twin);
  }

  // ── 图层组（底→顶） ──
  const groupKeys = ['bg', 'rock', 'body', 'expr', 'digit', 'fx', 'btn'];
  const groups = new Map<string, PIXI.Container>();
  for (const gk of groupKeys) {
    const ct = new PIXI.Container();
    ct.name = gk;
    groups.set(gk, ct);
    app.stage.addChild(ct);
  }

  // ── 动画 ticker ──
  installTicker(app);

  // ── 音效 ──
  const sound = new SoundManager();
  sound.preload();

  // ── 重着色孪生（精确色号：脉冲 FFE588 / 落日 FF9554） ──
  const recolor = buildRecolorKit(store);

  // ── Timeline 动画引擎（全局唯一实例，各编排器共享） ──
  const animTargets = new TargetRegistry();
  const animActions = new ActionRegistry();
  const animPlayer = new TimelinePlayer(animTargets, animActions);

  // ── 布局渲染器 ──
  const layoutRenderer = new LayoutRenderer(store, groups, glowTwins, recolor);

  // ── 呼吸动画编排器（P0 起基于 Timeline 引擎） ──
  const breathing = new BreathingController(store, glowTwins, recolor, {
    targets: animTargets,
    player: animPlayer,
  });

  // ── 过渡动画编排器（P1 握手协议渲染侧） ──
  const transitions = new TransitionController(store, groups, animTargets, animPlayer, recolor);

  // ── 按钮控制器 ──
  const animeTextures = Array.from({ length: 5 }, (_, i) => {
    const img = store.images.get(`anime_0${i + 1}`);
    return img ? PIXI.Texture.from(img) : PIXI.Texture.EMPTY;
  }).filter((t) => t !== PIXI.Texture.EMPTY);

  const buttons = new ButtonController(
    groups.get('fx')!,
    animeTextures,
    (action) => {
      console.log(`[tomato] button: ${action}`);
      if (action === 'hover:taskflow') {
        layoutRenderer.setBillboardHover(true);
        return;
      }
      if (action.startsWith('hover:')) {
        layoutRenderer.setBillboardHover(false);
        return;
      }
      if (action === 'taskflow') {
        api.openTaskFlow();
        return;
      }
      if (action === 'snail') {
        api.toggleSettings();
        return;
      }
      api.sendButtonAction(action);
    }
  );

  // ── 庆祝动画编排器（P2，需 animeTextures 播放特殊按钮动画） ──
  const celebration = new CelebrationController(
    app,
    store,
    groups,
    animTargets,
    animPlayer,
    breathing,
    animeTextures
  );

  // ═══════════════════════════
  // 鼠标交互
  // ═══════════════════════════

  const view = app.view as HTMLCanvasElement;
  let isDragging = false;
  let dragLastX = 0;
  let dragLastY = 0;
  let currentDisplay: TimerDisplayState = {
    state: 'idle',
    timerMode: 'stopped',
    minutes: 30,
    seconds: 0,
    background: 'sun',
    expression: 'idie',
    button: 'start',
    isPinned: false,
    transition: null,
  };
  let isTimeInput = false;
  let restMode: 'auto' | 'manual' = 'auto';
  let timeInputValue = '';
  let timeCursorVisible = true;
  let timeCursorTimer: ReturnType<typeof setInterval> | null = null;

  const canEditTime = (): boolean =>
    currentDisplay.state === 'idle' || (currentDisplay.state === 'waitingRest' && restMode === 'manual');

  const isClockboardPixel = (x: number, y: number): boolean => {
    const mask = store.masks.get('body_clockboard');
    if (!mask || x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) return false;
    return mask[y * CANVAS_W + x] === 1;
  };

  const renderTimeInput = (): void => {
    layoutRenderer.updateTimeInput(timeInputValue, timeCursorVisible);
  };

  const stopTimeCursor = (): void => {
    if (timeCursorTimer) clearInterval(timeCursorTimer);
    timeCursorTimer = null;
  };

  const endTimeInput = (restoreDisplay: boolean): void => {
    if (!isTimeInput) return;
    isTimeInput = false;
    timeInputValue = '';
    stopTimeCursor();
    if (restoreDisplay) layoutRenderer.updateDigits(currentDisplay);
  };

  const commitTimeInput = (): boolean => {
    const minutes = Number.parseInt(timeInputValue, 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 99) return false;
    api.setWaitingDuration(minutes);
    endTimeInput(false);
    return true;
  };

  const beginTimeInput = (): void => {
    if (!canEditTime()) return;
    isTimeInput = true;
    timeInputValue = '';
    timeCursorVisible = true;
    stopTimeCursor();
    renderTimeInput();
    timeCursorTimer = setInterval(() => {
      if (!isTimeInput) return;
      timeCursorVisible = !timeCursorVisible;
      renderTimeInput();
    }, 500);
  };

  function getCursorPos(e: MouseEvent): { x: number; y: number } {
    const rect = view.getBoundingClientRect();
    return {
      x: Math.floor((e.clientX - rect.left) * CANVAS_W / rect.width),
      y: Math.floor((e.clientY - rect.top) * CANVAS_H / rect.height),
    };
  }

  view.addEventListener('mousemove', (e: MouseEvent) => {
    if (isDragging || isTimeInput) return;
    const { x, y } = getCursorPos(e);
    buttons.onHover(x, y);
  });

  view.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    const { x, y } = getCursorPos(e);

    if (isTimeInput) {
      if (!commitTimeInput()) endTimeInput(true);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (canEditTime() && isClockboardPixel(x, y)) {
      beginTimeInput();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (buttons.onPress(x, y)) {
      e.preventDefault();
      e.stopPropagation();
    } else {
      isDragging = true;
      dragLastX = e.screenX;
      dragLastY = e.screenY;
      api.dragStart();
      e.preventDefault();
    }
  });

  window.addEventListener('mouseup', (e: MouseEvent) => {
    const { x, y } = getCursorPos(e);
    buttons.onRelease(x, y);
    if (isDragging) {
      isDragging = false;
      api.dragEnd();
    }
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.screenX - dragLastX;
    const dy = e.screenY - dragLastY;
    dragLastX = e.screenX;
    dragLastY = e.screenY;
    api.moveWindow(dx, dy);
  });

  // ═══════════════════════════
  // 状态监听
  // ═══════════════════════════

  let prevState = '';
  let initialFrameSignalSent = false;
  /** 庆祝前状态：进入庆祝时记录，庆祝返回后用于判断"是否真的重新进入某状态"，避免误播进入音效 */
  let celebrateFrom = '';
  /** 上一帧是否处于延时上限彩蛋（die 表情），用于只在首次进入时播弹动 */
  let prevEasterEgg = false;
  /** 彩蛋茎染色恢复上下文（保存原始纹理，退出彩蛋时还原） */
  let eggStemRestore: { sprite: PIXI.Sprite; tex: PIXI.Texture } | null = null;

  api.onTimerState((state: TimerDisplayState) => {
    currentDisplay = state;
    if (isTimeInput && !canEditTime()) endTimeInput(false);

    const trans = state.transition ?? null;
    const isCelebrate = state.state === 'celebrating';
    // 延时上限彩蛋：02 层表情替换为 die，停用 ZZZ 帧动画与 sync
    const easterEggDie = state.state === 'prolongation' && state.expression === 'die';
    console.log(`[tomato] state → ${state.state}${trans ? ` (过渡:${trans.id})` : ''}`);
    const prev = prevState;
    prevState = state.state;

    // 表情层旧态只在动画入口捕获。同状态刷新（例如过渡中切换置顶）
    // 不得覆盖过渡开始时的旧表情快照，否则清理阶段会误删当前 02 表情层。
    if (isCelebrate && prev !== 'celebrating') {
      celebration.capturePrevExpression();
      celebrateFrom = prev; // 记录庆祝前状态，供庆祝返回后判断进入音效用
    } else if (trans && prev !== state.state) transitions.capturePrevExpression();

    // 在 Pixi 重绘和过渡编排前启动音效，避免画面更新占用首个音频播放时机。
    // 庆祝返回延时/鞭策时 prev 是 'celebrating'，需用 celebrateFrom 还原真实前状态，
    // 避免"庆祝结束回到延时/鞭策"被误判为重新进入而重播进入音效。
    const realPrev = prev === 'celebrating' ? celebrateFrom : prev;
    if (state.state === 'focus' && prev === 'idle') sound.playEvent('focusStart');
    if (state.state === 'rageFocus' && realPrev !== 'rageFocus') sound.play('rage');
    if (state.state === 'prolongation' && realPrev !== 'prolongation') sound.playEvent('prolongation');
    if (state.state === 'rest' && prev === 'waitingRest') sound.playEvent('restStart');
    if (state.state === 'idle' && (prev === 'rest' || prev === 'restPaused')) {
      sound.playEvent('restEnd');
    }
    if (state.state === 'celebrating') sound.playEvent('taskComplete');

    const tracked = layoutRenderer.apply(state);
    buttons.setTracked(tracked);
    if (isTimeInput) renderTimeInput();

    // 延时上限彩蛋：首次进入 die 时，对番茄的 01/02/03 层（body/expr/digit）一起弹动，
    // 并将茎（tomato_stem）染成枯黄 #88864C
    if (easterEggDie && !prevEasterEgg) {
      const eggLayers = ['body', 'expr', 'digit'] as const;
      const containers = eggLayers
        .map((n) => groups.get(n))
        .filter((c): c is PIXI.Container => !!c);
      if (containers.length) {
        containers.forEach((ct) => pinAt(ct, BOUNCE_ANCHOR.x, BOUNCE_ANCHOR.y));
        eggLayers.forEach((n) => animTargets.register(`egg:${n}`, groups.get(n)!));
        const playback = animPlayer.play({
          name: 'egg:bounce',
          duration: 480,
          tracks: buildBounceTracks({
            target: eggLayers.map((n) => `egg:${n}`),
            duration: 480,
          }),
        });
        void playback.finished.then(() => containers.forEach(unpin));
      }
    }
    // 茎染色：进入彩蛋用 colorize 纯色纹理精确染成枯黄 #88864C（tint 是乘法混合会变深，故不能用 tint），
    // 退出彩蛋恢复原纹理
    const stemKey = layoutRenderer.layout?.stemKey ?? '';
    const stemSprite = store.sprites.get(stemKey);
    const stemImg = store.images.get(stemKey);
    if (easterEggDie && !prevEasterEgg && stemSprite && stemImg) {
      // 保存原始纹理，用枯黄纯色纹理替换，完全呈现 #88864C
      eggStemRestore = { sprite: stemSprite, tex: stemSprite.texture };
      stemSprite.texture = colorize(stemImg, 0x88864c);
    } else if (!easterEggDie && prevEasterEgg && eggStemRestore) {
      eggStemRestore.sprite.texture = eggStemRestore.tex;
      eggStemRestore = null;
    }
    prevEasterEgg = easterEggDie;

    // 每次状态切换重新生成命中表（按钮布局随状态变化）
    const layout = layoutRenderer.layout;
    if (layout) api.setHitmap(generateHitmap(store, layout));

    if (trans && prev !== state.state) {
      // ── 过渡路径（P1 握手协议）──
      // 呼吸全停（文档规则：新动画开始时旧循环动画自动停止）；
      // 播完 → 启动新状态呼吸 → 回调主进程起表
      // 过渡期间锁定按钮：点击/悬停均不产生反馈
      buttons.setLocked(true);
      breathing.stopAll();
      void transitions.play(trans).then(() => {
        buttons.setLocked(false);
        breathing.startForState(state.state, prev, easterEggDie);
        api.transitionDone(trans.id);
      });
    } else if (trans) {
      // 过渡期间的同状态刷新（如切换置顶）只更新布局，不重启动画。
      // 重启会取消原播放并复用已被 apply 移走的快照，造成表情层丢失。
    } else if (isCelebrate) {
      // ── 庆祝路径（P2）──
      // 呼吸不 stopAll：编排器内部切庆祝加强循环；播完（含复原段）→ 回调恢复计时
      void celebration.run(prev).then(() => {
        api.celebrateDone();
      });
    } else {
      // 非过渡/庆祝路径：确保按钮解锁
      buttons.setLocked(false);
      // 呼吸动画（在布局应用后启动）
      breathing.startForState(state.state, prev, easterEggDie);
      if (state.state === 'rageFocus') layoutRenderer.updateDigits(state);
    }

    if (!initialFrameSignalSent) {
      initialFrameSignalSent = true;
      requestAnimationFrame(() => requestAnimationFrame(() => api.initialFrameReady()));
    }
  });

  api.onTimerTick((state: TimerDisplayState) => {
    currentDisplay = state;
    if (!isTimeInput) layoutRenderer.updateDigits(state);
  });

  api.onPinnedTaskTitle((title) => {
    layoutRenderer.setPinnedTaskTitle(title);
  });

  window.settingsAPI.onUpdated((settings) => sound.applySettings(settings.sound));
  window.settingsAPI.onUpdated((settings) => {
    restMode = settings.timer.restMode;
    applyPanelDisplayScale(settings.tomatoPanelScale);
    if (isTimeInput && !canEditTime()) endTimeInput(true);
  });

  // 语言：仅影响 document.title / <html lang> 与调试标签，改动极小。
  const applyLocale = (language: string): void => {
    setLocale(language as never);
    document.documentElement.lang = language;
    document.title = t('main.appName');
    if (debugLabel) debugLabel.textContent = t('tomato.debugMode');
  };
  void window.settingsAPI.load().then((settings) => applyLocale(settings.language));
  window.settingsAPI.onUpdated((settings) => applyLocale(settings.language));

  api.onSettingsToggle(() => {
    if (isTimeInput) endTimeInput(false);
    else beginTimeInput();
  });

  // ── 初始布局 ──
  const initial: TimerDisplayState = currentDisplay;
  const tracked = layoutRenderer.apply(initial);
  buttons.setTracked(tracked);
  if (layoutRenderer.layout) {
    api.setHitmap(generateHitmap(store, layoutRenderer.layout));
  }
  breathing.startForState('idle', '');

  // 预加载告示牌加粗圆体，就绪后重绘任务标题
  if (document.fonts?.load) {
    document.fonts
      .load('16px ResourceHanRoundedCN-Bold')
      .then(() => layoutRenderer.refreshPinnedTaskTitle())
      .catch(() => {});
  }

  // ═══════════════════════════
  // 调试模式：Ctrl+Alt+Shift+T 开关
  //   调试模式下：Ctrl+1~8 切换状态机；H 触发庆祝动画
  //   B 键 —— Q弹弹动 demo；C 键 —— 彩带粒子 demo（始终可用）
  // ═══════════════════════════
  let debugMode = false;
  let debugLabel: HTMLDivElement | null = null;

  const DEBUG_STATE_MAP: Record<string, string> = {
    '1': 'idle',
    '2': 'focus',
    '3': 'focusPaused',
    '4': 'prolongation',
    '5': 'waitingRest',
    '6': 'rest',
    '7': 'restPaused',
    '8': 'rageFocus',
  };

  window.addEventListener('keydown', (e) => {
    if (isTimeInput) {
      if (e.key >= '0' && e.key <= '9') {
        if (!e.repeat && timeInputValue.length < 2) {
          timeInputValue += e.key;
          timeCursorVisible = true;
          renderTimeInput();
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'Backspace') {
        if (!e.repeat) {
          timeInputValue = timeInputValue.slice(0, -1);
          timeCursorVisible = true;
          renderTimeInput();
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        if (!e.repeat) commitTimeInput();
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (!e.repeat) endTimeInput(true);
        e.preventDefault();
        return;
      }
      e.preventDefault();
      return;
    }

    if (e.repeat) return;
    const key = e.key.toLowerCase();

    // Ctrl+Alt+Shift+T：切换调试模式
    if (e.ctrlKey && e.altKey && e.shiftKey && key === 't') {
      debugMode = !debugMode;
      if (debugMode) {
        debugLabel = document.createElement('div');
        debugLabel.textContent = t('tomato.debugMode');
        debugLabel.style.cssText =
          'position:fixed;top:4px;left:4px;color:#f44;font:bold 13px monospace;' +
          'background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:3px;z-index:9999;pointer-events:none;';
        document.body.appendChild(debugLabel);
      } else {
        debugLabel?.remove();
        debugLabel = null;
      }
      return;
    }

    // 调试模式专属按键
    if (debugMode) {
      // H：触发庆祝动画
      if (key === 'h' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        api.debugCelebrate();
        return;
      }
      // 数字键直接切换状态机（无需 Ctrl）
      if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
        const state = DEBUG_STATE_MAP[e.key];
        if (state) {
          api.debugSwitchState(state);
          return;
        }
      }
    }

    // B/C demo 键（始终可用）
    if (key === 'b') {
      const layerNames = ['body', 'expr', 'digit', 'btn'];
      const containers = layerNames
        .map((n) => groups.get(n))
        .filter((c): c is PIXI.Container => !!c);
      containers.forEach((ct) => pinAt(ct, BOUNCE_ANCHOR.x, BOUNCE_ANCHOR.y));
      layerNames.forEach((n) => animTargets.register(`demo:${n}`, groups.get(n)!));
      const playback = animPlayer.play({
        name: 'demo:bounce',
        duration: 1500,
        tracks: buildBounceTracks({
          target: layerNames.map((n) => `demo:${n}`),
        }),
      });
      void playback.finished.then(() => containers.forEach(unpin));
    }

    if (key === 'c') {
      const fxCt = groups.get('fx');
      if (!fxCt) return;
      const emitter = new ParticleEmitter(
        {
          colors: [0xe880f1, 0x8fc9ff, 0xff858e, 0x65dd6c],
          area: { x: 0, y: -12, w: CANVAS_W },
          spawnDelay: 0,
          spawnDuration: 1500,
          ratePerSec: 40,
          width: { min: 3, max: 5 },
          height: { min: 6, max: 12 },
          fallSpeed: { min: 60, max: 120 },
          swayAmp: { min: 10, max: 30 },
          swayFreq: { min: 0.5, max: 1.5 },
          rotSpeed: { min: -180, max: 180 },
          lifeMs: { min: 2500, max: 4000 },
        },
        fxCt
      );
      emitter.start();
      animTargets.register('demo:confetti', emitter.container);
      const fade = animPlayer.play({
        name: 'demo:confetti-fade',
        duration: 4000,
        tracks: [
          {
            target: 'demo:confetti',
            property: 'alpha',
            keys: [
              { at: 0, value: 1 },
              { at: 2500, value: 1, easing: 'linear' },
              { at: 4000, value: 0 },
            ],
          },
        ],
      });
      void fade.finished.then(() => {
        emitter.destroy();
        animTargets.unregister('demo:confetti');
      });
    }
  });

  // ── P5 动画后台面板：预览请求处理 ──
  api.onAnimLabPreview((data) => {
    console.log(`[animlab] preview: ${data.id}`, data.params);
    switch (data.id) {
      case 'pulse':
      case 'sync':
      case 'glow':
      case 'bubble':
        // 呼吸动画：重启当前状态的呼吸循环
        breathing.stopAll();
        breathing.startForState(prevState, '');
        break;
      case 'celebration':
        api.debugCelebrate();
        break;
      default:
        // 过渡动画：用调试模式切换到目标状态触发过渡
        console.log(`[animlab] transition preview: ${data.id}`);
        break;
    }
  });

  api.ready();
  console.log('[tomato] M2+ ready');
}

main().catch((err) => {
  console.error('[tomato] init failed:', err);
  const dbg = document.createElement('div');
  dbg.id = 'debug-msg';
  dbg.textContent = `INIT ERROR: ${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(dbg);
});

window.addEventListener('error', (e) => {
  const dbg = document.getElementById('debug-msg') || document.createElement('div');
  dbg.id = 'debug-msg';
  dbg.textContent = `JS ERROR: ${e.message} @ ${e.filename}:${e.lineno}`;
  if (!dbg.parentElement) document.body.appendChild(dbg);
});
