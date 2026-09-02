import type { TaskCard, TaskEdge, TaskFlowData, TaskProject, TaskProjectGroup } from '../../shared/taskflow';
import { makeRoomForInsertedCard } from '../../shared/taskflow-layout';
import { getTaskFlowPreferences, type AppSettings, type TaskFlowPreferences } from '../../shared/settings';
import { clientPointToViewport } from '../../shared/viewport-coordinates';
import { getLocale, setLocale, t, type DictKey } from '../../shared/i18n';
import { TaskFlowHistory } from './history';
import { parseMarkdownLines, parseMarkdownTasks, toggleMarkdownTask } from './markdown';
import { createCard, createEdge, createId, createProject, getProjectCards, getProjectEdges, now, removeCardsAndReconnect } from './model';

const CARD_WIDTH = 286;
const CARD_HEADER_HEIGHT = 70;
const CANVAS_GRID_SIZE = 240;
const CONNECTION_SNAP_RADIUS = 52;
/** 附属文本框最长高度倍率（默认高度的 2 倍后滚轮翻阅） */
const GROUP_OUTLINE_COLORS = [
  { labelKey: 'taskflow.color.coral', value: '#FA7C89' },
  { labelKey: 'taskflow.color.sky', value: '#83B8EA' },
  { labelKey: 'taskflow.color.themeYellow', value: '#F9CD68' },
  { labelKey: 'taskflow.color.grass', value: '#72DB7A' },
  { labelKey: 'taskflow.color.purplePink', value: '#DB82DF' },
] as const;
const LEGACY_GROUP_OUTLINE_COLORS = new Set(['#E880F1', '#8FC9FF', '#65DD6C', '#FF858E']);

const elements = {
  sidebar: document.querySelector<HTMLElement>('#project-sidebar')!,
  projectListScroll: document.querySelector<HTMLElement>('.project-list-scroll')!,
  projectList: document.querySelector<HTMLElement>('#project-list')!,
  newProjectGroup: document.querySelector<HTMLButtonElement>('#new-project-group')!,
  barProjectTitle: document.querySelector<HTMLElement>('#bar-project-title')!,
  viewport: document.querySelector<HTMLElement>('#canvas-viewport')!,
  pan: document.querySelector<HTMLElement>('#canvas-pan')!,
  world: document.querySelector<HTMLElement>('#canvas-world')!,
  groupLayer: document.querySelector<HTMLElement>('#group-layer')!,
  edgeLayer: document.querySelector<SVGSVGElement>('#edge-layer')!,
  cardLayer: document.querySelector<HTMLElement>('#card-layer')!,
  groupHandleLayer: document.querySelector<HTMLElement>('#group-handle-layer')!,
  emptyState: document.querySelector<HTMLElement>('#empty-state')!,
  selectionMarquee: document.querySelector<HTMLElement>('#selection-marquee')!,
  placementPreview: document.querySelector<HTMLElement>('#placement-preview')!,
  placementHint: document.querySelector<HTMLElement>('#placement-hint')!,
  zoomLabel: document.querySelector<HTMLElement>('#zoom-label')!,
  undo: document.querySelector<HTMLButtonElement>('#undo')!,
  redo: document.querySelector<HTMLButtonElement>('#redo')!,
  toast: document.querySelector<HTMLElement>('#toast')!,
  nPanel: document.querySelector<HTMLElement>('#n-panel')!,
  nPanelSearch: document.querySelector<HTMLInputElement>('#n-panel-search')!,
  nPanelSearchResults: document.querySelector<HTMLElement>('#n-panel-search-results')!,
  canvasPanel: document.querySelector<HTMLElement>('.canvas-panel')!,
  archiveDialog: document.querySelector<HTMLElement>('#archive-dialog')!,
  archiveList: document.querySelector<HTMLElement>('#archive-list')!,
  archiveClose: document.querySelector<HTMLButtonElement>('#archive-dialog-close')!,
  dialog: document.querySelector<HTMLElement>('#app-dialog')!,
  dialogTitle: document.querySelector<HTMLElement>('#app-dialog-title')!,
  dialogInput: document.querySelector<HTMLInputElement>('#app-dialog-input')!,
  dialogOk: document.querySelector<HTMLButtonElement>('#app-dialog-ok')!,
  dialogCancel: document.querySelector<HTMLButtonElement>('#app-dialog-cancel')!,
  dialogDontShow: document.querySelector<HTMLElement>('#app-dialog-dont-show')!,
  dialogDontShowCheck: document.querySelector<HTMLInputElement>('#app-dialog-dont-show-check')!,
};

/** 应急回退：APP_LEGACY_CANVAS_TRANSFORM=1 使用改造前的 translate + scale。 */

/** 把当前语言应用到静态 DOM（标题、导航、按钮、aria 标签）。 */
function applyLocaleToDocument(): void {
  document.title = t('taskflow.windowTitle');
  document.documentElement.lang = getLocale();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n as DictKey);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.i18nAria as DictKey));
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((element) => {
    element.setAttribute('title', t(element.dataset.i18nTitle as DictKey));
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((element) => {
    element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder as DictKey));
  });
}
const useLegacyCanvasTransform = new URLSearchParams(window.location.search).get('canvasTransform') === 'legacy';
document.documentElement.classList.add(useLegacyCanvasTransform ? 'canvas-layout-legacy' : 'canvas-layout-zoom');

interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

interface DragState {
  cardIds: string[];
  startClient: { x: number; y: number };
  startPointer: { x: number; y: number };
  startPositions: Map<string, { x: number; y: number }>;
  moved: boolean;
}

interface ConnectionState {
  /** 开始拖线的卡片；从左端点开始时，它是最终连接的 target。 */
  sourceId: string;
  sourceSide: 'in' | 'out';
  pointer: { x: number; y: number };
  snappedTargetId: string | null;
}

type DrawPoint = { x: number; y: number };
type DrawStroke = DrawPoint[];

interface DrawingState {
  cardId: string;
  canvas: HTMLCanvasElement;
  stroke: DrawStroke;
  erasing: boolean;
}

let data: TaskFlowData;
let selectedCardIds = new Set<string>();
let selectedEdgeId: string | null = null;
/** 卡片组的交互层级；主卡与其所有说明框共享同一排序值。 */
const cardGroupStackOrder = new Map<string, number>();
let cardGroupStackCounter = 0;
let transform: ViewportTransform = { x: 70, y: 55, zoom: 1 };
let dragState: DragState | null = null;
/** 由群组右上角拖动柄启动时，用于同步背景框与柄的临时位移。 */
let draggedGroupId: string | null = null;
let connectionState: ConnectionState | null = null;
let snappedConnectionHandle: HTMLElement | null = null;
let quickConnectActive = false;
let quickConnectSourceId: string | null = null;
let lastCanvasPointerDown: { time: number; x: number; y: number } | null = null;
let tightCanvasDoubleClick = false;
let wheelPanTargetX: number | null = null;
let wheelPanFrame: number | null = null;
let drawingState: DrawingState | null = null;
let placementMode: 'task' | 'note' | null = null;
/** 当前拖动卡片是否处于连接线自动插入预览状态 */
let dragInsertionCardId: string | null = null;
/** 拖动独立便签时当前可挂靠的任务卡片。 */
let noteAttachTargetId: string | null = null;
let editingCardId: string | null = null;
/** 当前编辑的字段：标题或正文；null 表示不在编辑 */
let editingField: 'title' | 'body' | null = null;
/** 标题进入编辑前记录的标题区与内部控件坐标，按卡片 id 暂存。 */
interface TitleEditLayout {
  headerHeight: number;
  titleRowHeight: number;
}
const DEFAULT_TITLE_EDIT_LAYOUT: TitleEditLayout = { headerHeight: 66, titleRowHeight: 40 };
const titleEditLayouts = new Map<string, TitleEditLayout>();
/** 已渲染卡片的进度百分比，用于重绘后平滑过渡到新进度。 */
const renderedProgressValues = new Map<string, number>();
/** 已渲染的任务栏项目进度，用于重绘后平滑过渡到新进度。 */
const renderedProjectProgressValues = new Map<string, number>();
/** 上一帧处于选中态的主卡，用于播放连接点的亮灭动画。 */
let renderedSelectedCardIds = new Set<string>();
let saveTimer: number | null = null;
let toastTimer: number | null = null;
let sidebarCollapsed = false;
let marqueeState: { start: { x: number; y: number }; current: { x: number; y: number } } | null = null;
let nPanelOpen = true;
/** 右键菜单当前目标项目 */
let contextProjectId: string | null = null;
/** 右键菜单当前目标卡片 */
let contextCardId: string | null = null;
/** 项目列表拖动排序状态 */
let projectDrag: {
  id: string;
  targetId: string | null;
  placeBefore: boolean;
} | null = null;
let projectPointerDrag: { id: string; startX: number; startY: number; moved: boolean } | null = null;
/** 项目分组拖动排序状态 */
let projectGroupDrag: {
  id: string;
  targetId: string | null;
  placeBefore: boolean;
} | null = null;
/** 说明框尺寸调整状态 */
let noteResize: {
  cardId: string;
  axis: 'width' | 'height';
  startWorld: number;
  startSize: number;
  minSize: number;
  maxSize: number;
} | null = null;
/** 最近一次鼠标位置（用于 Ctrl+N 时判断悬停的卡片） */
let lastPointer = { clientX: 0, clientY: 0 };
/** 最近一次进入编辑态的时间戳；用于在短时间内忽略误触发的 focusout，避免"刚进入就闪退" */
let editEnterAt = 0;
/** 聚焦编辑器时是否需要全选内容（新建卡片/说明框标题时置 true，便于直接编辑） */
let focusSelectAll = false;
/** Ctrl+右键长按拖动切割连接线的状态（记录已切割的连接线，避免重复触发） */
let cuttingEdge = false;
const cutEdges = new Set<string>();
/** 切割轨迹：上次采样点（屏幕坐标，用于插值检测）与轨迹 SVG path */
let cutLastPoint = { x: 0, y: 0 };
let cutTrailEl: SVGPathElement | null = null;
/** 轨迹窗口内的采样点（世界坐标 + 时间戳），只保留最近约 250ms */
let cutTrailPoints: { x: number; y: number; t: number }[] = [];
/** 画布快捷键状态：空格 / Z 用于拖动/缩放 */
let spacePressed = false;
let spaceKeyDown = false;
let shiftKeyDown = false;
let zPressed = false;
let cardShiftAnimationFrame: number | null = null;
let pendingCardShiftAnimation: { shift: number; cardIds: string[] } | null = null;
let taskFlowPreferences: TaskFlowPreferences = {
  shortcuts: {
    taskflowNewProject: 'Ctrl+N',
    taskflowAddCard: 'Shift+A',
    taskflowUndo: 'Ctrl+Z',
    taskflowRedo: 'Ctrl+Y',
    openSettings: 'Ctrl+,',
    taskflowToggleSidebar: 'T',
    taskflowAddNote: 'Ctrl+Shift+A',
    taskflowPlaceTask: 'Ctrl+Shift+B',
    taskflowDetachCard: 'Ctrl+X',
    taskflowGroup: 'Ctrl+G',
    taskflowToggleNPanel: 'N',
  },
  enterSwap: true,
  wheelCtrlSwap: false,
};
/** Z + 左键拖动缩放中；zDragOrigin 为按下时的鼠标位置（作为缩放中心） */
let zDragActive = false;
let zDragOrigin: { x: number; y: number } | null = null;
/** 拖动完成后浏览器仍会派发 click；跳过一次，避免松手时误进入标题编辑。 */
let suppressDraggedCardClick = false;
/** 编辑说明框待恢复的滚动位置：render 重建后交给 rAF 在 autoSize/重排后恢复，避免跳顶 */
let pendingNoteScrollTop: { id: string; top: number } | null = null;
/** 程序主动恢复滚动位置时置 true，避免被 scroll 监听误判为用户主动滚动而清除 */
let restoringNoteScroll = false;
/** 进入正文编辑时的点击坐标（用于把光标定位到点击位置；重建后 textarea 默认在行首） */
let editClickPoint: { x: number; y: number } | null = null;
/** Ctrl+方向键流程导航记忆：fwd/back 各自的源卡 id、目标列表与索引，连续按键在同一列表内循环 */
let navState: { fwd?: { cardId: string; listKey: string; index: number }; back?: { cardId: string; listKey: string; index: number } } = {};
const history = new TaskFlowHistory();

function escapeHTML(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!);
}

/** 让正文 textarea 高度贴合内容，避免阅读态/编辑态切换时的高度抖动。
 *  内容超出时由父容器 .task-card__body 的 overflow:auto 统一滚动（与阅读态一致）。 */
function autoSizeTextarea(editor: HTMLTextAreaElement): void {
  // 先重置高度，让 scrollHeight 反映真实内容高度
  editor.style.height = 'auto';
  const contentHeight = editor.scrollHeight;
  editor.style.height = `${Math.max(82, contentHeight)}px`;
}

/** 预计算编辑态 textarea 高度（16px × 1.7 行高），渲染时直接内联，
 *  避免进入编辑后 rAF 里才把高度从 82px 撑到实际高度导致的卡片闪动 */
function editorPreviewHeight(markdown: string): number {
  const lineCount = Math.max(1, markdown.split('\n').length);
  return Math.max(82, Math.ceil(lineCount * 30.6 + 2));
}

/** 计算 textarea 中 (clientX, clientY) 对应的字符偏移（进入正文编辑时定位光标）。
 *  方案：在 textarea 原位叠一个同宽同字体的透明镜像 div（普通文本节点），用 caretRangeFromPoint
 *  命中镜像返回可靠偏移，直接映射回 textarea；失败时用行估算兜底（坐标归一化到布局系，兼容缩放）。 */
/** 临时调试：记录 textOffsetAt 的定位过程数据，供浏览器自动化/页面面板排查 */
function recordCaretDebug(debug: Record<string, unknown>): void {
  (window as unknown as { __caretDebug?: Record<string, unknown> }).__caretDebug = debug;
}

function textOffsetAt(textarea: HTMLTextAreaElement, clientX: number, clientY: number): number {
  const rect = textarea.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const scale = rect.width / textarea.offsetWidth || 1;
  const debug: Record<string, unknown> = {
    client: [clientX, clientY],
    rect: [rect.left, rect.top, rect.width, rect.height],
    scale,
    valueLen: textarea.value.length,
    valueHead: textarea.value.slice(0, 24).replace(/\n/g, '\\n'),
  };
  if (px < 0 || py < 0 || px > rect.width || py > rect.height) {
    debug.method = 'outside';
    recordCaretDebug(debug);
    return -1;
  }
  const style = getComputedStyle(textarea);

  // 1) 镜像 div + caretRangeFromPoint：普通文本节点定位最精确。
  //    关键：字号/行高必须乘以缩放系数，保证镜像与 textarea 视觉换行一致；
  //    注意：不能设 pointer-events:none——caretRangeFromPoint 的 hit-test 会经过 pointer-events，
  //    设了它镜像就不被命中（实测会穿透到父级 DOM）。透明但保留命中；rAF 内同步创建→命中→移除，
  //    同一帧结束前不参与绘制，用户无感知。
  if (typeof document.caretRangeFromPoint === 'function') {
    const visualFontSize = (parseFloat(style.fontSize) || 16) * scale;
    const visualLineHeight = (parseFloat(style.lineHeight) || visualFontSize * 1.7) * scale;
    const mirror = document.createElement('div');
    mirror.setAttribute('data-caret-mirror', '1'); // 标记，便于切割等操作清理残留（z-index 极高会遮挡 elementFromPoint）
    mirror.style.cssText = [
      'position:fixed',
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${rect.width}px`,
      'margin:0', 'padding:0', 'border:0', 'box-sizing:border-box',
      'opacity:0', 'z-index:999999',
      'white-space:pre-wrap', 'overflow-wrap:break-word', // 与 textarea soft-wrap 断行规则一致（不用 break-all）
      `font-size:${visualFontSize}px`, `font-family:${style.fontFamily}`, `line-height:${visualLineHeight}px`,
      `min-height:${rect.height}px`, // 覆盖 textarea min-height 撑大的空白区，避免部分点击点落在 mirror 外
    ].join(';');
    mirror.textContent = textarea.value;
    document.body.appendChild(mirror);
    let range: Range | null = null;
    let hitOffset = -1;
    try {
      range = document.caretRangeFromPoint(clientX, clientY);
      // 关键：必须在 mirror.remove() 之前保存 offset——Range 在节点被移除后会被浏览器
      // 重新锚定（startContainer/startOffset 改变），若 remove 后再读会得到错误的 BODY 偏移。
      hitOffset = range && typeof range.startOffset === 'number' && mirror.contains(range.startContainer)
        ? Math.min(Math.max(0, range.startOffset), textarea.value.length)
        : -1;
    } finally {
      // 无论是否异常都移除镜像层，避免其遮挡后续 elementFromPoint（如 Ctrl+右键切断连接线）
      mirror.remove();
    }
    const hit = hitOffset >= 0;
    debug.method = 'mirror';
    debug.font = `${visualFontSize}px/${visualLineHeight}px ${style.fontFamily}`;
    debug.caretRange = range ? `${range.startContainer.nodeName}#"${(range.startContainer.textContent || '').slice(0, 10)}" off=${range.startOffset}` : 'null';
    debug.mirrorHit = hit;
    if (hit) {
      debug.result = hitOffset;
      recordCaretDebug(debug);
      return hitOffset;
    }
  }

  // 2) 行估算兜底：点击坐标/宽度归一化到布局坐标系（除以缩放系数）
  const layoutX = (clientX - rect.left) / scale;
  const layoutY = (clientY - rect.top) / scale;
  const lineHeight = parseFloat(style.lineHeight) || Math.round((parseFloat(style.fontSize) || 16) * 1.7);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    debug.method = 'no-canvas';
    recordCaretDebug(debug);
    return -1;
  }
  ctx.font = `${style.fontSize} ${style.fontFamily}`;
  const targetRow = Math.floor(layoutY / lineHeight);
  debug.method = 'estimate';
  debug.layout = [layoutX, layoutY, lineHeight, targetRow];
  const hardLines = textarea.value.split('\n');
  let offset = 0;
  let row = 0;
  for (const line of hardLines) {
    for (const sub of softWrapText(line, ctx, textarea.clientWidth)) {
      if (row === targetRow) {
        const off = offset + charOffsetAt(sub, layoutX, ctx);
        debug.result = off;
        recordCaretDebug(debug);
        return off;
      }
      offset += sub.length;
      row++;
    }
    offset += 1; // 换行符占一个字符
    row++;
  }
  debug.result = textarea.value.length; // 点击点在文本末尾之后
  recordCaretDebug(debug);
  return textarea.value.length;
}

(window as unknown as { __textOffsetAt?: typeof textOffsetAt }).__textOffsetAt = textOffsetAt;

/** 按给定宽度将一行文本软拆为多物理行（与 textarea 默认 wrap 行为近似） */
function softWrapText(text: string, ctx: CanvasRenderingContext2D, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    if (current && ctx.measureText(current + ch).width > width) {
      lines.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** 在物理行内按像素偏移估算字符列号 */
function charOffsetAt(text: string, px: number, ctx: CanvasRenderingContext2D): number {
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    const w = ctx.measureText(text[i]).width;
    if (acc + w / 2 > px) return i;
    acc += w;
  }
  return text.length;
}

function activeProject(): TaskProject | undefined {
  return data.projects.find((project) => project.id === data.activeProjectId);
}

function activeCards(): TaskCard[] {
  return data.activeProjectId ? getProjectCards(data, data.activeProjectId) : [];
}

function activeEdges(): TaskEdge[] {
  return data.activeProjectId ? getProjectEdges(data, data.activeProjectId) : [];
}

/** 在重建为输入框前记录阅读态标题区高度，坐标需换算回画布逻辑尺寸。 */
function captureTitleEditLayout(cardId: string, cardElement: HTMLElement): void {
  const header = cardElement.querySelector<HTMLElement>('.task-card__header');
  const progress = cardElement.querySelector<HTMLElement>('.task-card__progress');
  if (!header || !progress) return;

  const headerRect = header.getBoundingClientRect();
  const scale = transform.zoom;
  const headerHeight = headerRect.height / scale;
  if (headerHeight <= 0) return;
  const progressTop = (progress.getBoundingClientRect().top - headerRect.top) / scale;
  const progressOffset = Number.parseFloat(getComputedStyle(progress).top) || 0;
  const headerPaddingTop = Number.parseFloat(getComputedStyle(header).paddingTop) || 0;
  titleEditLayouts.set(cardId, {
    headerHeight,
    // 进度条自身的相对上移不参与网格排版，先还原其流式位置再扣除顶部内边距。
    titleRowHeight: progressTop - progressOffset - headerPaddingTop,
  });
}

/** 将主卡与其全部附属说明框作为同一层级组置于最前。 */
function bringCardGroupToFront(card: TaskCard): void {
  const rootId = card.parentId ?? card.id;
  cardGroupStackOrder.set(rootId, ++cardGroupStackCounter);
  for (const element of elements.cardLayer.querySelectorAll<HTMLElement>('.task-card, .task-note')) {
    const elementRootId = element.dataset.noteParent ?? element.dataset.cardId;
    if (elementRootId) element.style.zIndex = String(cardGroupStackOrder.get(elementRootId) ?? 0);
  }
}

/** 清理空群组：群组位置由成员卡片包围盒推导，删光组内卡片（或全部移出）后画布无法渲染其外框，
 *  右键菜单无对象可点、"失效"。历史上删除卡片不清理组（removeCardsAndReconnect 只动 cards/edges），
 *  会留下幽灵组；返回是否剪掉了组，便于启动时决定是否需要落盘。 */
function pruneEmptyGroups(): boolean {
  const usedGroupIds = new Set(data.cards.map((card) => card.groupId).filter((id): id is string => Boolean(id)));
  const before = data.groups.length;
  data.groups = data.groups.filter((group) => usedGroupIds.has(group.id));
  return data.groups.length !== before;
}

function mutate(mutator: () => void, message?: string): void {
  history.push(data);
  mutator();
  pruneEmptyGroups();
  render();
  scheduleSave();
  // 操作完成不再弹出提示；错误提示（例如保存失败）仍由 showToast 单独处理。
  void message;
}

function scheduleSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    saveTimer = null;
    try {
      await window.taskFlowAPI.save(data);
    } catch (error) {
      console.error('[taskflow] save failed', error);
      showToast(t('taskflow.toast.saveFailed'), 4000);
    }
  }, 220);
}

function showToast(message: string, duration = 2200): void {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, duration);
}

function applyTransform(): void {
  if (useLegacyCanvasTransform) {
    elements.pan.style.left = '0px';
    elements.pan.style.top = '0px';
    elements.world.style.removeProperty('zoom');
    elements.world.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`;
  } else {
    elements.world.style.transform = 'none';
    elements.world.style.setProperty('zoom', String(transform.zoom));
    elements.pan.style.left = `${transform.x}px`;
    elements.pan.style.top = `${transform.y}px`;
  }
  const gridSize = CANVAS_GRID_SIZE * transform.zoom;
  const gridMajorLine = Math.max(1.2, 2.16 * transform.zoom);
  const gridFineLine = Math.max(1.6, 2.2 * transform.zoom);
  elements.viewport.style.setProperty('--canvas-grid-size', `${gridSize}px`);
  elements.viewport.style.setProperty('--canvas-grid-fine-size', `${gridSize / 5}px`);
  elements.viewport.style.setProperty('--canvas-grid-major-line', `${gridMajorLine}px`);
  elements.viewport.style.setProperty('--canvas-grid-fine-line', `${gridFineLine}px`);
  elements.viewport.style.setProperty('--canvas-grid-offset-x', `${transform.x}px`);
  elements.viewport.style.setProperty('--canvas-grid-offset-y', `${transform.y}px`);
  elements.zoomLabel.textContent = `${Math.round(transform.zoom * 100)}%`;
  const project = activeProject();
  if (project) project.viewport = { ...transform };
}

function restoreProjectTransform(projectId: string | null): boolean {
  const viewport = data.projects.find((project) => project.id === projectId)?.viewport;
  if (!viewport || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom)) {
    transform = { x: 70, y: 55, zoom: 1 };
    return false;
  }
  transform = { x: viewport.x, y: viewport.y, zoom: Math.min(2, Math.max(0.25, viewport.zoom)) };
  return true;
}

function activateProject(projectId: string | null): boolean {
  cancelWheelPan();
  data.activeProjectId = projectId;
  return restoreProjectTransform(projectId);
}

function viewportLayoutSize(): { width: number; height: number } {
  const rect = elements.viewport.getBoundingClientRect();
  return {
    width: elements.viewport.clientWidth || rect.width,
    height: elements.viewport.clientHeight || rect.height,
  };
}

function clientToViewport(clientX: number, clientY: number): { x: number; y: number } {
  const rect = elements.viewport.getBoundingClientRect();
  return clientPointToViewport(clientX, clientY, rect, viewportLayoutSize());
}

function clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const point = clientToViewport(clientX, clientY);
  return {
    x: (point.x - transform.x) / transform.zoom,
    y: (point.y - transform.y) / transform.zoom,
  };
}

/** 卡片实际测量高度缓存（渲染后由 layoutNoteCards 更新，供位置计算与 min-height 使用） */
const measuredHeights = new Map<string, number>();

/** 卡片高度估算（作为逻辑高度兜底）。渲染后会尽量用实测高度缓存覆盖。 */
function cardHeight(card: TaskCard): number {
  // 附属文本框子卡片不参与普通卡片布局，由单独渲染处理
  if (card.parentId) return 0;
  if (isStandaloneNote(card)) {
    if (card.noteMode === 'draw') return CARD_WIDTH;
    return measuredHeights.get(card.id) ?? CARD_WIDTH;
  }
  const measured = measuredHeights.get(card.id);
  if (measured != null) return measured;
  const lineCount = Math.max(1, card.markdown.split('\n').length);
  return Math.max(154, 105 + lineCount * 28);
}

function connectionPoint(card: TaskCard, side: 'in' | 'out'): { x: number; y: number } {
  // 端点对齐卡片两侧常驻连接点的中轴（与 CSS .connection-handle 保持一致：top:23.1, height:37.8）
  const handleOffsetY = 23.1 + 37.8 / 2;
  return {
    x: card.x + (side === 'out' ? CARD_WIDTH : 0),
    y: card.y + handleOffsetY,
  };
}

function edgePath(source: { x: number; y: number }, target: { x: number; y: number }): string {
  // 控制点始终沿连接点"向外"方向延伸：source 是 out（卡片右缘）向右，target 是 in（卡片左缘）向左。
  // 这样无论两卡在 x/y 轴如何错位，曲线都先从连接点向外伸出，不会钻回卡片内部被遮挡。
  const distance = Math.max(80, Math.abs(target.x - source.x) * 0.45);
  return `M ${source.x} ${source.y} C ${source.x + distance} ${source.y}, ${target.x - distance} ${target.y}, ${target.x} ${target.y}`;
}

/** 项目排序：置顶的排最前（多个置顶按 pinnedAt 倒序，后置顶优先），其余按 sortOrder 降序 */
function sortProjects(): TaskProject[] {
  const pinned = data.projects.filter((p) => p.pinnedAt);
  const rest = data.projects.filter((p) => !p.pinnedAt);
  pinned.sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0) || (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''));
  rest.sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0));
  return [...pinned, ...rest];
}

function renderProjects(): void {
  const projects = sortProjects().filter((project) => !project.archived);
  const progressTransitions: Array<{ projectId: string; to: number }> = [];
  const renderProject = (project: TaskProject): string => {
    const cards = getProjectCards(data, project.id).filter(isTaskCard);
    const completed = cards.filter((card) => card.completed).length;
    const progress = cards.length ? (completed / cards.length) * 100 : 0;
    const previousProgress = renderedProjectProgressValues.get(project.id) ?? progress;
    if (previousProgress !== progress) progressTransitions.push({ projectId: project.id, to: progress });
    renderedProjectProgressValues.set(project.id, progress);
    const hasPin = cards.some((card) => card.id === data.pinnedCardId);
    return `
      <div class="project-item ${project.id === data.activeProjectId ? 'is-active' : ''} ${project.pinnedAt ? 'is-pinned' : ''}"
        data-project-id="${project.id}" data-project-order="${project.pinnedAt ? 'pinned' : 'rest'}">
        <span class="project-item__progress-fill" data-project-progress-fill="${project.id}" style="width:${previousProgress}%"></span>
        <span class="project-item__handle" data-sort-handle="${project.id}" draggable="false" title="${t('taskflow.sidebar.dragToSort')}"></span>
        <span class="project-item__title">${hasPin ? '<span class="project-item__pin"></span>' : ''}${escapeHTML(project.title)}</span>
        <span class="project-item__progress">${completed}/${cards.length}</span>
      </div>`;
  };
  const pinned = projects.filter((project) => project.pinnedAt);
  const unpinned = projects.filter((project) => !project.pinnedAt);
  const groups = [...data.projectGroups].sort((a, b) => b.sortOrder - a.sortOrder);
  const validGroupIds = new Set(groups.map((group) => group.id));
  const groupedHtml = groups.map((group) => {
    const children = unpinned.filter((project) => project.sidebarGroupId === group.id);
    return `<section class="project-group ${group.collapsed ? 'is-collapsed' : ''}" data-project-group-id="${group.id}">
      <button class="project-group__header" data-project-group-toggle="${group.id}" data-project-group-drag="${group.id}" draggable="true" title="${t('taskflow.sidebar.groupToggleHint')}">
        <span class="project-group__chevron" aria-hidden="true"></span>
        <span>${escapeHTML(group.title)}</span>
      </button>
      <div class="project-group__body"><div class="project-group__body-inner">${children.map(renderProject).join('')}</div></div>
    </section>`;
  }).join('');
  const ungrouped = unpinned.filter((project) => !project.sidebarGroupId || !validGroupIds.has(project.sidebarGroupId));
  elements.projectList.innerHTML = `${pinned.length ? `<div class="project-list__section-label">${t('taskflow.sidebar.pinned')}</div>` : ''}${pinned.map(renderProject).join('')}
    ${groupedHtml}
    ${ungrouped.length && groups.length ? `<div class="project-list__section-label">${t('taskflow.sidebar.ungrouped')}</div>` : ''}${ungrouped.map(renderProject).join('')}`;

  if (progressTransitions.length) {
    requestAnimationFrame(() => {
      for (const transition of progressTransitions) {
        const fill = elements.projectList.querySelector<HTMLElement>(`[data-project-progress-fill="${transition.projectId}"]`);
        if (fill) fill.style.width = `${transition.to}%`;
      }
    });
  }
}

function visibleSidebarProjects(): TaskProject[] {
  const projects = sortProjects().filter((project) => !project.archived);
  const pinned = projects.filter((project) => project.pinnedAt);
  const unpinned = projects.filter((project) => !project.pinnedAt);
  const groups = [...data.projectGroups].sort((a, b) => b.sortOrder - a.sortOrder);
  const groupIds = new Set(groups.map((group) => group.id));
  return [
    ...pinned,
    ...groups.flatMap((group) => group.collapsed ? [] : unpinned.filter((project) => project.sidebarGroupId === group.id)),
    ...unpinned.filter((project) => !project.sidebarGroupId || !groupIds.has(project.sidebarGroupId)),
  ];
}

function renderInlineMarkdown(value: string): string {
  const code: string[] = [];
  let html = escapeHTML(value).replace(/`([^`]+)`/g, (_match, content: string) => {
    const index = code.push(`<code>${content}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? '');
}

function renderMarkdown(card: TaskCard): string {
  if (!card.markdown) return `<p>${t('taskflow.note.placeholder')}</p>`;
  return parseMarkdownLines(card.markdown).map((line) => {
    switch (line.kind) {
      case 'task':
        return `<label class="markdown-task ${line.checked ? 'is-checked' : ''}" style="margin-left:${line.indent * 18}px">
          <input type="checkbox" data-action="toggle-subtask" data-line="${line.sourceLine}" ${line.checked ? 'checked' : ''} />
          <span>${renderInlineMarkdown(line.text)}</span>
        </label>`;
      case 'blank': return '<p class="markdown-blank"></p>';
      case 'heading': return `<div class="markdown-heading markdown-heading--${line.level}">${renderInlineMarkdown(line.text)}</div>`;
      case 'unordered-list': return `<div class="markdown-list-item" style="margin-left:${line.indent * 18}px"><span class="markdown-list-marker">•</span><span>${renderInlineMarkdown(line.text)}</span></div>`;
      case 'ordered-list': return `<div class="markdown-list-item" style="margin-left:${line.indent * 18}px"><span class="markdown-list-marker">${line.number}.</span><span>${renderInlineMarkdown(line.text)}</span></div>`;
      case 'quote': return `<div class="markdown-quote">${renderInlineMarkdown(line.text)}</div>`;
      case 'code': return `<pre class="markdown-code"><code>${escapeHTML(line.text)}</code></pre>`;
      case 'horizontal-rule': return '<hr class="markdown-rule" />';
      case 'paragraph': return `<p>${renderInlineMarkdown(line.text)}</p>`;
    }
  }).join('');
}

/** 说明框阅读态与任务卡片使用同一套 Markdown 子集，保证格式表现一致。 */
function renderNoteMarkdown(card: TaskCard): string {
  if (!card.markdown) return `<p class="task-note__placeholder">${t('taskflow.note.attachedPlaceholder')}</p>`;
  return renderMarkdown(card);
}

function hasCardBodyTextSelection(target: HTMLElement): boolean {
  // 拖选结束时 pointerup 后仍会产生 click，且 click 可能落在画布任意位置
  // （包括离开原卡片后落到的空白或相邻卡片）。只要画布存在非空文本选区，
  // 一律视为拖选，避免执行卡片操作触发 render() 重建 DOM 清空选区。
  void target;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

let standaloneNoteSelection: {
  pointerId: number;
  body: HTMLElement;
  startX: number;
  startY: number;
  anchorNode: Node | null;
  anchorOffset: number;
  editor: HTMLTextAreaElement | null;
  editorAnchorOffset: number;
  moved: boolean;
} | null = null;
let suppressStandaloneNoteClick = false;

function beginStandaloneNoteTextSelection(event: PointerEvent, target: HTMLElement): void {
  if (event.button !== 0) return;
  const body = target.closest<HTMLElement>('.task-note--standalone .task-note__body');
  if (!body || target.closest('[data-drag-handle], [data-note-resize], [data-note-height-resize], button, [data-action]')) return;
  const editor = target.closest<HTMLTextAreaElement>('textarea[data-editor="body"]');
  const selection = window.getSelection();
  const editorAnchorOffset = editor ? textOffsetAt(editor, event.clientX, event.clientY) : -1;
  standaloneNoteSelection = {
    pointerId: event.pointerId,
    body,
    startX: event.clientX,
    startY: event.clientY,
    anchorNode: selection?.anchorNode ?? null,
    anchorOffset: selection?.anchorOffset ?? 0,
    editor,
    editorAnchorOffset: Math.max(0, editorAnchorOffset),
    moved: false,
  };
  elements.viewport.classList.add('is-text-selecting');
  if (editor && editorAnchorOffset >= 0) {
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editorAnchorOffset, editorAnchorOffset);
    event.preventDefault();
  }
}

function extendStandaloneNoteTextSelection(event: PointerEvent): void {
  const state = standaloneNoteSelection;
  if (!state || state.pointerId !== event.pointerId) return;
  state.moved ||= Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 3;
  if (!state.moved) return;
  if (state.editor) {
    const rect = state.body.getBoundingClientRect();
    if (event.clientY < rect.top) state.body.scrollTop -= rect.top - event.clientY;
    else if (event.clientY > rect.bottom) state.body.scrollTop += event.clientY - rect.bottom;
    let endOffset = textOffsetAt(state.editor, event.clientX, event.clientY);
    if (event.clientY <= rect.top && state.body.scrollTop <= 0) endOffset = 0;
    if (event.clientY >= rect.bottom && state.body.scrollTop >= state.body.scrollHeight - state.body.clientHeight) {
      endOffset = state.editor.value.length;
    }
    const start = state.editorAnchorOffset;
    state.editor.setSelectionRange(Math.min(start, endOffset), Math.max(start, endOffset), endOffset < start ? 'backward' : 'forward');
    event.preventDefault();
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  if (!state.anchorNode) {
    state.anchorNode = selection.anchorNode;
    state.anchorOffset = selection.anchorOffset;
  }
  if (!state.anchorNode) return;
  const rect = state.body.getBoundingClientRect();
  if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (!range) return;
  selection.removeAllRanges();
  const selectedRange = document.createRange();
  selectedRange.setStart(state.anchorNode, state.anchorOffset);
  selectedRange.setEnd(range.startContainer, range.startOffset);
  selection.addRange(selectedRange);
  event.preventDefault();
}

function endStandaloneNoteTextSelection(event: PointerEvent): void {
  const state = standaloneNoteSelection;
  if (!state || state.pointerId !== event.pointerId) return;
  if (state.moved) {
    suppressStandaloneNoteClick = true;
    window.setTimeout(() => { suppressStandaloneNoteClick = false; }, 0);
  }
  standaloneNoteSelection = null;
  window.setTimeout(() => elements.viewport.classList.remove('is-text-selecting'), 0);
}

/** 附属文本框：父卡片底部下方第一个文本框的 y 坐标 */
function noteParentY(parent: TaskCard): number {
  return parent.y + cardHeight(parent) + 10;
}

/** 计算打组卡片的外围最小包围盒，背景始终位于所有卡片下方。 */
function renderGroupBoxes(): void {
  const groups = data.groups ?? [];
  const groupById = new Map<string, { cards: TaskCard[] }>();
  for (const card of activeCards()) {
    if (!card.groupId) continue;
    const grp = groups.find((g) => g.id === card.groupId);
    if (!grp) continue;
    const entry = groupById.get(card.groupId) ?? { cards: [] };
    entry.cards.push(card);
    groupById.set(card.groupId, entry);
  }
  const backdrops: string[] = [];
  const handles: string[] = [];
  for (const [groupId, { cards: groupCards }] of groupById) {
    if (groupCards.length === 0) continue;
    // 计算最小包围盒（含附属文本框）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of groupCards) {
      const w = CARD_WIDTH;
      const h = cardHeight(c);
      const x = c.x, y = c.y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
      // 包含附属文本框
      const notes = activeCards().filter((n) => n.parentId === c.id);
      let ny = y + h + 10;
      for (const n of notes) {
        const nw = noteWidth(n);
        const nh = noteHeight(n, nw);
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, ny);
        maxX = Math.max(maxX, n.x + nw);
        maxY = Math.max(maxY, ny + nh);
        ny += nh + 8;
      }
    }
    if (!isFinite(minX)) continue;
    const pad = 12;
    const savedColor = groups.find((group) => group.id === groupId)?.color || '#FFC454';
    const color = LEGACY_GROUP_OUTLINE_COLORS.has(savedColor.toUpperCase()) ? '#FFC454' : savedColor;
    backdrops.push(`<div class="group-box" data-group-box="${groupId}" data-group-id="${groupId}" style="--group-outline:${color};left:${minX - pad}px;top:${minY - pad}px;width:${maxX - minX + pad * 2}px;height:${maxY - minY + pad * 2}px;"></div>`);
    handles.push(`<button class="group-box__drag-handle" data-group-drag-handle="${groupId}" style="--group-outline:${color};left:${maxX - 16}px;top:${minY - pad}px;" title="${t('taskflow.canvas.dragGroup')}" aria-label="${t('taskflow.canvas.dragGroup')}"><span></span><span></span><span></span><span></span></button>`);
  }
  elements.groupLayer.innerHTML = backdrops.join('');
  elements.groupHandleLayer.innerHTML = handles.join('');
}

function beginGroupDrag(event: PointerEvent): void {
  const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-group-drag-handle]');
  if (!handle || event.button !== 0) return;
  const groupId = handle.dataset.groupDragHandle!;
  const groupCards = activeCards().filter((card) => card.groupId === groupId && !card.parentId);
  if (!groupCards.length) return;
  event.preventDefault();
  event.stopPropagation();
  if (editingCardId && editingField) commitEditing(undefined, true);
  const cardIds = groupCards.map((card) => card.id);
  dragState = {
    cardIds,
    startClient: { x: event.clientX, y: event.clientY },
    startPointer: clientToWorld(event.clientX, event.clientY),
    startPositions: new Map(groupCards.map((card) => [card.id, { x: card.x, y: card.y }])),
    moved: false,
  };
  draggedGroupId = groupId;
}

/** 渲染附属文本框（支持多个，按父卡片分组后从上到下排列） */
function renderNoteCard(card: TaskCard, position: { x: number; y: number; zIndex: number; attached: boolean }): string {
  const isCollapsed = position.attached && Boolean(card.noteCollapsed);
  const editingTitle = editingCardId === card.id && editingField === 'title';
  const editingBody = editingCardId === card.id && editingField === 'body';
  const selected = selectedCardIds.has(card.id);
  const drawingMode = card.noteMode === 'draw';
  const width = position.attached ? noteWidth(card) : CARD_WIDTH;
  const height = noteHeight(card, width, position.attached ? 154 : CARD_WIDTH);
  const fixedHeight = position.attached || drawingMode || card.noteHeight !== undefined ? height : null;
  const title = card.title || t('taskflow.note.fallbackTitle');
  const body = drawingMode
    ? '<div class="task-note__drawing"><canvas class="task-note__canvas" data-note-canvas></canvas></div>'
    : `<div class="task-note__body${editingBody ? ' is-editing' : ''}" data-action="edit-body" data-note-body="1">
        ${editingBody ? `<textarea class="card-editor" data-editor="body" style="height:${editorPreviewHeight(card.markdown)}px">${escapeHTML(card.markdown)}</textarea>` : renderNoteMarkdown(card)}
      </div>`;
  return `
    <div class="task-note ${position.attached ? '' : 'task-note--standalone'} ${card.noteHeight !== undefined ? 'is-height-adjusted' : ''} ${drawingMode ? 'is-drawing' : ''} ${isCollapsed ? 'is-collapsed' : ''} ${selected ? 'is-selected' : ''} ${editingTitle || editingBody ? 'is-editing' : ''} ${editingBody ? 'is-body-editing' : ''}"
      data-card-id="${card.id}"${position.attached ? ` data-note-parent="${card.parentId}"` : ''} style="z-index:${position.zIndex};left:${position.x}px;top:${position.y}px;width:${width}px${fixedHeight ? `;height:${fixedHeight}px` : ''}">
      <div class="task-note__head${editingTitle ? ' is-title-editing' : ''}" data-note-head="1"${position.attached ? '' : ' data-drag-handle="true"'}>
        ${position.attached ? `<button class="task-note__toggle" data-note-toggle="collapse" title="${isCollapsed ? t('taskflow.note.expand') : t('taskflow.note.collapse')}">${isCollapsed
          ? '<svg class="note-chevron note-chevron--right" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5 L10.5 6 L2.5 10.5 Z" /></svg>'
          : '<svg class="note-chevron note-chevron--down" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 2.5 L6 10.5 L10.5 2.5 Z" /></svg>'}</button>` : ''}
        ${editingTitle ? `<input class="title-editor note-title-editor" data-editor="title" value="${escapeHTML(card.title)}" />` : `<span class="task-note__title" data-note-title="1">${escapeHTML(title)}</span>`}
        <button class="task-note__mode" data-note-mode title="${drawingMode ? t('taskflow.note.switchToText') : t('taskflow.note.switchToDraw')}">${drawingMode
          ? '<svg class="note-mode-icon note-mode-icon--pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.3-5.1L15.8 4.4l3.8 3.8L9.1 18.7 4 20Z" /><path d="m5.3 14.9 3.8 3.8" /><path d="m15.8 4.4 1.7-1.7a1.35 1.35 0 0 1 1.9 0l1.9 1.9a1.35 1.35 0 0 1 0 1.9l-1.7 1.7" /><path class="note-mode-icon__tip" d="M4.35 19.65Q4.13 19.95 4.48 20.03L8.55 18.98 5.32 15.75Z" /></svg>'
          : '<svg class="note-mode-icon note-mode-icon--text" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14" /><path d="M12 5v14" /></svg>'}</button>
        <button class="task-note__remove" data-note-remove title="${t('taskflow.note.delete')}">×</button>
      </div>
      ${isCollapsed ? '' : `${body}${position.attached ? `<div class="task-note__resize" data-note-resize title="${t('taskflow.note.resizeWidth')}"></div>` : ''}<div class="task-note__height-resize" data-note-height-resize title="${t('taskflow.note.resizeHeight')}"></div>`}
    </div>`;
}

function pointSegmentDistance(point: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

/** 通过世界坐标命中连接线，避免 SVG pointer-events 层级影响放置插入。 */
function edgeAtWorldPoint(point: { x: number; y: number }): TaskEdge | undefined {
  const cards = new Map(activeCards().map((card) => [card.id, card]));
  const hitRadius = 18 / Math.max(transform.zoom, 0.25);
  for (const edge of activeEdges()) {
    const source = cards.get(edge.sourceId);
    const target = cards.get(edge.targetId);
    if (!source || !target || !isTaskCard(source) || !isTaskCard(target)) continue;
    const start = connectionPoint(source, 'out');
    const end = connectionPoint(target, 'in');
    const distance = Math.max(80, Math.abs(end.x - start.x) * 0.45);
    const controlStart = { x: start.x + distance, y: start.y };
    const controlEnd = { x: end.x - distance, y: end.y };
    const curveLengthEstimate = Math.hypot(controlStart.x - start.x, controlStart.y - start.y)
      + Math.hypot(controlEnd.x - controlStart.x, controlEnd.y - controlStart.y)
      + Math.hypot(end.x - controlEnd.x, end.y - controlEnd.y);
    const samples = Math.min(320, Math.max(32, Math.ceil(curveLengthEstimate / 8)));
    let previous = start;
    for (let index = 1; index <= samples; index += 1) {
      const t = index / samples;
      const inverse = 1 - t;
      const current = {
        x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * controlStart.x + 3 * inverse * t ** 2 * controlEnd.x + t ** 3 * end.x,
        y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * controlStart.y + 3 * inverse * t ** 2 * controlEnd.y + t ** 3 * end.y,
      };
      if (pointSegmentDistance(point, previous, current) <= hitRadius) return edge;
      previous = current;
    }
  }
  return undefined;
}

function edgeAtClientPoint(clientX: number, clientY: number): TaskEdge | undefined {
  const edgeId = document.elementsFromPoint(clientX, clientY)
    .map((element) => element.closest<SVGElement>('[data-edge-hit]')?.dataset.edgeHit)
    .find((id): id is string => Boolean(id))
    ?? edgeAtWorldPoint(clientToWorld(clientX, clientY))?.id;
  return edgeId ? activeEdges().find((edge) => edge.id === edgeId) : undefined;
}

function insertCardIntoEdge(card: TaskCard, edge: TaskEdge): void {
  data.edges = data.edges.filter((item) => item.id !== edge.id);
  data.edges.push(
    createEdge(edge.projectId, edge.sourceId, card.id),
    createEdge(edge.projectId, card.id, edge.targetId),
  );
}

function detachSelectedCardFromFlow(): void {
  if (selectedCardIds.size !== 1) return;
  const card = data.cards.find((item) => item.id === [...selectedCardIds][0]);
  if (!card || !isTaskCard(card)) return;
  const attached = activeEdges().filter((edge) => edge.sourceId === card.id || edge.targetId === card.id);
  if (!attached.length) return;
  const incoming = attached.filter((edge) => edge.targetId === card.id);
  const outgoing = attached.filter((edge) => edge.sourceId === card.id);
  mutate(() => {
    data.edges = data.edges.filter((edge) => !attached.some((item) => item.id === edge.id));
    for (const before of incoming) {
      for (const after of outgoing) {
        if (before.sourceId === after.targetId) continue;
        const exists = data.edges.some((edge) => edge.sourceId === before.sourceId && edge.targetId === after.targetId);
        if (!exists) data.edges.push(createEdge(card.projectId, before.sourceId, after.targetId));
      }
    }
  }, t('taskflow.toast.unlinked'));
}

function clearConnectionSnap(): void {
  snappedConnectionHandle?.classList.remove('is-snap-target');
  snappedConnectionHandle = null;
}

function connectionSnapTarget(
  clientX: number,
  clientY: number,
  sourceId: string,
  targetSide: 'in' | 'out',
): { id: string; point: { x: number; y: number }; handle: HTMLElement } | null {
  let best: { id: string; point: { x: number; y: number }; handle: HTMLElement; distance: number } | null = null;
  for (const handle of elements.cardLayer.querySelectorAll<HTMLElement>(`[data-handle="${targetSide}"]`)) {
    const cardElement = handle.closest<HTMLElement>('[data-card-id]');
    const id = cardElement?.dataset.cardId;
    if (!id || id === sourceId) continue;
    const rect = handle.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    // Keep a generous screen-space target while respecting enlarged handles.
    const distance = dx * dx + dy * dy;
    const snapRadius = Math.max(CONNECTION_SNAP_RADIUS, Math.max(rect.width, rect.height) * 1.35);
    if (distance > snapRadius * snapRadius) continue;
    if (!best || distance < best.distance) {
      best = { id, point: clientToWorld(centerX, centerY), handle, distance };
    }
  }
  return best;
}

function exitQuickConnectMode(shouldRender = true): void {
  const wasActive = quickConnectActive || quickConnectSourceId !== null;
  quickConnectActive = false;
  quickConnectSourceId = null;
  elements.viewport.classList.remove('is-quick-connecting');
  if (shouldRender && wasActive) render();
}

function enterQuickConnectMode(): void {
  if (quickConnectActive) return;
  if (editingCardId) commitEditing(undefined, true);
  quickConnectActive = true;
  quickConnectSourceId = null;
  selectedCardIds.clear();
  selectedEdgeId = null;
  elements.viewport.classList.add('is-quick-connecting');
  render();
}

function chooseQuickConnectCard(card: TaskCard): void {
  if (!quickConnectActive || !isTaskCard(card) || !data.activeProjectId) return;
  if (!quickConnectSourceId) {
    quickConnectSourceId = card.id;
    selectedCardIds = new Set([card.id]);
    render();
    return;
  }
  if (quickConnectSourceId === card.id) {
    quickConnectSourceId = null;
    selectedCardIds.clear();
    render();
    return;
  }

  const sourceId = quickConnectSourceId;
  const exists = data.edges.some((edge) => edge.sourceId === sourceId && edge.targetId === card.id);
  quickConnectSourceId = null;
  selectedCardIds.clear();
  if (exists) {
    render();
    return;
  }
  mutate(() => data.edges.push(createEdge(data.activeProjectId!, sourceId, card.id)));
}

function queueWheelPan(deltaX: number): void {
  const normalizedDelta = deltaX * 1.4;
  wheelPanTargetX = (wheelPanTargetX ?? transform.x) - normalizedDelta;
  if (wheelPanFrame !== null) return;
  const animate = () => {
    const target = wheelPanTargetX;
    if (target === null) {
      wheelPanFrame = null;
      return;
    }
    const remaining = target - transform.x;
    if (Math.abs(remaining) < 0.25) {
      transform.x = target;
      wheelPanTargetX = null;
      applyTransform();
      wheelPanFrame = null;
      scheduleSave();
      return;
    }
    transform.x += remaining * 0.28;
    applyTransform();
    wheelPanFrame = requestAnimationFrame(animate);
  };
  wheelPanFrame = requestAnimationFrame(animate);
}

function cancelWheelPan(): void {
  if (wheelPanFrame !== null) cancelAnimationFrame(wheelPanFrame);
  wheelPanFrame = null;
  wheelPanTargetX = null;
}

function renderNoteCards(noteCards: TaskCard[]): string {
  const byParent = new Map<string, TaskCard[]>();
  for (const note of noteCards) {
    if (!data.cards.find((c) => c.id === note.parentId)) continue;
    const list = byParent.get(note.parentId!) ?? [];
    list.push(note);
    byParent.set(note.parentId!, list);
  }
  let html = '';
  for (const [parentId, notes] of byParent) {
    const parent = data.cards.find((c) => c.id === parentId)!;
    let cursorY = noteParentY(parent);
    for (const card of notes) {
      const height = noteHeight(card, noteWidth(card));
      html += renderNoteCard(card, { x: parent.x, y: cursorY, zIndex: cardGroupStackOrder.get(parent.id) ?? 0, attached: true });
      cursorY += height + 8;
    }
  }
  return html;
}

/** 附属文本框宽度（默认 = 卡片宽度，可拖大到最多 2 倍，不可缩短） */
function noteWidth(card: TaskCard): number {
  return card.noteWidth ?? CARD_WIDTH;
}

/** 附属文本框展开高度：默认 = 宽度的两倍，文本超长自动加长（最多默认的 2 倍），再长滚轮翻阅 */
function noteHeight(card: TaskCard, w: number, minHeight = 154): number {
  if (card.noteCollapsed) return 30;
  if (card.noteHeight !== undefined) return Math.max(46, card.noteHeight);
  if (card.noteMode === 'draw') return CARD_WIDTH;
  // 最短 = 卡片默认高度(154)，最长 = 两倍(308)；内容再长靠 body 内部滚动
  const lineCount = Math.max(1, card.markdown.split('\n').length);
  const contentHeight = Math.max(minHeight, lineCount * 24 + 28);
  return Math.min(contentHeight, Math.max(minHeight, 154 * 2));
}

function renderCards(): void {
  const allCards = activeCards();
  const mainCards = allCards.filter(isTaskCard);
  const noteCards = allCards.filter((card) => card.parentId);
  const standaloneNotes = allCards.filter(isStandaloneNote);
  const progressTransitions: Array<{ cardId: string; to: number }> = [];
  const nextSelectedCardIds = new Set(mainCards.filter((card) => selectedCardIds.has(card.id)).map((card) => card.id));

  renderGroupBoxes();
  elements.cardLayer.innerHTML = `${mainCards.map((card) => {
    const tasks = parseMarkdownTasks(card.markdown);
    const checked = tasks.filter((task) => task.checked).length;
    // 无勾选框任务时进度条全黄（100%），有任务时按完成比例填充
    const percent = tasks.length ? Math.round((checked / tasks.length) * 100) : 100;
    const previousPercent = renderedProgressValues.get(card.id) ?? percent;
    if (previousPercent !== percent) progressTransitions.push({ cardId: card.id, to: percent });
    renderedProgressValues.set(card.id, percent);
    const progress = `<div class="task-card__progress"><div class="task-card__progress__fill" data-progress-fill="${card.id}" style="width:${previousPercent}%"></div></div>`;
    const selected = selectedCardIds.has(card.id);
    const quickConnectSource = quickConnectActive && quickConnectSourceId === card.id;
    const isDeselecting = !selected && renderedSelectedCardIds.has(card.id);
    const pinned = data.pinnedCardId === card.id;
    const editingTitle = editingCardId === card.id && editingField === 'title';
    const editingBody = editingCardId === card.id && editingField === 'body';
    // 新建卡片没有阅读态 DOM 可测量，使用与当前阅读态一致的默认标题区尺寸，
    // 避免标题编辑器和进度条落在同一行。
    const titleEditLayout = editingTitle
      ? titleEditLayouts.get(card.id) ?? DEFAULT_TITLE_EDIT_LAYOUT
      : undefined;

    return `
      <article class="task-card ${selected ? 'is-selected' : ''} ${quickConnectSource ? 'is-connect-source' : ''} ${isDeselecting ? 'is-deselecting' : ''} ${pinned ? 'is-pinned' : ''} ${card.completed ? 'is-completed' : ''} ${editingTitle || editingBody ? 'is-editing' : ''}"
        data-card-id="${card.id}" style="z-index:${cardGroupStackOrder.get(card.id) ?? 0};left:${card.x}px;top:${card.y}px">
        <svg class="task-card__tabs-outline-bg" viewBox="0 0 118 53" preserveAspectRatio="none" overflow="visible" aria-hidden="true"><path d="M 13 0 H 89 C 108 0 103 34 118 34 V 53 H 0 V 13 Q 0 0 13 0 Z" /></svg>
        <header class="task-card__header${editingTitle ? ' is-title-editing' : ''}" data-drag-handle="true"${titleEditLayout ? ` style="height:${titleEditLayout.headerHeight}px;--title-edit-row-height:${titleEditLayout.titleRowHeight}px"` : ''}>
          <div class="task-card__tabs">
            <svg class="task-card__tabs-bg" viewBox="0 0 118 53" preserveAspectRatio="none" overflow="visible" aria-hidden="true"><path class="task-card__tabs-fill" d="M 13 0 H 89 C 108 0 103 34 118 34 V 53 H 0 V 13 Q 0 0 13 0 Z" /></svg>
            <button class="card-control" data-action="toggle-complete" title="${t('taskflow.card.complete')}"><svg class="complete-shape" viewBox="0 0 26 24" aria-hidden="true"><path d="M 13 2.5 L 24 21.5 H 2 Z" /></svg></button>
            <button class="card-control" data-action="toggle-pin" title="${t('taskflow.card.setCurrent')}"><span class="pin-shape"></span></button>
          </div>
          ${editingTitle ? `<input class="title-editor" data-editor="title" value="${escapeHTML(card.title)}" />` : `<div class="task-card__title" data-action="edit-title">${escapeHTML(card.title)}</div>`}
          <span class="task-card__drag" aria-hidden="true" title="${t('taskflow.card.drag')}"></span>
          ${progress}
        </header>
        <section class="task-card__body${editingBody ? ' is-editing' : ''}" data-action="edit-body">
          ${editingBody ? `<textarea class="card-editor" data-editor="body" spellcheck="false" style="height:${editorPreviewHeight(card.markdown)}px">${escapeHTML(card.markdown)}</textarea>` : renderMarkdown(card)}
        </section>
        <button class="connection-handle connection-handle--in" data-handle="in" title="${t('taskflow.card.linkIn')}"></button>
        <button class="connection-handle connection-handle--out" data-handle="out" title="${t('taskflow.card.linkOut')}"></button>
      </article>`;
  }).join('')}${renderNoteCards(noteCards)}${renderStandaloneNotes(standaloneNotes)}`;
  renderedSelectedCardIds = nextSelectedCardIds;

  if (progressTransitions.length) {
    requestAnimationFrame(() => {
      for (const transition of progressTransitions) {
        const fill = elements.cardLayer.querySelector<HTMLElement>(`[data-progress-fill="${transition.cardId}"]`);
        if (fill) fill.style.width = `${transition.to}%`;
      }
    });
  }

  requestAnimationFrame(redrawNoteCanvases);

  // 聚焦当前编辑器（标题或正文）。
  // 默认仅聚焦不强行移动光标：强行 setSelectionRange(末尾) 会导致"点击第一行编辑、光标跳回最后一行"的 bug。
  // 仅当 focusSelectAll 为 true（新建卡片/说明框）时全选内容，便于直接覆盖编辑。
  if (editingCardId && editingField) {
    requestAnimationFrame(() => {
      const editor = elements.cardLayer.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-card-id="${editingCardId}"] [data-editor="${editingField}"]`);
      if (!editor) return;
      // 正文编辑：让 textarea 高度贴合内容，避免与阅读态高度不一致造成切换抖动
      if (editor instanceof HTMLTextAreaElement) {
        autoSizeTextarea(editor);
        // textarea 高度变化会改变卡片/说明框布局，重新定位说明框
        layoutNoteCards();
      }
      editor.focus();
      // 恢复编辑说明框的滚动位置（在 autoSize/layout 之后，避免被布局变化顶回顶部）
      if (pendingNoteScrollTop != null) {
        const noteBody = editor.closest<HTMLElement>('.task-note__body');
        if (noteBody) {
          restoringNoteScroll = true;
          noteBody.scrollTop = pendingNoteScrollTop.top;
          restoringNoteScroll = false;
        }
      }
      // 新建卡片/说明框时全选标题，便于直接编辑
      if (focusSelectAll) {
        editor.select();
        focusSelectAll = false;
      } else if (editor instanceof HTMLInputElement && editingField === 'title') {
        const end = editor.value.length;
        editor.setSelectionRange(end, end);
      } else if (editor instanceof HTMLTextAreaElement && editingField === 'body') {
        // 把光标定位到进入编辑时的点击位置（caretRangeFromPoint + 行估算双保险），失败则放到内容末尾
        let placed = false;
        if (editClickPoint) {
          const offset = textOffsetAt(editor, editClickPoint.x, editClickPoint.y);
          if (offset >= 0) {
            editor.setSelectionRange(offset, offset);
            placed = true;
          }
        }
        editClickPoint = null;
        if (!placed) {
          const end = editor.value.length;
          editor.setSelectionRange(end, end);
        }
      }
    });
  }
}

function renderEdges(horizontalOffsets: ReadonlyMap<string, number> = new Map()): void {
  const cards = new Map(activeCards().map((card) => [card.id, card]));
  const edgeGradients: string[] = [];
  const edges = activeEdges().flatMap((edge) => {
    const source = cards.get(edge.sourceId);
    const target = cards.get(edge.targetId);
    if (!source || !target || !isTaskCard(source) || !isTaskCard(target)) return [];
    const sourceSelected = selectedCardIds.has(edge.sourceId);
    const targetSelected = selectedCardIds.has(edge.targetId);
    const linkedToSelection = sourceSelected || targetSelected;
    const sourcePoint = connectionPoint({ ...source, x: source.x + (horizontalOffsets.get(source.id) ?? 0) }, 'out');
    const targetPoint = connectionPoint({ ...target, x: target.x + (horizontalOffsets.get(target.id) ?? 0) }, 'in');
    const path = edgePath(sourcePoint, targetPoint);
    const gradientId = `linked-edge-${edge.id}`;
    if (linkedToSelection) {
      const stops = sourceSelected && targetSelected
        ? '<stop offset="0%" stop-color="#90D844" /><stop offset="32%" stop-color="#79B64D" /><stop offset="68%" stop-color="#79B64D" /><stop offset="100%" stop-color="#90D844" />'
        : sourceSelected
          ? '<stop offset="0%" stop-color="#90D844" /><stop offset="18%" stop-color="#82C548" /><stop offset="38%" stop-color="#79B64D" /><stop offset="100%" stop-color="#79B64D" />'
          : '<stop offset="0%" stop-color="#79B64D" /><stop offset="62%" stop-color="#79B64D" /><stop offset="82%" stop-color="#82C548" /><stop offset="100%" stop-color="#90D844" />';
      edgeGradients.push(`<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${sourcePoint.x}" y1="${sourcePoint.y}" x2="${targetPoint.x}" y2="${targetPoint.y}">${stops}</linearGradient>`);
    }
    return [`
      <g data-edge-id="${edge.id}">
        <path class="flow-edge-hit" d="${path}" data-edge-hit="${edge.id}"></path>
        <path class="flow-edge ${selectedEdgeId === edge.id ? 'is-selected' : ''} ${linkedToSelection ? 'is-linked' : ''}" d="${path}"${linkedToSelection ? ` style="stroke:url(#${gradientId})"` : ''}></path>
      </g>`];
  }).join('');

  let preview = '';
  if (connectionState) {
    const source = cards.get(connectionState.sourceId);
    if (source) {
      const path = connectionState.sourceSide === 'out'
        ? edgePath(connectionPoint(source, 'out'), connectionState.pointer)
        : edgePath(connectionState.pointer, connectionPoint(source, 'in'));
      preview = `<path class="connection-preview" d="${path}"></path>`;
    }
  }

  elements.edgeLayer.innerHTML = `
    <defs>
      <marker id="leaf-arrow" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="strokeWidth">
        <path d="M 0 1 Q 8 2 10 5.5 Q 8 9 0 10 Q 4 5.5 0 1" fill="#79b64d"></path>
      </marker>
      ${edgeGradients.join('')}
    </defs>
    ${edges}${preview}`;
}

function animatePendingCardShift(): void {
  const pending = pendingCardShiftAnimation;
  pendingCardShiftAnimation = null;
  if (!pending || pending.shift <= 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (cardShiftAnimationFrame !== null) cancelAnimationFrame(cardShiftAnimationFrame);
  const movedCards = pending.cardIds.flatMap((cardId) => {
    const card = data.cards.find((item) => item.id === cardId);
    const element = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
    return card && element ? [{ card, element }] : [];
  });
  if (!movedCards.length) return;

  const startedAt = performance.now();
  const duration = 180;
  const draw = (timestamp: number): void => {
    const progress = Math.min(1, (timestamp - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const remaining = pending.shift * (1 - eased);
    const offsets = new Map<string, number>();
    for (const { card, element } of movedCards) {
      element.style.left = `${card.x - remaining}px`;
      offsets.set(card.id, -remaining);
    }
    renderEdges(offsets);
    if (progress < 1) {
      cardShiftAnimationFrame = requestAnimationFrame(draw);
    } else {
      cardShiftAnimationFrame = null;
      renderEdges();
    }
  };

  // Restore the pre-shift frame before the browser paints the newly rendered cards.
  for (const { card, element } of movedCards) element.style.left = `${card.x - pending.shift}px`;
  renderEdges(new Map(movedCards.map(({ card }) => [card.id, -pending.shift])));
  cardShiftAnimationFrame = requestAnimationFrame(draw);
}

/**
 * 渲染后布局修正（同步）：根据卡片与说明框的实际 DOM 高度，重新定位说明框，
 * 使其始终贴在上一个元素（卡片或上一个说明框）的真实底部。
 * 由于在 innerHTML 赋值后立即同步执行（同帧内完成），说明框首帧即为最终位置，无闪动。
 */
function layoutNoteCards(): void {
  const allCards = activeCards();
  const notes = allCards.filter((card) => card.parentId);
  // 测量所有主卡片实际高度并缓存，供位置计算与 min-height 使用
  for (const card of allCards) {
    if (card.parentId) continue;
    const el = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
    if (el && el.offsetHeight > 0) measuredHeights.set(card.id, el.offsetHeight);
    else measuredHeights.delete(card.id);
  }
  const byParent = new Map<string, TaskCard[]>();
  for (const note of notes) {
    const list = byParent.get(note.parentId!) ?? [];
    list.push(note);
    byParent.set(note.parentId!, list);
  }
  for (const [parentId, parentNotes] of byParent) {
    const parent = data.cards.find((c) => c.id === parentId);
    if (!parent) continue;
    const parentEl = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${parentId}"]`);
    // 父卡片实际底部（含 border）；若不可见则回退估算
    const parentBottom = parentEl ? parentEl.offsetTop + parentEl.offsetHeight : parent.y + cardHeight(parent);
    let cursorY = parentBottom + 10;
    for (const note of parentNotes) {
      const noteEl = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${note.id}"]`);
      if (!noteEl) continue;
      // 更新说明框 top，使其贴在上一个元素底部
      noteEl.style.top = `${cursorY}px`;
      // 若说明框处于编辑态，同步其 textarea 高度贴合内容
      if (editingCardId === note.id && editingField === 'body') {
        const ta = noteEl.querySelector<HTMLTextAreaElement>('[data-editor="body"]');
        if (ta) autoSizeTextarea(ta);
      }
      // 下一个说明框从本说明框实际底部开始
      cursorY += noteEl.offsetHeight + 8;
    }
  }
}

function render(): void {
  const project = activeProject();
  if (!project && data.projects.some((item) => !item.archived)) {
    activateProject(data.projects.find((item) => !item.archived)!.id);
  }
  const projectTitle = activeProject()?.title ?? t('taskflow.canvas.fallbackTitle');
  const projectTitleText = elements.barProjectTitle.querySelector<HTMLElement>('.window-bar__title-text');
  if (projectTitleText) projectTitleText.textContent = projectTitle;
  else elements.barProjectTitle.textContent = projectTitle;
  elements.barProjectTitle.hidden = !activeProject();
  // 记录正在编辑的说明框滚动位置（仅编辑态时更新；退出编辑时由 commitEditing 预先保存）
  if (editingCardId && editingField === 'body') {
    const body = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${editingCardId}"] .task-note__body`);
    if (body && body.scrollTop > 0) pendingNoteScrollTop = { id: editingCardId, top: body.scrollTop };
  }
  renderProjects();
  renderEdges();
  renderCards();
  layoutNoteCards();
  // 重建后恢复说明框滚动位置（不清空：退出编辑会连续多次 render，需每次都恢复；
  // 用户主动滚动时由 scroll 监听清除该值）
  if (pendingNoteScrollTop) {
    const body = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${pendingNoteScrollTop.id}"] .task-note__body`);
    if (body) {
      restoringNoteScroll = true;
      body.scrollTop = pendingNoteScrollTop.top;
      restoringNoteScroll = false;
    }
  }
  elements.emptyState.hidden = activeCards().length > 0 || !activeProject();
  elements.undo.disabled = !history.canUndo;
  elements.redo.disabled = !history.canRedo;
  applyTransform();
  animatePendingCardShift();
}

function setActiveProject(projectId: string): void {
  activateProject(projectId);
  selectedCardIds.clear();
  selectedEdgeId = null;
  editingCardId = null;
  editingField = null;
  render();
  scheduleSave();
}

function addCardAt(x: number, y: number, title = t('common.newTask'), insertEdgeId?: string): TaskCard | null {
  if (!data.activeProjectId) return null;
  const card = createCard(data.activeProjectId, x, y, title);
  const insertedEdge = insertEdgeId ? data.edges.find((edge) => edge.id === insertEdgeId && edge.projectId === data.activeProjectId) : undefined;
  mutate(() => {
    if (insertedEdge) {
      const room = makeRoomForInsertedCard(data.cards, data.edges, card, insertedEdge);
      if (room.shift > 0) pendingCardShiftAnimation = { shift: room.shift, cardIds: room.movedCardIds };
    }
    data.cards.push(card);
    if (insertedEdge) {
      insertCardIntoEdge(card, insertedEdge);
    }
    selectedCardIds = new Set([card.id]);
    editingCardId = card.id;
    editingField = 'title';
    editEnterAt = Date.now();
    focusSelectAll = true; // 新建卡片：进入标题编辑并全选，便于直接编辑
  });
  return card;
}

function updatePlacementPreview(clientX: number, clientY: number): void {
  if (!placementMode) return;
  const point = clientToWorld(clientX, clientY);
  const height = placementMode === 'note' ? CARD_WIDTH : CARD_HEADER_HEIGHT;
  elements.placementPreview.style.left = `${point.x - CARD_WIDTH / 2}px`;
  elements.placementPreview.style.top = `${point.y - height / 2}px`;
  const insertionEdge = placementMode === 'task'
    ? edgeAtClientPoint(clientX, clientY) ?? edgeAtWorldPoint(point)
    : undefined;
  elements.placementPreview.classList.toggle('is-inserting', Boolean(insertionEdge));
}

function enterPlacementMode(type: 'task' | 'note' = 'task'): void {
  if (!activeProject()) return;
  placementMode = type;
  elements.placementPreview.classList.toggle('is-note', type === 'note');
  elements.placementPreview.textContent = type === 'note' ? t('taskflow.note.fallbackTitle') : t('common.newTask');
  const viewport = elements.viewport.getBoundingClientRect();
  const pointerIsInViewport = lastPointer.clientX >= viewport.left
    && lastPointer.clientX <= viewport.right
    && lastPointer.clientY >= viewport.top
    && lastPointer.clientY <= viewport.bottom;
  updatePlacementPreview(
    pointerIsInViewport ? lastPointer.clientX : viewport.left + viewport.width / 2,
    pointerIsInViewport ? lastPointer.clientY : viewport.top + viewport.height / 2,
  );
  elements.placementPreview.hidden = false;
  elements.placementHint.hidden = false;
  elements.viewport.focus();
}

function exitPlacementMode(): void {
  placementMode = null;
  elements.placementPreview.hidden = true;
  elements.placementHint.hidden = true;
  elements.placementPreview.classList.remove('is-inserting');
}

function setDragInsertionPreview(cardId: string | null): void {
  if (dragInsertionCardId === cardId) return;
  if (dragInsertionCardId) {
    elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${dragInsertionCardId}"]`)
      ?.classList.remove('is-inserting');
  }
  dragInsertionCardId = cardId;
  if (cardId) {
    elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`)
      ?.classList.add('is-inserting');
  }
}

function setZoom(nextZoom: number, clientX?: number, clientY?: number): void {
  const zoom = Math.min(2, Math.max(0.25, nextZoom));
  const viewport = viewportLayoutSize();
  const pivot = clientX == null || clientY == null
    ? { x: viewport.width / 2, y: viewport.height / 2 }
    : clientToViewport(clientX, clientY);
  const pivotX = pivot.x;
  const pivotY = pivot.y;
  const worldX = (pivotX - transform.x) / transform.zoom;
  const worldY = (pivotY - transform.y) / transform.zoom;
  transform.x = pivotX - worldX * zoom;
  transform.y = pivotY - worldY * zoom;
  transform.zoom = zoom;
  applyTransform();
  scheduleSave();
}

function fitView(): void {
  const cards = activeCards();
  if (!cards.length) {
    transform = { x: 70, y: 55, zoom: 1 };
    applyTransform();
    scheduleSave();
    return;
  }
  const minX = Math.min(...cards.map((card) => card.x));
  const minY = Math.min(...cards.map((card) => card.y));
  const maxX = Math.max(...cards.map((card) => card.x + CARD_WIDTH));
  const maxY = Math.max(...cards.map((card) => card.y + cardHeight(card)));
  const viewport = viewportLayoutSize();
  const padding = 70;
  const zoom = Math.min(1.4, Math.max(0.25, Math.min((viewport.width - padding * 2) / (maxX - minX), (viewport.height - padding * 2) / (maxY - minY))));
  transform = {
    zoom,
    x: (viewport.width - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: (viewport.height - (maxY - minY) * zoom) / 2 - minY * zoom,
  };
  applyTransform();
  scheduleSave();
}

function focusCard(cardId: string): void {
  const card = data.cards.find((item) => item.id === cardId);
  if (!card) return;
  if (card.projectId !== data.activeProjectId) setActiveProject(card.projectId);
  const viewport = viewportLayoutSize();
  transform.x = viewport.width / 2 - (card.x + CARD_WIDTH / 2) * transform.zoom;
  transform.y = viewport.height / 2 - (card.y + cardHeight(card) / 2) * transform.zoom;
  selectedCardIds = new Set([cardId]);
  render();
  scheduleSave();
}

/** Ctrl+方向键：沿连接线在卡片间前后切换（→/↓ 到后继，←/↑ 到前驱）。
 *  连续按同一方向时，若候选列表未变则在其内循环；否则从第一个开始。 */
function navigateFlow(key: string): void {
  // 编辑态下也支持导航：先提交当前编辑内容再切换
  if (editingCardId) commitEditing(undefined, true);
  if (selectedCardIds.size !== 1) return;
  const currentId = [...selectedCardIds][0];
  const current = data.cards.find((c) => c.id === currentId);
  if (!current || !isTaskCard(current)) return; // 说明卡不参与流程导航
  const isForward = key === 'ArrowRight' || key === 'ArrowDown';
  const slot = isForward ? 'fwd' : 'back';
  const edges = activeEdges();
  const list = isForward
    ? edges.filter((e) => e.sourceId === currentId).map((e) => e.targetId)
    : edges.filter((e) => e.targetId === currentId).map((e) => e.sourceId);
  if (!list.length) return;
  const listKey = list.join('|');
  let state = navState[slot];
  if (!state || state.cardId !== currentId || state.listKey !== listKey) {
    state = { cardId: currentId, listKey, index: 0 };
    navState[slot] = state;
  } else {
    state.index = (state.index + 1) % list.length;
  }
  const targetId = list[state.index];
  const target = data.cards.find((c) => c.id === targetId);
  // 记录切换前当前卡片中心（世界坐标），用于让画布跟随移动
  const fromCenter = {
    x: current.x + CARD_WIDTH / 2,
    y: current.y + cardHeight(current) / 2,
  };
  selectedEdgeId = null;
  editingCardId = null;
  editingField = null;
  selectedCardIds = new Set([targetId]);
  if (target) {
    // 画布跟随：让目标卡片中心落到当前卡片中心的位置（平移量 = 两张卡片的距离 × zoom）
    const toCenter = {
      x: target.x + CARD_WIDTH / 2,
      y: target.y + cardHeight(target) / 2,
    };
    // 0.1s 平滑动画（临时类，结束后移除，避免影响后续拖拽/缩放手感）
    const panSurface = useLegacyCanvasTransform ? elements.world : elements.pan;
    panSurface.classList.add('is-panning-smooth');
    transform.x -= (toCenter.x - fromCenter.x) * transform.zoom;
    transform.y -= (toCenter.y - fromCenter.y) * transform.zoom;
    window.setTimeout(() => panSurface.classList.remove('is-panning-smooth'), 110);
  }
  render();
  scheduleSave();
}

function commitEditing(cardElement?: HTMLElement, skipRender = false): void {
  const targetId = cardElement?.dataset.cardId ?? editingCardId;
  if (!targetId) return;
  const card = data.cards.find((item) => item.id === targetId);
  const root = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${targetId}"]`);
  if (!card || !root) {
    editingCardId = null;
    editingField = null;
    return;
  }
  const title = root.querySelector<HTMLInputElement>('[data-editor="title"]')?.value.trim();
  const markdown = root.querySelector<HTMLTextAreaElement>('[data-editor="body"]')?.value;
  const changed = (title !== undefined && title !== card.title) || (markdown !== undefined && markdown !== card.markdown);
  if (changed) {
    history.push(data);
    // 说明框允许空标题（阅读态回退显示"附属便签"）；主卡片空标题回退"未命名任务"
    if (title !== undefined) card.title = title || (card.parentId ? '' : t('common.untitledTask'));
    if (markdown !== undefined) card.markdown = markdown;
    card.updatedAt = now();
    scheduleSave();
  }
  // 退出编辑前保存说明框滚动位置（editingCardId 清空后 render 无法再读取，需提前保存）
  if (editingField === 'body') {
    const noteBody = root.querySelector<HTMLElement>('.task-note__body');
    if (noteBody && noteBody.scrollTop > 0) pendingNoteScrollTop = { id: targetId, top: noteBody.scrollTop };
  }
  editingCardId = null;
  editingField = null;
  if (!skipRender) render();
}

function deleteSelection(): void {
  if (selectedEdgeId) {
    mutate(() => {
      data.edges = data.edges.filter((edge) => edge.id !== selectedEdgeId);
      selectedEdgeId = null;
    }, t('taskflow.toast.edgeDeleted'));
    return;
  }
  if (!selectedCardIds.size) return;
  mutate(() => {
    data = removeCardsAndReconnect(data, selectedCardIds);
    selectedCardIds.clear();
  }, t('taskflow.toast.cardDeletedAndLinked'));
}

function removeSelectedCardsFromGroups(): void {
  const cardIds = [...selectedCardIds];
  const grouped = cardIds.filter((id) => {
    const card = data.cards.find((item) => item.id === id);
    return card && !card.parentId && card.groupId;
  });
  if (!grouped.length) return;
  mutate(() => {
    for (const id of grouped) {
      const card = data.cards.find((item) => item.id === id);
      if (card) { card.groupId = null; card.updatedAt = now(); }
    }
    const usedGroupIds = new Set(data.cards.map((card) => card.groupId).filter((id): id is string => Boolean(id)));
    data.groups = data.groups.filter((group) => usedGroupIds.has(group.id));
  }, t('taskflow.toast.removedFromGroup'));
}

function deleteCanvasGroup(groupId: string, includeCards: boolean): void {
  const groupCards = activeCards().filter((card) => card.groupId === groupId && !card.parentId);
  if (!groupCards.length) return;
  if (!includeCards) {
    mutate(() => {
      for (const card of groupCards) { card.groupId = null; card.updatedAt = now(); }
      data.groups = data.groups.filter((group) => group.id !== groupId);
    }, t('taskflow.toast.groupDeleted'));
    return;
  }
  const title = includeCards ? t('taskflow.dialog.deleteGroupCards') : t('taskflow.dialog.deleteGroup');
  const message = t('taskflow.dialog.deleteGroupMessage', { n: groupCards.length });
  void confirmDialog(title, message, t('common.delete'), t('common.cancel')).then((ok) => {
    if (!ok) return;
    mutate(() => {
      if (includeCards) {
        const ids = new Set(groupCards.map((card) => card.id));
        for (const card of data.cards) if (card.parentId && ids.has(card.parentId)) ids.add(card.id);
        data.cards = data.cards.filter((card) => !ids.has(card.id));
        data.edges = data.edges.filter((edge) => !ids.has(edge.sourceId) && !ids.has(edge.targetId));
        ids.forEach((id) => selectedCardIds.delete(id));
      }
      data.groups = data.groups.filter((group) => group.id !== groupId);
    }, t('taskflow.toast.groupAndCardsDeleted'));
  });
}

function setCanvasGroupOutlineColor(groupId: string, color: string): void {
  const group = data.groups.find((item) => item.id === groupId);
  if (!group) return;
  mutate(() => { group.color = color; }, t('taskflow.toast.groupColorUpdated'));
}

function groupAtClientPoint(clientX: number, clientY: number, excludedGroupId?: string | null): string | null {
  const matches = [...elements.groupLayer.querySelectorAll<HTMLElement>('[data-group-id]')]
    .filter((element) => element.dataset.groupId !== excludedGroupId)
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
  return matches.length ? matches[matches.length - 1].dataset.groupId ?? null : null;
}

function createFollowingCard(parallel: boolean): void {
  const currentId = selectedCardIds.size === 1 ? [...selectedCardIds][0] : null;
  const current = data.cards.find((card) => card.id === currentId);
  if (!current || !isTaskCard(current) || !data.activeProjectId) return;
  const next = createCard(data.activeProjectId, parallel ? current.x : current.x + 360, parallel ? current.y + 210 : current.y, t('common.newTask'));
  mutate(() => {
    data.cards.push(next);
    if (!parallel) data.edges.push(createEdge(data.activeProjectId!, current.id, next.id));
    selectedCardIds = new Set([next.id]);
    editingCardId = next.id;
    editingField = 'title';
    editEnterAt = Date.now();
    focusSelectAll = true; // 新建卡片：进入标题编辑并全选
  });
}

/** 在选中卡片下缘生成附属文本框子卡片（独立实体，跟随父卡移动） */
function createNoteCard(parentId: string): void {
  if (!data.activeProjectId) return;
  const parent = data.cards.find((c) => c.id === parentId);
  if (!parent) return;
  const note = createCard(data.activeProjectId, parent.x, noteParentY(parent), t('taskflow.note.attachedTitle'));
  note.parentId = parentId;
  note.cardType = 'note';
  note.noteMode = 'text';
  note.noteCollapsed = false;
  note.markdown = '';
  mutate(() => {
    data.cards.push(note);
    selectedCardIds = new Set([note.id]);
    // 新建说明框：进入标题编辑态（配合默认标题"附属便签"），便于直接编辑标题
    editingCardId = note.id;
    editingField = 'title';
    editEnterAt = Date.now();
    focusSelectAll = true;
  });
}

function undo(): void {
  const previous = history.undo(data);
  if (!previous) return;
  data = previous;
  selectedCardIds.clear();
  selectedEdgeId = null;
  editingCardId = null;
  editingField = null;
  render();
  scheduleSave();
}

function redo(): void {
  const next = history.redo(data);
  if (!next) return;
  data = next;
  selectedCardIds.clear();
  selectedEdgeId = null;
  editingCardId = null;
  editingField = null;
  render();
  scheduleSave();
}

function wireToolbar(): void {
  document.querySelector('#window-close')!.addEventListener('click', () => window.taskFlowAPI.closeWindow());
  document.querySelector('#window-minimize')!.addEventListener('click', () => window.taskFlowAPI.minimizeWindow());
  document.querySelector('#window-maximize')!.addEventListener('click', () => {
    halfScreenButton.classList.remove('is-active');
    window.taskFlowAPI.maximizeWindow();
  });
  const alwaysOnTopButton = document.querySelector<HTMLButtonElement>('#window-always-on-top')!;
  const halfScreenButton = document.querySelector<HTMLButtonElement>('#window-half-screen')!;
  halfScreenButton.addEventListener('click', async () => {
    const active = await window.taskFlowAPI.toggleHalfScreen();
    halfScreenButton.classList.toggle('is-active', active);
  });
  alwaysOnTopButton.addEventListener('click', async () => {
    alwaysOnTopButton.disabled = true;
    try {
      const enabled = await window.taskFlowAPI.toggleAlwaysOnTop();
      alwaysOnTopButton.classList.toggle('is-active', enabled);
    } catch (error) {
      console.error('[taskflow] failed to toggle always-on-top', error);
    } finally {
      alwaysOnTopButton.disabled = false;
    }
  });
  window.taskFlowAPI.onAlwaysOnTop((enabled) => alwaysOnTopButton.classList.toggle('is-active', enabled));
  void window.taskFlowAPI.getAlwaysOnTop().then((enabled) => alwaysOnTopButton.classList.toggle('is-active', enabled));
  document.querySelector('#new-project')!.addEventListener('click', () => {
    // 立即在任务栏新增项目并进入标题全选编辑状态；
    // 新项目排在所有置顶任务的下面（即非置顶区域的最前）
    const project = createProject(t('taskflow.canvas.fallbackProjectTitle'));
    mutate(() => {
      const maxOrder = data.projects.reduce((max, p) => (!p.pinnedAt && (p.sortOrder ?? 0) > max ? (p.sortOrder ?? 0) : max), 0);
      project.sortOrder = maxOrder + 1;
      data.projects.push(project);
      activateProject(project.id);
      selectedCardIds.clear();
    });
    beginProjectInlineEdit(project.id);
  });
  elements.newProjectGroup.addEventListener('click', createProjectGroup);
  document.querySelector('#archive-project')!.addEventListener('click', () => {
    archiveActiveProject();
  });
  document.querySelector('#show-archive')!.addEventListener('click', () => {
    openArchiveDialog();
  });
  elements.nPanelSearch.addEventListener('input', renderNPanelSearchResults);
  elements.nPanelSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const firstMatch = elements.nPanelSearchResults.querySelector<HTMLElement>('[data-search-card]');
    if (!firstMatch) return;
    event.preventDefault();
    focusCard(firstMatch.dataset.searchCard!);
  });
  elements.nPanelSearchResults.addEventListener('click', (event) => {
    const result = (event.target as HTMLElement).closest<HTMLElement>('[data-search-card]');
    if (result) focusCard(result.dataset.searchCard!);
  });
  elements.archiveClose.addEventListener('click', closeArchiveDialog);
  elements.archiveList.addEventListener('click', (event) => {
    const restoreButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-restore-project]');
    if (restoreButton) restoreArchivedProject(restoreButton.dataset.restoreProject!);
  });
  elements.undo.addEventListener('click', undo);
  elements.redo.addEventListener('click', redo);
  document.querySelector('#zoom-in')!.addEventListener('click', () => setZoom(transform.zoom + 0.1));
  document.querySelector('#zoom-out')!.addEventListener('click', () => setZoom(transform.zoom - 0.1));
  document.querySelector('#zoom-reset')!.addEventListener('click', () => setZoom(1));
  document.querySelector('#fit-view')!.addEventListener('click', fitView);
  wireProjectList();
  wireContextMenu();
}

function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
  elements.sidebar.classList.toggle('is-collapsed', sidebarCollapsed);
}

/** N 面板（右侧）展开/收起 */
function toggleNPanel(open?: boolean): void {
  nPanelOpen = open ?? !nPanelOpen;
  elements.nPanel.hidden = !nPanelOpen;
  elements.canvasPanel.classList.toggle('n-panel-collapsed', !nPanelOpen);
}

/** 在指定世界坐标创建可独立移动的说明卡。 */
function createStandaloneNoteAtWorld(x: number, y: number): void {
  if (!data.activeProjectId) return;
  const note = createCard(data.activeProjectId, x - CARD_WIDTH / 2, y - CARD_WIDTH / 2, t('taskflow.note.fallbackTitle'));
  note.cardType = 'note';
  note.noteMode = 'text';
  note.markdown = '';
  mutate(() => {
    data.cards.push(note);
    selectedCardIds = new Set([note.id]);
    editingCardId = note.id;
    editingField = 'title';
    editEnterAt = Date.now();
    focusSelectAll = true;
  });
}

function createStandaloneNoteAtPointer(): void {
  const viewport = elements.viewport.getBoundingClientRect();
  const pointerIsInViewport = lastPointer.clientX >= viewport.left
    && lastPointer.clientX <= viewport.right
    && lastPointer.clientY >= viewport.top
    && lastPointer.clientY <= viewport.bottom;
  const clientX = pointerIsInViewport ? lastPointer.clientX : viewport.left + viewport.width / 2;
  const clientY = pointerIsInViewport ? lastPointer.clientY : viewport.top + viewport.height / 2;
  const point = clientToWorld(clientX, clientY);
  createStandaloneNoteAtWorld(point.x, point.y);
}

function renderStandaloneNotes(noteCards: TaskCard[]): string {
  return noteCards.map((card) => renderNoteCard(card, {
    x: card.x,
    y: card.y,
    zIndex: cardGroupStackOrder.get(card.id) ?? 0,
    attached: false,
  })).join('');
}

function storedDrawing(card: TaskCard): DrawStroke[] {
  if (!card.drawing) return [];
  try {
    const parsed = JSON.parse(card.drawing) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((stroke): stroke is DrawStroke => Array.isArray(stroke) && stroke.length > 0)
      .map((stroke) => stroke.filter((point): point is DrawPoint => Boolean(point) && typeof point.x === 'number' && typeof point.y === 'number'));
  } catch {
    return [];
  }
}

function redrawNoteCanvas(canvas: HTMLCanvasElement, card: TaskCard, preview?: DrawStroke): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#666F8C';
  context.lineWidth = 2.5;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of [...storedDrawing(card), ...(preview?.length ? [preview] : [])]) {
    if (!stroke.length) continue;
    context.beginPath();
    context.moveTo(stroke[0].x * width, stroke[0].y * height);
    for (let index = 1; index < stroke.length; index += 1) context.lineTo(stroke[index].x * width, stroke[index].y * height);
    if (stroke.length === 1) context.lineTo(stroke[0].x * width + 0.01, stroke[0].y * height + 0.01);
    context.stroke();
  }
}

function redrawNoteCanvases(): void {
  elements.cardLayer.querySelectorAll<HTMLCanvasElement>('[data-note-canvas]').forEach((canvas) => {
    const card = data.cards.find((item) => item.id === canvas.closest<HTMLElement>('[data-card-id]')?.dataset.cardId);
    if (card) redrawNoteCanvas(canvas, card);
  });
}

function drawingPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): DrawPoint {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
}

/** 将笔划补点后按橡皮圆形范围切开，避免快速移动时漏擦过长线段。 */
function eraseDrawingAt(card: TaskCard, canvas: HTMLCanvasElement, center: DrawPoint): void {
  const rect = canvas.getBoundingClientRect();
  const radiusX = 37.5 / Math.max(1, rect.width);
  const radiusY = 37.5 / Math.max(1, rect.height);
  const fragments: DrawStroke[] = [];
  for (const source of storedDrawing(card)) {
    const points: DrawStroke = [];
    for (let index = 0; index < source.length; index += 1) {
      const point = source[index];
      if (index > 0) {
        const previous = source[index - 1];
        const dx = (point.x - previous.x) * rect.width;
        const dy = (point.y - previous.y) * rect.height;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 3));
        for (let step = 1; step < steps; step += 1) {
          const ratio = step / steps;
          points.push({ x: previous.x + (point.x - previous.x) * ratio, y: previous.y + (point.y - previous.y) * ratio });
        }
      }
      points.push(point);
    }
    let fragment: DrawStroke = [];
    for (const point of points) {
      const dx = (point.x - center.x) / radiusX;
      const dy = (point.y - center.y) / radiusY;
      if (dx * dx + dy * dy <= 1) {
        if (fragment.length) fragments.push(fragment);
        fragment = [];
      } else {
        fragment.push(point);
      }
    }
    if (fragment.length) fragments.push(fragment);
  }
  card.drawing = JSON.stringify(fragments);
}

function finishDrawing(): boolean {
  if (!drawingState) return false;
  const { cardId, stroke, canvas, erasing } = drawingState;
  drawingState = null;
  canvas.classList.remove('is-erasing');
  const card = data.cards.find((item) => item.id === cardId);
  if (!card || (!erasing && !stroke.length)) return true;
  if (!erasing) {
    const strokes = storedDrawing(card);
    strokes.push(stroke);
    card.drawing = JSON.stringify(strokes);
  }
  card.updatedAt = now();
  render();
  scheduleSave();
  return true;
}

function isNoteCard(card: TaskCard): boolean {
  return card.cardType === 'note' || Boolean(card.parentId);
}

function isStandaloneNote(card: TaskCard): boolean {
  return card.cardType === 'note' && !card.parentId;
}

function isTaskCard(card: TaskCard): boolean {
  return !isNoteCard(card);
}

/** 旧版本曾支持双击折叠任务卡；功能移除后，加载时一次性恢复历史数据。 */
function expandLegacyCollapsedTaskCards(): boolean {
  let changed = false;
  for (const card of data.cards) {
    if (isTaskCard(card) && card.collapsed) {
      card.collapsed = false;
      changed = true;
    }
  }
  return changed;
}

function taskCardAtClientPoint(clientX: number, clientY: number, excludedIds: Set<string>): TaskCard | undefined {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const cardElement = (element as HTMLElement).closest<HTMLElement>('.task-card[data-card-id]');
    const cardId = cardElement?.dataset.cardId;
    if (!cardId || excludedIds.has(cardId)) continue;
    const card = data.cards.find((item) => item.id === cardId);
    if (card && isTaskCard(card)) return card;
  }
  return undefined;
}

function setNoteAttachTarget(cardId: string | null): void {
  if (noteAttachTargetId === cardId) return;
  if (noteAttachTargetId) {
    elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${noteAttachTargetId}"]`)?.classList.remove('is-note-attach-target');
  }
  noteAttachTargetId = cardId;
  if (cardId) {
    elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`)?.classList.add('is-note-attach-target');
  }
}

function renderNPanelSearchResults(): void {
  const query = elements.nPanelSearch.value.trim().toLocaleLowerCase();
  if (!query) {
    elements.nPanelSearchResults.hidden = false;
    elements.nPanelSearchResults.innerHTML = '';
    return;
  }

  const matches = activeCards()
    .filter(isTaskCard)
    .filter((card) => `${card.title}\n${card.markdown}`.toLocaleLowerCase().includes(query));
  elements.nPanelSearchResults.hidden = false;
  elements.nPanelSearchResults.innerHTML = matches.length
    ? matches.map((card) => `<button class="n-panel__search-result" data-search-card="${card.id}">${escapeHTML(card.title || t('common.untitledTask'))}</button>`).join('')
    : `<div class="n-panel__search-empty">${t('taskflow.menu.noMatchingTasks')}</div>`;
}

function archiveActiveProject(): void {
  const project = activeProject();
  if (!project) return;
  void confirmDialog(t('taskflow.dialog.archiveConfirm'), t('taskflow.dialog.archiveMessage', { title: project.title }), t('taskflow.menu.archive'), t('common.cancel'), {
    dontShowAgainKey: 'tf:confirm:archive',
  }).then((ok) => {
    if (!ok) return;
    mutate(() => {
      project.archived = true;
      project.archivedAt = now();
      project.updatedAt = project.archivedAt;
      activateProject(data.projects.find((item) => !item.archived)?.id ?? null);
      selectedCardIds.clear();
    }, t('taskflow.toast.itemArchived'));
  });
}

/** 创建项目副本（含其下卡片与连接线，生成全新 id） */
function duplicateProject(projectId: string): void {
  const source = data.projects.find((p) => p.id === projectId);
  if (!source) return;
  const newProject = createProject(t('taskflow.dialog.copySuffix', { title: source.title }));
  const idMap = new Map<string, string>();
  mutate(() => {
    data.projects.push(newProject);
    const cards = getProjectCards(data, source.id);
    const copiedCards = cards.map((card) => {
      const newCard = { ...card, id: createId('card'), projectId: newProject.id, createdAt: now(), updatedAt: now() };
      delete (newCard as TaskCard).parentId;
      delete (newCard as TaskCard).noteCollapsed;
      delete (newCard as TaskCard).noteWidth;
      idMap.set(card.id, newCard.id);
      return newCard;
    });
    const copiedEdges = getProjectEdges(data, source.id)
      .filter((edge) => idMap.has(edge.sourceId) && idMap.has(edge.targetId))
      .map((edge) => ({ ...edge, id: createId('edge'), projectId: newProject.id, sourceId: idMap.get(edge.sourceId)!, targetId: idMap.get(edge.targetId)! }));
    data.cards.push(...copiedCards);
    data.edges.push(...copiedEdges);
    activateProject(newProject.id);
    selectedCardIds.clear();
  }, t('taskflow.toast.duplicateCreated'));
}

/** 在任务栏项目项上内联编辑标题（新建/重命名通用），聚焦全选，Enter/失焦确认 */
function beginProjectInlineEdit(projectId: string): void {
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return;
  const item = elements.projectList.querySelector<HTMLElement>(`[data-project-id="${projectId}"]`);
  if (!item) return;
  const titleEl = item.querySelector<HTMLElement>('.project-item__title');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'project-inline-input';
  input.value = project.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    mutate(() => { project.title = value || t('common.untitledTask'); project.updatedAt = now(); });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { e.preventDefault(); done = true; }
  });
  input.addEventListener('blur', () => { if (!done) finish(); });
}

/** 应用内输入弹窗（替代 Electron 不支持的 window.prompt） */
function promptProjectTitle(title: string, value = '', message?: string): Promise<string | null> {
  return new Promise((resolve) => {
    elements.dialogTitle.textContent = title;
    elements.dialogInput.value = value;
    elements.dialogInput.hidden = false;
    elements.dialogDontShow.hidden = true;
    elements.dialogOk.textContent = t('common.ok');
    elements.dialogCancel.textContent = t('common.cancel');
    let existingMsg = elements.dialog.querySelector<HTMLElement>('.app-dialog__message');
    if (message) {
      if (!existingMsg) {
        existingMsg = document.createElement('div');
        existingMsg.className = 'app-dialog__message';
        elements.dialogTitle.insertAdjacentElement('afterend', existingMsg);
      }
      existingMsg.textContent = message;
      existingMsg.hidden = false;
    } else if (existingMsg) {
      existingMsg.hidden = true;
    }
    elements.dialog.hidden = false;
    let done = false;
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      elements.dialog.hidden = true;
      elements.dialogInput.hidden = false;
      elements.dialogDontShow.hidden = true;
      const msgEl = elements.dialog.querySelector<HTMLElement>('.app-dialog__message');
      if (msgEl) msgEl.hidden = true;
      elements.dialogOk.removeEventListener('click', onOk);
      elements.dialogCancel.removeEventListener('click', onCancel);
      elements.dialogInput.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onWindowKey);
      resolve(result);
    };
    const onOk = (): void => finish(elements.dialogInput.value.trim());
    const onCancel = (): void => finish(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') onOk();
      else if (event.key === 'Escape') onCancel();
    };
    const onWindowKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') { event.preventDefault(); onOk(); }
    };
    elements.dialogOk.addEventListener('click', onOk);
    elements.dialogCancel.addEventListener('click', onCancel);
    elements.dialogInput.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onWindowKey);
    requestAnimationFrame(() => { elements.dialogInput.focus(); elements.dialogInput.select(); });
  });
}

function archiveSortTime(project: TaskProject): number {
  return new Date(project.archivedAt ?? project.updatedAt).getTime() || 0;
}

function formatArchiveTime(project: TaskProject): string {
  const timestamp = archiveSortTime(project);
  if (!timestamp) return t('taskflow.dialog.archiveDateUnknown');
  return new Intl.DateTimeFormat(getLocale(), {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function renderArchiveList(): void {
  const archived = data.projects
    .filter((project) => project.archived)
    .sort((a, b) => archiveSortTime(b) - archiveSortTime(a));

  elements.archiveList.innerHTML = archived.length
    ? archived.map((project) => `
      <article class="archive-item">
        <div class="archive-item__content">
          <div class="archive-item__title">${escapeHTML(project.title)}</div>
          <time class="archive-item__time">${formatArchiveTime(project)}</time>
        </div>
        <button class="archive-item__restore" data-restore-project="${project.id}">${t('taskflow.dialog.restore')}</button>
      </article>`).join('')
    : `<div class="archive-list__empty">${t('taskflow.dialog.archiveEmpty')}</div>`;
}

function openArchiveDialog(): void {
  renderArchiveList();
  elements.archiveDialog.hidden = false;
  elements.archiveClose.focus();
}

function closeArchiveDialog(): void {
  elements.archiveDialog.hidden = true;
}

function restoreArchivedProject(projectId: string): void {
  const project = data.projects.find((item) => item.id === projectId && item.archived);
  if (!project) return;
  mutate(() => {
    project.archived = false;
    project.archivedAt = null;
    project.updatedAt = now();
    activateProject(project.id);
  }, t('taskflow.toast.itemRestored'));
  renderArchiveList();
}

/** 应用内确认弹窗（替代 Electron 不支持的 window.confirm）
 *  @param key 若提供，勾选"不再提示"后将 key 写入 localStorage，下次直接返回 confirmValue */
function confirmDialog(
  title: string,
  message: string,
  okLabel = t('common.ok'),
  cancelLabel = t('common.cancel'),
  options?: { dontShowAgainKey?: string; defaultDontShow?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    const key = options?.dontShowAgainKey;
    if (key && localStorage.getItem(key) === '1') { resolve(true); return; }
    elements.dialogTitle.textContent = title;
    elements.dialogInput.hidden = true;
    elements.dialogInput.value = '';
    elements.dialogOk.textContent = okLabel;
    elements.dialogCancel.textContent = cancelLabel;
    if (key) {
      elements.dialogDontShow.hidden = false;
      elements.dialogDontShowCheck.checked = options?.defaultDontShow ?? false;
    } else {
      elements.dialogDontShow.hidden = true;
    }
    // 在 actions 前插入 message（用 title 下方显示）
    let msgEl = elements.dialog.querySelector<HTMLElement>('.app-dialog__message');
    if (!msgEl) {
      msgEl = document.createElement('div');
      msgEl.className = 'app-dialog__message';
      elements.dialogTitle.insertAdjacentElement('afterend', msgEl);
    }
    msgEl.textContent = message;
    elements.dialog.hidden = false;
    let done = false;
    const finish = (result: boolean): void => {
      if (done) return;
      done = true;
      if (key && result && elements.dialogDontShowCheck.checked) localStorage.setItem(key, '1');
      elements.dialog.hidden = true;
      elements.dialogInput.hidden = false;
      elements.dialogDontShow.hidden = true;
      msgEl.hidden = true;
      elements.dialogOk.removeEventListener('click', onOk);
      elements.dialogCancel.removeEventListener('click', onCancel);
      window.removeEventListener('keydown', onWindowKey);
      resolve(result);
    };
    const onOk = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onWindowKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') { event.preventDefault(); onOk(); }
      else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    };
    elements.dialogOk.addEventListener('click', onOk);
    elements.dialogCancel.addEventListener('click', onCancel);
    window.addEventListener('keydown', onWindowKey);
    requestAnimationFrame(() => elements.dialogOk.focus());
  });
}

function renameProject(projectId: string): void {
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return;
  // 若当前处于内联编辑中则忽略
  if (elements.projectList.querySelector('.project-inline-input')) return;
  beginProjectInlineEdit(projectId);
}

function deleteProject(projectId: string): void {
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return;
  void confirmDialog(t('taskflow.dialog.deleteConfirm'), t('taskflow.dialog.deleteItemMessage', { title: project.title }), t('common.delete'), t('common.cancel'), {
    dontShowAgainKey: 'tf:confirm:deleteProject',
  }).then((ok) => {
    if (!ok) return;
    mutate(() => {
      data.projects = data.projects.filter((p) => p.id !== projectId);
      data.cards = data.cards.filter((c) => c.projectId !== projectId);
      data.edges = data.edges.filter((e) => e.projectId !== projectId);
      data.groups = (data.groups ?? []).filter((g) => !data.cards.some((c) => c.groupId === g.id));
      if (data.activeProjectId === projectId) activateProject(data.projects.find((item) => !item.archived)?.id ?? null);
      selectedCardIds.clear();
    }, t('taskflow.toast.itemDeleted'));
  });
}

/** 置顶/取消置顶项目（后置顶优先） */
function toggleProjectPin(projectId: string): void {
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return;
  mutate(() => {
    if (project.pinnedAt) project.pinnedAt = null;
    else {
      project.pinnedAt = now();
      project.sortOrder = Math.max(...data.projects.map((item) => item.sortOrder ?? 0), 0) + 10;
    }
    project.updatedAt = now();
  });
}

function createProjectGroup(): void {
  void promptProjectTitle(t('taskflow.dialog.newGroupTitle'), t('taskflow.dialog.newGroupDefault')).then((title) => {
    if (!title) return;
    const group: TaskProjectGroup = {
      id: createId('project_group'),
      title,
      collapsed: false,
      sortOrder: Math.max(0, ...data.projectGroups.map((item) => item.sortOrder)) + 10,
    };
    mutate(() => data.projectGroups.push(group));
  });
}

function renameProjectGroup(groupId: string): void {
  const group = data.projectGroups.find((item) => item.id === groupId);
  if (!group) return;
  void promptProjectTitle(t('taskflow.dialog.renameGroupTitle'), group.title).then((title) => {
    if (!title) return;
    mutate(() => { group.title = title; });
  });
}

function deleteProjectGroup(groupId: string): void {
  const group = data.projectGroups.find((item) => item.id === groupId);
  if (!group) return;
  void confirmDialog(t('taskflow.dialog.deleteProjectGroup'), t('taskflow.dialog.deleteProjectGroupMessage', { title: group.title }), t('common.delete'), t('common.cancel')).then((ok) => {
    if (!ok) return;
    mutate(() => {
      data.projectGroups = data.projectGroups.filter((item) => item.id !== groupId);
      for (const project of data.projects) {
        if (project.sidebarGroupId === groupId) project.sidebarGroupId = null;
      }
    });
  });
}

function moveProjectToGroup(projectId: string, groupId: string | null): void {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) return;
  mutate(() => {
    project.sidebarGroupId = groupId;
    project.updatedAt = now();
  });
}

function wireProjectList(): void {
  const clearProjectItemDropPreview = (): void => {
    elements.projectList.querySelectorAll('.project-item.is-drop-before, .project-item.is-drop-after')
      .forEach((item) => item.classList.remove('is-drop-before', 'is-drop-after'));
  };
  const showProjectItemDropPreview = (item: HTMLElement, placeBefore: boolean): void => {
    const className = placeBefore ? 'is-drop-before' : 'is-drop-after';
    if (item.classList.contains(className)) return;
    clearProjectItemDropPreview();
    item.classList.add(className);
  };
  const captureProjectPositions = (): Map<string, DOMRect> => new Map(
    [...elements.projectList.querySelectorAll<HTMLElement>('[data-project-id]')]
      .map((item) => [item.dataset.projectId!, item.getBoundingClientRect()]),
  );
  const animateProjectReorder = (previousPositions: Map<string, DOMRect>): void => {
    for (const item of elements.projectList.querySelectorAll<HTMLElement>('[data-project-id]')) {
      const previous = previousPositions.get(item.dataset.projectId!);
      if (!previous) continue;
      const deltaY = previous.top - item.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1) continue;
      item.animate(
        [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
        { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
  };
  const clearProjectGroupDropPreview = (immediate = false): void => {
    elements.projectList.querySelectorAll('.project-group.is-project-drop-target')
      .forEach((item) => item.classList.remove('is-project-drop-target'));
    elements.projectList.querySelectorAll<HTMLElement>('.project-group__drop-preview').forEach((item) => {
      if (immediate) {
        item.remove();
        return;
      }
      if (item.classList.contains('is-leaving')) return;
      item.classList.add('is-leaving');
      item.addEventListener('animationend', () => item.remove(), { once: true });
    });
  };
  const showProjectGroupDropPreview = (group: HTMLElement): void => {
    if (group.classList.contains('is-project-drop-target') && group.querySelector('.project-group__drop-preview')) return;
    clearProjectGroupDropPreview();
    const header = group.querySelector<HTMLElement>('[data-project-group-toggle]');
    if (!header) return;
    const project = projectDrag ? data.projects.find((item) => item.id === projectDrag!.id) : null;
    const preview = document.createElement('div');
    const title = document.createElement('span');
    preview.className = 'project-group__drop-preview';
    title.textContent = project?.title ?? t('taskflow.dialog.moveToFile');
    preview.appendChild(title);
    group.classList.add('is-project-drop-target');
    header.insertAdjacentElement('afterend', preview);
  };
  const updateProjectPointerPreview = (clientX: number, clientY: number): void => {
    if (!projectDrag) return;
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const dropZone = target?.closest<HTMLElement>('[data-project-group-toggle], .project-group__drop-preview');
    const targetGroup = dropZone?.closest<HTMLElement>('[data-project-group-id]');
    if (targetGroup) {
      clearProjectItemDropPreview();
      showProjectGroupDropPreview(targetGroup);
      projectDrag.targetId = null;
      return;
    }
    clearProjectGroupDropPreview();
    const item = target?.closest<HTMLElement>('[data-project-id]');
    if (!item || item.dataset.projectId === projectDrag.id) {
      projectDrag.targetId = null;
      clearProjectItemDropPreview();
      return;
    }
    const rect = item.getBoundingClientRect();
    projectDrag.targetId = item.dataset.projectId!;
    projectDrag.placeBefore = clientY < rect.top + rect.height / 2;
    showProjectItemDropPreview(item, projectDrag.placeBefore);
  };
  const finishProjectPointerDrop = (clientX: number, clientY: number): void => {
    const drag = projectDrag;
    projectPointerDrag = null;
    elements.projectListScroll.classList.remove('is-project-pointer-dragging');
    if (!drag) return;
    updateProjectPointerPreview(clientX, clientY);
    projectDrag = null;
    elements.projectList.querySelectorAll('.is-dragging').forEach((item) => item.classList.remove('is-dragging'));
    clearProjectItemDropPreview();
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const groupDropZone = target?.closest<HTMLElement>('[data-project-group-toggle], .project-group__drop-preview');
    const targetItem = target?.closest<HTMLElement>('[data-project-id]');
    const candidateGroup = groupDropZone?.closest<HTMLElement>('[data-project-group-id]')
      ?? targetItem?.closest<HTMLElement>('[data-project-group-id]');
    const sourceProject = data.projects.find((project) => project.id === drag.id);
    const targetProject = targetItem ? data.projects.find((project) => project.id === targetItem.dataset.projectId) : undefined;
    const targetGroup = candidateGroup && sourceProject?.sidebarGroupId !== candidateGroup.dataset.projectGroupId
      ? candidateGroup
      : null;
    const moveToUngrouped = Boolean(targetItem && sourceProject?.sidebarGroupId && !candidateGroup);
    const promoteToPinned = Boolean(targetItem && targetProject?.pinnedAt && !sourceProject?.pinnedAt);
    const demoteFromPinned = Boolean(targetItem && !targetProject?.pinnedAt && sourceProject?.pinnedAt);
    if (targetGroup) {
      clearProjectGroupDropPreview(true);
      moveProjectToGroup(drag.id, targetGroup.dataset.projectGroupId!);
      return;
    }
    clearProjectGroupDropPreview();
    if (!drag.targetId) return;
    const sorted = sortProjects().filter((project) => !project.archived);
    const sourceIndex = sorted.findIndex((project) => project.id === drag.id);
    if (sourceIndex < 0) return;
    const [moved] = sorted.splice(sourceIndex, 1);
    let targetIndex = sorted.findIndex((project) => project.id === drag.targetId);
    if (targetIndex < 0) return;
    if (!drag.placeBefore) targetIndex += 1;
    sorted.splice(targetIndex, 0, moved);
    const previousPositions = new Map(
      [...elements.projectList.querySelectorAll<HTMLElement>('[data-project-id]')]
        .map((item) => [item.dataset.projectId!, item.getBoundingClientRect()]),
    );
    mutate(() => {
      sorted.forEach((project, index) => {
        project.sortOrder = (sorted.length - index) * 10;
        project.updatedAt = now();
      });
      if (moveToUngrouped) {
        const movedProject = data.projects.find((project) => project.id === drag.id);
        if (movedProject) {
          movedProject.sidebarGroupId = null;
          movedProject.updatedAt = now();
        }
      }
      if (promoteToPinned) {
        const movedProject = data.projects.find((project) => project.id === drag.id);
        if (movedProject) {
          movedProject.pinnedAt = now();
          movedProject.updatedAt = now();
        }
      }
      if (demoteFromPinned) {
        const movedProject = data.projects.find((project) => project.id === drag.id);
        if (movedProject) {
          movedProject.pinnedAt = null;
          movedProject.updatedAt = now();
        }
      }
    });
    requestAnimationFrame(() => {
      for (const item of elements.projectList.querySelectorAll<HTMLElement>('[data-project-id]')) {
        const previous = previousPositions.get(item.dataset.projectId!);
        if (!previous) continue;
        const deltaY = previous.top - item.getBoundingClientRect().top;
        if (Math.abs(deltaY) < 1) continue;
        item.animate([{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }], {
          duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        });
      }
    });
  };
  elements.projectListScroll.addEventListener('pointerdown', (event) => {
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-sort-handle]');
    if (!handle || event.button !== 0) return;
    const item = handle.closest<HTMLElement>('[data-project-id]');
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    projectPointerDrag = { id: handle.dataset.sortHandle!, startX: event.clientX, startY: event.clientY, moved: false };
    projectDrag = { id: handle.dataset.sortHandle!, targetId: null, placeBefore: false };
    elements.projectListScroll.classList.add('is-project-pointer-dragging');
    item.classList.add('is-dragging');
  });
  window.addEventListener('pointermove', (event) => {
    if (!projectPointerDrag) return;
    const distance = Math.hypot(event.clientX - projectPointerDrag.startX, event.clientY - projectPointerDrag.startY);
    if (!projectPointerDrag.moved && distance < 5) return;
    projectPointerDrag.moved = true;
    event.preventDefault();
    updateProjectPointerPreview(event.clientX, event.clientY);
  });
  window.addEventListener('pointerup', (event) => {
    if (!projectPointerDrag) return;
    event.preventDefault();
    finishProjectPointerDrop(event.clientX, event.clientY);
  });
  window.addEventListener('pointercancel', () => {
    if (!projectPointerDrag) return;
    projectPointerDrag = null;
    projectDrag = null;
    elements.projectListScroll.classList.remove('is-project-pointer-dragging');
    clearProjectGroupDropPreview(true);
    clearProjectItemDropPreview();
    elements.projectList.querySelectorAll('.is-dragging').forEach((item) => item.classList.remove('is-dragging'));
  });
  elements.projectList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const groupToggle = target.closest<HTMLElement>('[data-project-group-toggle]');
    if (groupToggle) {
      const group = data.projectGroups.find((item) => item.id === groupToggle.dataset.projectGroupToggle);
      const groupElement = groupToggle.closest<HTMLElement>('[data-project-group-id]');
      if (group && groupElement) {
        history.push(data);
        group.collapsed = !group.collapsed;
        groupElement.classList.toggle('is-collapsed', group.collapsed);
        elements.undo.disabled = !history.canUndo;
        elements.redo.disabled = !history.canRedo;
        scheduleSave();
      }
      return;
    }
    if (target.closest('[data-sort-handle]')) return;
    const item = target.closest<HTMLElement>('[data-project-id]');
    if (item && item.dataset.projectId !== data.activeProjectId) setActiveProject(item.dataset.projectId!);
  });
  elements.projectList.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-sort-handle]')) return;
    const item = target.closest<HTMLElement>('[data-project-id]');
    if (item) renameProject(item.dataset.projectId!);
  });
  elements.projectList.addEventListener('contextmenu', (event) => {
    const groupHeader = (event.target as HTMLElement).closest<HTMLElement>('[data-project-group-toggle]');
    if (groupHeader) {
      event.preventDefault();
      const groupId = groupHeader.dataset.projectGroupToggle!;
      openContextMenu(event.clientX, event.clientY, [
        { label: t('taskflow.menu.renameGroup'), action: () => renameProjectGroup(groupId) },
        { label: t('taskflow.menu.deleteProjectGroup'), action: () => deleteProjectGroup(groupId), danger: true },
      ]);
      return;
    }
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-project-id]');
    if (!item) return;
    event.preventDefault();
    contextProjectId = item.dataset.projectId!;
    showProjectContextMenu(event.clientX, event.clientY, contextProjectId);
  });
  // 拖动手柄排序
  elements.projectListScroll.addEventListener('dragstart', (event) => {
    const groupHeader = (event.target as HTMLElement).closest<HTMLElement>('[data-project-group-drag]');
    if (groupHeader) {
      const group = groupHeader.closest<HTMLElement>('[data-project-group-id]');
      if (!group) return;
      const id = groupHeader.dataset.projectGroupDrag!;
      projectGroupDrag = { id, targetId: null, placeBefore: false };
      group.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      return;
    }
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-sort-handle]');
    if (!handle) return;
    const item = handle.closest<HTMLElement>('[data-project-id]');
    if (!item) return;
    const id = handle.dataset.sortHandle!;
    projectDrag = { id, targetId: null, placeBefore: false };
    item.classList.add('is-dragging');
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      const rect = item.getBoundingClientRect();
      const dragImage = item.cloneNode(true) as HTMLElement;
      dragImage.classList.remove('is-dragging');
      dragImage.style.position = 'fixed';
      dragImage.style.top = '-1000px';
      dragImage.style.left = '-1000px';
      dragImage.style.width = `${rect.width}px`;
      dragImage.style.opacity = '0.72';
      dragImage.style.pointerEvents = 'none';
      document.body.appendChild(dragImage);
      event.dataTransfer.setDragImage(dragImage, event.clientX - rect.left, event.clientY - rect.top);
      requestAnimationFrame(() => dragImage.remove());
    }
  });
  const allowSidebarDrop = (event: DragEvent): void => {
    if (!projectDrag && !projectGroupDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  };
  window.addEventListener('dragenter', allowSidebarDrop);
  window.addEventListener('dragover', allowSidebarDrop);
  const scrollProjectListWhileDragging = (event: WheelEvent): void => {
    if (!projectDrag && !projectGroupDrag) return;
    // 原生拖拽期间将滚轮固定交给任务栏，避免落到画布时触发缩放或横向移动。
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    elements.projectListScroll.scrollTop += delta;
  };
  // 原生 HTML5 拖拽时，Windows/Chromium 可能把 wheel 目标设为 document/body，
  // 因此在窗口捕获阶段接收一次；容器监听作为鼠标仍位于任务栏时的兜底。
  window.addEventListener('wheel', scrollProjectListWhileDragging, { capture: true, passive: false });
  elements.projectListScroll.addEventListener('wheel', scrollProjectListWhileDragging, { passive: false });
  elements.projectListScroll.addEventListener('dragover', (event) => {
    if (projectGroupDrag) {
      allowSidebarDrop(event);
      clearProjectItemDropPreview();
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-project-group-id]');
      elements.projectList.querySelectorAll('.project-group.is-drop-before, .project-group.is-drop-after')
        .forEach((item) => item.classList.remove('is-drop-before', 'is-drop-after'));
      if (!target || target.dataset.projectGroupId === projectGroupDrag.id) {
        projectGroupDrag.targetId = null;
        return;
      }
      const rect = target.getBoundingClientRect();
      projectGroupDrag.targetId = target.dataset.projectGroupId!;
      projectGroupDrag.placeBefore = event.clientY < rect.top + rect.height / 2;
      target.classList.add(projectGroupDrag.placeBefore ? 'is-drop-before' : 'is-drop-after');
      return;
    }
    if (!projectDrag) return;
    allowSidebarDrop(event);
    const dropZone = (event.target as HTMLElement).closest<HTMLElement>('[data-project-group-toggle], .project-group__drop-preview');
    const targetGroup = dropZone?.closest<HTMLElement>('[data-project-group-id]');
    if (targetGroup) {
      clearProjectItemDropPreview();
      showProjectGroupDropPreview(targetGroup);
      projectDrag.targetId = null;
      return;
    }
    clearProjectGroupDropPreview();
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-project-id]');
    if (!item || item.dataset.projectId === projectDrag.id) {
      projectDrag.targetId = null;
      clearProjectItemDropPreview();
      return;
    }
    const rect = item.getBoundingClientRect();
    projectDrag.targetId = item.dataset.projectId!;
    projectDrag.placeBefore = event.clientY < rect.top + rect.height / 2;
    showProjectItemDropPreview(item, projectDrag.placeBefore);
  });
  elements.projectListScroll.addEventListener('drop', (event) => {
    event.preventDefault();
    if (projectGroupDrag) {
      const drag = projectGroupDrag;
      projectGroupDrag = null;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-project-group-id]');
      if (target && target.dataset.projectGroupId !== drag.id) {
        const rect = target.getBoundingClientRect();
        drag.targetId = target.dataset.projectGroupId!;
        drag.placeBefore = event.clientY < rect.top + rect.height / 2;
      }
      if (!drag.targetId) {
        elements.projectList.querySelectorAll('.project-group').forEach((item) => item.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
        return;
      }
      const groups = [...data.projectGroups].sort((a, b) => b.sortOrder - a.sortOrder);
      const sourceIndex = groups.findIndex((group) => group.id === drag.id);
      if (sourceIndex < 0) return;
      const [moved] = groups.splice(sourceIndex, 1);
      let targetIndex = groups.findIndex((group) => group.id === drag.targetId);
      if (targetIndex < 0) return;
      if (!drag.placeBefore) targetIndex += 1;
      groups.splice(targetIndex, 0, moved);
      mutate(() => {
        groups.forEach((group, index) => { group.sortOrder = (groups.length - index) * 10; });
      });
      return;
    }
    const drag = projectDrag;
    projectDrag = null;
    elements.projectList.querySelectorAll('.is-dragging').forEach((item) => item.classList.remove('is-dragging'));
    clearProjectItemDropPreview();
    const groupDropZone = (event.target as HTMLElement).closest<HTMLElement>('[data-project-group-toggle], .project-group__drop-preview');
    const targetGroup = groupDropZone?.closest<HTMLElement>('[data-project-group-id]');
    if (drag && targetGroup) {
      const groupId = targetGroup.dataset.projectGroupId!;
      clearProjectGroupDropPreview(true);
      moveProjectToGroup(drag.id, groupId);
      return;
    }
    clearProjectGroupDropPreview();
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-project-id]');
    if (drag && item && item.dataset.projectId !== drag.id) {
      const rect = item.getBoundingClientRect();
      drag.targetId = item.dataset.projectId!;
      drag.placeBefore = event.clientY < rect.top + rect.height / 2;
    }
    if (!drag?.targetId) return;
    const previousPositions = captureProjectPositions();
    const sorted = sortProjects().filter((project) => !project.archived);
    const sourceIndex = sorted.findIndex((project) => project.id === drag.id);
    if (sourceIndex < 0) return;
    const [moved] = sorted.splice(sourceIndex, 1);
    let targetIndex = sorted.findIndex((project) => project.id === drag.targetId);
    if (targetIndex < 0) return;
    if (!drag.placeBefore) targetIndex += 1;
    sorted.splice(targetIndex, 0, moved);
    mutate(() => {
      sorted.forEach((project, index) => {
        project.sortOrder = (sorted.length - index) * 10;
        project.updatedAt = now();
      });
    });
    animateProjectReorder(previousPositions);
  });
  elements.projectListScroll.addEventListener('dragend', () => {
    projectDrag = null;
    projectGroupDrag = null;
    clearProjectGroupDropPreview();
    clearProjectItemDropPreview();
    elements.projectList.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after')
      .forEach((item) => item.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
  });
}

function wireContextMenu(): void {
  window.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('.context-menu')) return;
    closeContextMenu();
  }, { capture: true });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeContextMenu();
  });
}

function closeContextMenu(): void {
  contextProjectId = null;
  contextCardId = null;
  document.querySelectorAll('.context-menu').forEach((el) => el.remove());
}

function showProjectContextMenu(clientX: number, clientY: number, projectId: string): void {
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return;
  const groupItems = [...data.projectGroups]
    .sort((a, b) => b.sortOrder - a.sortOrder)
    .filter((group) => group.id !== project.sidebarGroupId)
    .map((group) => ({ label: t('taskflow.menu.moveToGroup', { title: group.title }), action: () => moveProjectToGroup(projectId, group.id) }));
  const items = [
    { label: project.pinnedAt ? t('taskflow.menu.unpin') : t('taskflow.menu.pin'), action: () => toggleProjectPin(projectId) },
    ...groupItems,
    ...(project.sidebarGroupId ? [{ label: t('taskflow.menu.removeFromGroup'), action: () => moveProjectToGroup(projectId, null) }] : []),
    { label: t('taskflow.menu.rename'), action: () => renameProject(projectId) },
    { label: t('taskflow.menu.duplicate'), action: () => duplicateProject(projectId) },
    { label: t('taskflow.menu.archive'), action: () => archiveProject(projectId) },
    { label: t('taskflow.menu.delete'), action: () => deleteProject(projectId), danger: true },
  ];
  openContextMenu(clientX, clientY, items);
}

function showCanvasGroupContextMenu(clientX: number, clientY: number, groupId: string): void {
  openContextMenu(clientX, clientY, [
    ...GROUP_OUTLINE_COLORS.map((color) => ({
      label: t(color.labelKey),
      color: color.value,
      action: () => setCanvasGroupOutlineColor(groupId, color.value),
    })),
    { label: t('taskflow.menu.deleteCanvasGroup'), action: () => deleteCanvasGroup(groupId, false), danger: true },
    { label: t('taskflow.menu.deleteCanvasGroupAndCards'), action: () => deleteCanvasGroup(groupId, true), danger: true },
  ]);
}

function archiveProject(projectId: string): void {
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return;
  void confirmDialog(t('taskflow.dialog.archiveConfirm'), t('taskflow.dialog.archiveMessage', { title: project.title }), t('taskflow.menu.archive'), t('common.cancel'), {
    dontShowAgainKey: 'tf:confirm:archive',
  }).then((ok) => {
    if (!ok) return;
    mutate(() => {
      project.archived = true;
      project.archivedAt = now();
      project.updatedAt = project.archivedAt;
      if (data.activeProjectId === projectId) activateProject(data.projects.find((item) => !item.archived)?.id ?? null);
      selectedCardIds.clear();
    }, t('taskflow.toast.itemArchived'));
  });
}

interface ContextMenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  color?: string;
}

function openContextMenu(
  clientX: number,
  clientY: number,
  items: ContextMenuItem[],
): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = `context-menu${items.some((item) => item.color) ? ' context-menu--group' : ''}`;
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  const appendItem = (container: HTMLElement, item: ContextMenuItem): void => {
    const button = document.createElement('button');
    button.className = `context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`;
    if (item.color) {
      const swatch = document.createElement('span');
      swatch.className = 'context-menu__swatch';
      swatch.style.background = item.color;
      button.appendChild(swatch);
      button.classList.add('context-menu__item--color');
      button.setAttribute('aria-label', item.label);
    }
    else button.append(item.label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeContextMenu();
      item.action?.();
    });
    container.appendChild(button);
  };
  const colorItems = items.filter((item) => item.color);
  const normalItems = items.filter((item) => !item.color);
  if (colorItems.length) {
    const colorRow = document.createElement('div');
    colorRow.className = 'context-menu__color-row';
    colorItems.forEach((item) => appendItem(colorRow, item));
    menu.appendChild(colorRow);
  }
  normalItems.forEach((item) => appendItem(menu, item));
  // 防止溢出视口
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  });
  document.body.appendChild(menu);
}

/** 在指定屏幕坐标检测经过的连接线热区，若命中则切断（记录 + 从渲染中隐藏） */
function cutEdgeAt(clientX: number, clientY: number): void {
  const edgeId = document.elementsFromPoint(clientX, clientY)
    .map((element) => element.closest<SVGElement>('[data-edge-hit]')?.dataset.edgeHit)
    .find((id): id is string => Boolean(id));
  if (!edgeId || cutEdges.has(edgeId)) return;
  cutEdges.add(edgeId);
  // 视觉上立即隐藏该连接线
  elements.edgeLayer.querySelector(`[data-edge-id="${edgeId}"]`)?.setAttribute('visibility', 'hidden');
}

/** 从上次采样点到当前点做线性插值采样，避免快速移动时跳过连接线 */
function cutScan(clientX: number, clientY: number): void {
  const dx = clientX - cutLastPoint.x;
  const dy = clientY - cutLastPoint.y;
  const dist = Math.hypot(dx, dy);
  const step = 6; // 采样步长（px）
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= steps; i++) {
    cutEdgeAt(cutLastPoint.x + (dx * i) / steps, cutLastPoint.y + (dy * i) / steps);
  }
  cutLastPoint = { x: clientX, y: clientY };
}

/** 用窗口内采样点重建切割轨迹 path */
function updateCutTrail(): void {
  if (!cutTrailEl) return;
  if (cutTrailPoints.length < 2) {
    cutTrailEl.setAttribute('d', '');
    return;
  }
  const d = cutTrailPoints.map((p) => `${p.x} ${p.y}`).join(' L ');
  cutTrailEl.setAttribute('d', `M ${d}`);
}

function wireCanvas(): void {
  elements.viewport.addEventListener('wheel', (event) => {
    // 鼠标悬停在内容超出、需要滚动的说明框上时：优先滚动说明框，不滚动画布
    const hoverScrollable = (event.target as HTMLElement | null)?.closest<HTMLElement>('.task-note__body');
    if (hoverScrollable && hoverScrollable.scrollHeight > hoverScrollable.clientHeight) {
      return; // 不 preventDefault，交给说明框原生滚动
    }
    // 禁用说明框滚动条的鼠标左键拖动（只保留滚轮滚动）
    document.addEventListener('mousedown', (event) => {
      const noteBody = (event.target as HTMLElement | null)?.closest<HTMLElement>('.task-note__body');
      if (!noteBody) return;
      const rect = noteBody.getBoundingClientRect();
      if (event.clientX > rect.right - 7) event.preventDefault(); // 点在滚动条区域（7px）：阻止拖动
    }, true);
    event.preventDefault();
    // 默认 Ctrl+滚轮缩放、普通滚轮横移；可在设置中互换两种操作。
    const shouldZoom = taskFlowPreferences.wheelCtrlSwap ? !event.ctrlKey : event.ctrlKey;
    if (shouldZoom) {
      cancelWheelPan();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setZoom(transform.zoom * factor, event.clientX, event.clientY);
    } else {
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      queueWheelPan(delta);
    }
  }, { passive: false });

  // 画布快捷键：空格按住 + 左键拖动 → 平移；Z + 左键拖动 → 缩放（左划缩小、右划放大）
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.code === 'Space') spaceKeyDown = true;
  if (event.key === 'Shift') shiftKeyDown = true;
  spacePressed = spaceKeyDown && shiftKeyDown;
  if (event.key.toLowerCase() === 'z') zPressed = true;
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') spaceKeyDown = false;
  if (event.key === 'Shift') shiftKeyDown = false;
  spacePressed = spaceKeyDown && shiftKeyDown;
  if (event.key.toLowerCase() === 'z') zPressed = false;
});
  window.addEventListener('pointermove', (event) => {
    if (cuttingEdge) return;
    if (document.activeElement && document.activeElement.matches('input,textarea')) return;
    // Z + 左键拖动：按鼠标横向位移缩放（向左缩小、向右放大），始终以按下位置为中心
    if (zDragActive) {
      const factor = event.movementX < 0 ? 0.95 : 1.05; // 灵敏度 5%
      if (zDragOrigin) setZoom(transform.zoom * factor, zDragOrigin.x, zDragOrigin.y);
    }
  });
  window.addEventListener('pointerup', () => {
    zDragActive = false;
    zDragOrigin = null;
  });

  elements.viewport.addEventListener('contextmenu', (event) => {
    if (cuttingEdge || placementMode || connectionState) {
      event.preventDefault();
      exitPlacementMode();
      connectionState = null;
      clearConnectionSnap();
      renderEdges();
    }
  });

  // Ctrl+右键长按拖动：切断经过的连接线（橡皮擦式），并显示最近 250ms 的轨迹
  window.addEventListener('pointerdown', (event) => {
    if (event.button === 2 && event.ctrlKey && elements.viewport.contains(event.target as Node)) {
      event.preventDefault();
      event.stopPropagation();
      // 清理可能残留的光标定位镜像层（z-index 极高，遮挡 elementFromPoint 会导致切不断）
      document.querySelectorAll('[data-caret-mirror]').forEach((el) => el.remove());
      cuttingEdge = true;
      cutEdges.clear();
      cutLastPoint = { x: event.clientX, y: event.clientY };
      try { elements.viewport.setPointerCapture(event.pointerId); } catch { /* 无法捕获时仍由 window 监听继续切断 */ }
      const start = clientToWorld(event.clientX, event.clientY);
      cutTrailEl = document.createElementNS('http://www.w3.org/2000/svg', 'path') as SVGPathElement;
      cutTrailEl.setAttribute('class', 'cut-trail');
      elements.edgeLayer.appendChild(cutTrailEl);
      const now = performance.now();
      cutTrailPoints = [{ x: start.x, y: start.y, t: now }];
      updateCutTrail();
      cutEdgeAt(event.clientX, event.clientY);
    }
  }, true);
  window.addEventListener('pointermove', (event) => {
    if (!cuttingEdge) return;
    cutScan(event.clientX, event.clientY); // 插值采样，快速移动也能切断
    if (cutTrailEl) {
      const to = clientToWorld(event.clientX, event.clientY);
      const now = performance.now();
      cutTrailPoints.push({ x: to.x, y: to.y, t: now });
      // 只保留最近 250ms 的轨迹点（彗星尾巴），超过的从头部移除
      while (cutTrailPoints.length > 2 && now - cutTrailPoints[0].t > 250) cutTrailPoints.shift();
      updateCutTrail();
    }
  });
  window.addEventListener('pointerup', () => {
    if (!cuttingEdge) return;
    cuttingEdge = false;
    const trail = cutTrailEl;
    cutTrailEl = null;
    cutTrailPoints = [];
    if (trail) {
      // 松开后轨迹短暂停留并淡出，便于看清切割路径
      trail.classList.add('is-fading');
      window.setTimeout(() => trail.remove(), 250);
    }
    if (cutEdges.size) {
      const count = cutEdges.size;
      mutate(() => {
        data.edges = data.edges.filter((edge) => !cutEdges.has(edge.id));
      }, t('taskflow.toast.edgesCut', { n: count }));
    }
    cutEdges.clear();
  });

  elements.viewport.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement;
    const cardElement = target.closest<HTMLElement>('[data-card-id]');
    if (!cardElement && tightCanvasDoubleClick) {
      const point = clientToWorld(event.clientX, event.clientY);
      addCardAt(point.x - CARD_WIDTH / 2, point.y - CARD_HEADER_HEIGHT / 2);
    }
    tightCanvasDoubleClick = false;
  });

  elements.viewport.addEventListener('pointermove', (event) => {
    lastPointer = { clientX: event.clientX, clientY: event.clientY };
    updatePlacementPreview(event.clientX, event.clientY);
    if (connectionState) {
      const targetSide = connectionState.sourceSide === 'out' ? 'in' : 'out';
      const snap = connectionSnapTarget(event.clientX, event.clientY, connectionState.sourceId, targetSide);
      clearConnectionSnap();
      if (snap) {
        connectionState.snappedTargetId = snap.id;
        connectionState.pointer = snap.point;
        snappedConnectionHandle = snap.handle;
        snappedConnectionHandle.classList.add('is-snap-target');
      } else {
        connectionState.snappedTargetId = null;
        connectionState.pointer = clientToWorld(event.clientX, event.clientY);
      }
      renderEdges();
    }
  });

  elements.viewport.addEventListener('pointerdown', (event) => {
    lastPointer = { clientX: event.clientX, clientY: event.clientY };
    const target = event.target as HTMLElement;
    if (event.button === 0 && !target.closest('[data-card-id]')) {
      const nowTime = Date.now();
      tightCanvasDoubleClick = Boolean(lastCanvasPointerDown
        && nowTime - lastCanvasPointerDown.time <= 280
        && Math.hypot(event.clientX - lastCanvasPointerDown.x, event.clientY - lastCanvasPointerDown.y) <= 18);
      lastCanvasPointerDown = { time: nowTime, x: event.clientX, y: event.clientY };
    } else {
      tightCanvasDoubleClick = false;
    }
    if (quickConnectActive && event.button === 0 && !target.closest('[data-card-id]')) {
      event.preventDefault();
      return;
    }
    // Z + 左键：进入缩放拖动模式
    if (event.button === 0 && zPressed && !(document.activeElement && document.activeElement.matches('input,textarea'))) {
      event.preventDefault();
      zDragActive = true;
      zDragOrigin = { x: event.clientX, y: event.clientY }; // 记录按下位置作为缩放中心
      return;
    }
    if (placementMode && event.button === 0) {
      const point = clientToWorld(event.clientX, event.clientY);
      if (placementMode === 'note') createStandaloneNoteAtWorld(point.x, point.y);
      else {
        const edgeId = edgeAtClientPoint(event.clientX, event.clientY)?.id
          ?? edgeAtWorldPoint(point)?.id
          ?? target.closest<SVGElement>('[data-edge-hit]')?.dataset.edgeHit;
        addCardAt(point.x - CARD_WIDTH / 2, point.y - CARD_HEADER_HEIGHT / 2, t('common.newTask'), edgeId);
      }
      event.preventDefault();
      exitPlacementMode();
      return;
    }

    const handle = target.closest<HTMLElement>('[data-handle]');
    const cardElement = target.closest<HTMLElement>('[data-card-id]');
    if (handle && cardElement && event.button === 0) {
      event.preventDefault();
      const sourceSide = handle.dataset.handle === 'in' ? 'in' : 'out';
      connectionState = {
        sourceId: cardElement.dataset.cardId!,
        sourceSide,
        pointer: clientToWorld(event.clientX, event.clientY),
        snappedTargetId: null,
      };
      renderEdges();
      return;
    }

    // 中键拖动 / 空格+左键拖动 → 平移画布（编辑态下空格+左键不触发）
    if (event.button === 1 || (event.button === 0 && spacePressed && !(document.activeElement && document.activeElement.matches('input,textarea')))) {
      event.preventDefault();
      const start = clientToViewport(event.clientX, event.clientY);
      const initial = { x: transform.x, y: transform.y };
      elements.viewport.classList.add('is-panning');
      const move = (moveEvent: PointerEvent) => {
        const point = clientToViewport(moveEvent.clientX, moveEvent.clientY);
        transform.x = initial.x + point.x - start.x;
        transform.y = initial.y + point.y - start.y;
        applyTransform();
      };
      const up = () => {
        elements.viewport.classList.remove('is-panning');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        scheduleSave();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    if (event.button === 0 && !cardElement && !target.closest('.viewport-controls')) {
      if (editingCardId && editingField) commitEditing(undefined, true);
      selectedCardIds.clear();
      selectedEdgeId = null;
      const start = clientToWorld(event.clientX, event.clientY);
      marqueeState = { start, current: start };
      elements.selectionMarquee.hidden = false;
      elements.selectionMarquee.style.left = `${start.x}px`;
      elements.selectionMarquee.style.top = `${start.y}px`;
      elements.selectionMarquee.style.width = '0px';
      elements.selectionMarquee.style.height = '0px';
      // 用 render() 而非 renderCards()，确保说明框位置由 layoutNoteCards 同帧修正，避免闪动
      render();
    }
  });

  window.addEventListener('pointerup', (event) => {
    if (!connectionState) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const targetCard = target?.closest<HTMLElement>('[data-card-id]');
    const requiredTargetSide = connectionState.sourceSide === 'out' ? 'in' : 'out';
    const targetHandle = target?.closest<HTMLElement>(`[data-handle="${requiredTargetSide}"]`);
    const sourceId = connectionState.sourceId;
    const sourceSide = connectionState.sourceSide;
    const snappedTargetId = connectionState.snappedTargetId;
    const sourceCard = data.cards.find((c) => c.id === sourceId);
    connectionState = null;
    clearConnectionSnap();
    const targetId = snappedTargetId ?? (targetCard && targetHandle ? targetCard.dataset.cardId : undefined);
    if (targetId && targetId !== sourceId && data.activeProjectId) {
      const edgeSourceId = sourceSide === 'out' ? sourceId : targetId;
      const edgeTargetId = sourceSide === 'out' ? targetId : sourceId;
      const exists = data.edges.some((edge) => edge.sourceId === edgeSourceId && edge.targetId === edgeTargetId);
      if (!exists) mutate(() => data.edges.push(createEdge(data.activeProjectId!, edgeSourceId, edgeTargetId)), t('taskflow.toast.flowLinkCreated'));
      else renderEdges();
    } else if (sourceCard && data.activeProjectId) {
      // 空白处松开：右端点创建后续卡片，左端点创建前置卡片。
      const point = clientToWorld(event.clientX, event.clientY);
      const next = createCard(data.activeProjectId, point.x - CARD_WIDTH / 2, point.y - CARD_HEADER_HEIGHT / 2, t('common.newTask'));
      mutate(() => {
        data.cards.push(next);
        data.edges.push(sourceSide === 'out'
          ? createEdge(data.activeProjectId!, sourceId, next.id)
          : createEdge(data.activeProjectId!, next.id, sourceId));
        selectedCardIds = new Set([next.id]);
        editingCardId = next.id;
        editingField = 'title';
      });
    } else {
      renderEdges();
    }
  });

  elements.edgeLayer.addEventListener('click', (event) => {
    const edge = (event.target as SVGElement).closest<SVGElement>('[data-edge-hit]');
    if (!edge) return;
    selectedEdgeId = edge.dataset.edgeHit ?? null;
    selectedCardIds.clear();
    render();
  });

  elements.cardLayer.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (suppressStandaloneNoteClick) {
      suppressStandaloneNoteClick = false;
      return;
    }
    if (suppressDraggedCardClick) {
      suppressDraggedCardClick = false;
      return;
    }
    // 鼠标拖选结束时仍会产生 click。不要把已有文本选区误当成正文编辑，
    // 否则 render() 重建 DOM 会立刻清除选区，并在阅读态与编辑态之间跳变。
    if (hasCardBodyTextSelection(target)) return;
    const cardElement = target.closest<HTMLElement>('[data-card-id]');
    if (!cardElement) return;
    const card = data.cards.find((item) => item.id === cardElement.dataset.cardId);
    if (!card) return;
    if (quickConnectActive) {
      chooseQuickConnectCard(card);
      return;
    }
    bringCardGroupToFront(card);
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;

    // 点击已处于编辑态的编辑器内部：保持编辑态，不重建 DOM，避免 focusout 闪退
    if (editingCardId === card.id && target.closest('[data-editor]')) return;

    // 附属文本框：单击左端三角尖 → 收起/展开
    if (target.closest('[data-note-toggle]')) {
      mutate(() => { card.noteCollapsed = !card.noteCollapsed; card.updatedAt = now(); });
      return;
    }
    if (target.closest('[data-note-mode]')) {
      mutate(() => {
        card.noteMode = card.noteMode === 'draw' ? 'text' : 'draw';
        card.updatedAt = now();
        if (editingCardId === card.id && editingField === 'body') {
          editingCardId = null;
          editingField = null;
        }
      });
      return;
    }
    // 附属文本框：删除
    if (target.closest('[data-note-remove]')) {
      mutate(() => {
        data.cards = data.cards.filter((c) => c.id !== card.id);
        selectedCardIds.delete(card.id);
        if (editingCardId === card.id) { editingCardId = null; editingField = null; }
      }, t('taskflow.toast.attachedNoteDeleted'));
      return;
    }
    // 附属文本框标题栏：收起时单击标题栏=展开；展开时单击标题栏=编辑标题
    if (target.closest('[data-note-title]') || (target.closest('[data-note-head]') && card.noteCollapsed)) {
      if (card.noteCollapsed) {
        mutate(() => { card.noteCollapsed = false; card.updatedAt = now(); });
      } else {
        if (editingCardId && editingCardId !== card.id) commitEditing(undefined, true);
        editingCardId = card.id;
        editingField = 'title';
        editEnterAt = Date.now();
        selectedCardIds = new Set([card.id]);
        render();
      }
      return;
    }
    // 附属文本框正文编辑
    if (target.closest('[data-note-body]') && card.noteMode !== 'draw') {
      if (action === 'toggle-subtask') {
        const line = Number(target.closest<HTMLInputElement>('[data-line]')?.dataset.line);
        mutate(() => { card.markdown = toggleMarkdownTask(card.markdown, line); card.updatedAt = now(); });
        return;
      }
      // 点击的是已存在的编辑器内部：保持编辑态，不重建
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (editingCardId === card.id) return;
      }
      if (editingCardId && editingCardId !== card.id) commitEditing(undefined, true);
      editingCardId = card.id;
      editingField = 'body';
      editEnterAt = Date.now();
      selectedCardIds = new Set([card.id]);
      editClickPoint = { x: event.clientX, y: event.clientY }; // 记住点击坐标，重建后定位光标
      render();
      return;
    }
    if (action === 'toggle-complete') {
      mutate(() => {
        card.completed = !card.completed;
        card.updatedAt = now();
        if (card.completed && data.pinnedCardId === card.id) data.pinnedCardId = null;
      });
      void window.taskFlowAPI.completeCard(card.id, card.completed);
      return;
    }
    if (action === 'toggle-pin') {
      mutate(() => { data.pinnedCardId = data.pinnedCardId === card.id ? null : card.id; });
      return;
    }
    if (action === 'toggle-subtask') {
      const line = Number(target.closest<HTMLInputElement>('[data-line]')?.dataset.line);
      mutate(() => { card.markdown = toggleMarkdownTask(card.markdown, line); card.updatedAt = now(); });
      return;
    }
    if (action === 'edit-title' || action === 'edit-body') {
      // 点击的是已存在的编辑器（input/textarea）内部：保持编辑态，不重建，避免光标跳转
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (editingCardId === card.id) return;
      }
      if (editingCardId && editingCardId !== card.id) commitEditing(undefined, true);
      if (action === 'edit-title' && isTaskCard(card)) captureTitleEditLayout(card.id, cardElement);
      editingCardId = card.id;
      editingField = action === 'edit-title' ? 'title' : 'body';
      editEnterAt = Date.now();
      selectedCardIds = new Set([card.id]);
      if (action === 'edit-body') editClickPoint = { x: event.clientX, y: event.clientY }; // 记住点击坐标，重建后定位光标
      render();
      return;
    }

    if (event.shiftKey) {
      if (selectedCardIds.has(card.id)) selectedCardIds.delete(card.id);
      else selectedCardIds.add(card.id);
    } else if (!selectedCardIds.has(card.id)) {
      selectedCardIds = new Set([card.id]);
    }
    selectedEdgeId = null;
    render();
  });

  elements.groupHandleLayer.addEventListener('pointerdown', beginGroupDrag);
  elements.groupLayer.addEventListener('contextmenu', (event) => {
    const groupBox = (event.target as HTMLElement).closest<HTMLElement>('[data-group-id]');
    if (!groupBox) return;
    event.preventDefault();
    event.stopPropagation();
    showCanvasGroupContextMenu(event.clientX, event.clientY, groupBox.dataset.groupId!);
  });

  elements.cardLayer.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    beginStandaloneNoteTextSelection(event, target);
    if (event.button === 0 && !editingCardId && !target.closest('textarea, input, button, [data-action="toggle-subtask"]')) {
      const body = target.closest<HTMLElement>('.task-card__body, .task-note__body:not(.is-editing)');
      const cardElement = body?.closest<HTMLElement>('[data-card-id]');
      const card = cardElement ? data.cards.find((item) => item.id === cardElement.dataset.cardId) : undefined;
      if (body && card && !card.noteMode?.includes('draw')) {
        if (editingCardId && editingCardId !== card.id) commitEditing(undefined, true);
        editingCardId = card.id;
        editingField = 'body';
        editClickPoint = { x: event.clientX, y: event.clientY };
        editEnterAt = Date.now();
        selectedCardIds = new Set([card.id]);
        standaloneNoteSelection = null;
        render();
      }
    }
    const cardElement = target.closest<HTMLElement>('[data-card-id]');
    if (quickConnectActive && cardElement && event.button === 0) {
      event.stopPropagation();
      return;
    }
    const drawingCanvas = target.closest<HTMLCanvasElement>('[data-note-canvas]');
    if (drawingCanvas && cardElement && (event.button === 0 || event.button === 2)) {
      const card = data.cards.find((item) => item.id === cardElement.dataset.cardId);
      if (card?.noteMode === 'draw') {
        event.preventDefault();
        event.stopPropagation();
        if (editingCardId && editingCardId !== card.id) commitEditing(undefined, true);
        if (!selectedCardIds.has(card.id)) selectedCardIds = new Set([card.id]);
        history.push(data);
        const erasing = event.button === 2;
        const stroke = erasing ? [] : [drawingPoint(drawingCanvas, event.clientX, event.clientY)];
        drawingState = { cardId: card.id, canvas: drawingCanvas, stroke, erasing };
        drawingCanvas.setPointerCapture(event.pointerId);
        if (erasing) {
          drawingCanvas.classList.add('is-erasing');
          eraseDrawingAt(card, drawingCanvas, drawingPoint(drawingCanvas, event.clientX, event.clientY));
        }
        redrawNoteCanvas(drawingCanvas, card, stroke);
        return;
      }
    }
    // 附属文本框宽度调整（右缘拖拽）
    const resizeHandle = target.closest<HTMLElement>('[data-note-resize]');
    if (resizeHandle && cardElement && event.button === 0) {
      const card = data.cards.find((c) => c.id === cardElement.dataset.cardId);
      const parent = card ? data.cards.find((c) => c.id === card.parentId) : undefined;
      if (card && parent) {
        event.preventDefault();
        noteResize = {
          cardId: card.id,
          axis: 'width',
          startWorld: clientToWorld(event.clientX, event.clientY).x,
          startSize: noteWidth(card),
          minSize: CARD_WIDTH,
          maxSize: CARD_WIDTH * 2,
        };
        document.body.style.userSelect = 'none';
      }
      return;
    }
    const heightResizeHandle = target.closest<HTMLElement>('[data-note-height-resize]');
    if (heightResizeHandle && cardElement && event.button === 0) {
      const card = data.cards.find((c) => c.id === cardElement.dataset.cardId);
      if (card) {
        event.preventDefault();
        noteResize = {
          cardId: card.id,
          axis: 'height',
          startWorld: clientToWorld(event.clientX, event.clientY).y,
          startSize: noteHeight(card, card.parentId ? noteWidth(card) : CARD_WIDTH, card.parentId ? 154 : CARD_WIDTH),
          minSize: 46,
          maxSize: 1200,
        };
        document.body.style.userSelect = 'none';
      }
      return;
    }
    if (!cardElement || event.button !== 0 || !target.closest('[data-drag-handle]') || target.closest('button,input,textarea,[data-action="edit-title"]')) return;
    const cardId = cardElement.dataset.cardId!;
    const draggedCard = data.cards.find((card) => card.id === cardId);
    if (draggedCard) bringCardGroupToFront(draggedCard);
    if (!selectedCardIds.has(cardId)) selectedCardIds = new Set([cardId]);
    const cardIds = [...selectedCardIds];
    const startPositions = new Map(cardIds.map((id) => {
      const card = data.cards.find((item) => item.id === id)!;
      return [id, { x: card.x, y: card.y }];
    }));
    dragState = {
      cardIds,
      startClient: { x: event.clientX, y: event.clientY },
      startPointer: clientToWorld(event.clientX, event.clientY),
      startPositions,
      moved: false,
    };
    // 便签标题同时承担“点击编辑”和“拖动”两种操作。按下时保留默认 click，
    // 只有真正越过拖动阈值后才阻止浏览器默认行为。
    if (!target.closest('[data-note-title]')) event.preventDefault();
  });

  window.addEventListener('pointermove', (event) => {
    extendStandaloneNoteTextSelection(event);
    if (drawingState) {
      const pressedMask = drawingState.erasing ? 2 : 1;
      if ((event.buttons & pressedMask) === 0) {
        finishDrawing();
      } else {
        const card = data.cards.find((item) => item.id === drawingState!.cardId);
        if (card) {
          const point = drawingPoint(drawingState.canvas, event.clientX, event.clientY);
          if (drawingState.erasing) eraseDrawingAt(card, drawingState.canvas, point);
          else drawingState.stroke.push(point);
          redrawNoteCanvas(drawingState.canvas, card, drawingState.stroke);
        }
      }
      return;
    }
    if (noteResize) {
      const resize = noteResize;
      const card = data.cards.find((c) => c.id === resize.cardId);
      if (card) {
        const pointer = clientToWorld(event.clientX, event.clientY);
        const axisPosition = resize.axis === 'width' ? pointer.x : pointer.y;
        const raw = resize.startSize + (axisPosition - resize.startWorld);
        const size = Math.round(Math.max(resize.minSize, Math.min(resize.maxSize, raw)));
        if (resize.axis === 'width') card.noteWidth = size;
        else card.noteHeight = size;
        const el = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${resize.cardId}"]`);
        if (el) {
          if (resize.axis === 'width') el.style.width = `${card.noteWidth}px`;
          el.style.height = `${noteHeight(card, card.parentId ? noteWidth(card) : CARD_WIDTH, card.parentId ? 154 : CARD_WIDTH)}px`;
        }
        if (resize.axis === 'height') layoutNoteCards();
      }
      return;
    }
    if (marqueeState) {
      marqueeState.current = clientToWorld(event.clientX, event.clientY);
      const left = Math.min(marqueeState.start.x, marqueeState.current.x);
      const top = Math.min(marqueeState.start.y, marqueeState.current.y);
      const right = Math.max(marqueeState.start.x, marqueeState.current.x);
      const bottom = Math.max(marqueeState.start.y, marqueeState.current.y);
      elements.selectionMarquee.style.left = `${left}px`;
      elements.selectionMarquee.style.top = `${top}px`;
      elements.selectionMarquee.style.width = `${right - left}px`;
      elements.selectionMarquee.style.height = `${bottom - top}px`;
      selectedCardIds = new Set(activeCards().filter((card) => {
        const cardRight = card.x + CARD_WIDTH;
        const cardBottom = card.y + cardHeight(card);
        return card.x < right && cardRight > left && card.y < bottom && cardBottom > top;
      }).map((card) => card.id));
      // 用 render() 保证说明框位置同帧修正，避免拖选时闪动
      render();
      return;
    }
    if (!dragState) return;
    const clientDistance = Math.hypot(
      event.clientX - dragState.startClient.x,
      event.clientY - dragState.startClient.y,
    );
    if (!dragState.moved && clientDistance < 5) return;
    if (!dragState.moved) {
      dragState.moved = true;
      dragState.cardIds.forEach((id) => elements.cardLayer.querySelector(`[data-card-id="${id}"]`)?.classList.add('is-dragging'));
    }
    event.preventDefault();
    const point = clientToWorld(event.clientX, event.clientY);
    const dx = point.x - dragState.startPointer.x;
    const dy = point.y - dragState.startPointer.y;
    if (draggedGroupId) {
      elements.groupLayer.querySelector<HTMLElement>(`[data-group-box="${draggedGroupId}"]`)?.style.setProperty('transform', `translate(${dx}px, ${dy}px)`);
      elements.groupHandleLayer.querySelector<HTMLElement>(`[data-group-drag-handle="${draggedGroupId}"]`)?.style.setProperty('transform', `translate(${dx}px, ${dy}px)`);
    }
    for (const id of dragState.cardIds) {
      const card = data.cards.find((item) => item.id === id);
      const start = dragState.startPositions.get(id);
      if (!card || !start) continue;
      card.x = start.x + dx;
      card.y = start.y + dy;
      const element = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
      if (element) { element.style.left = `${card.x}px`; element.style.top = `${card.y}px`; }
    }
    // 附属文本框跟随父卡片一起移动：每个父卡片的全部说明框，按实际高度从上到下依次排布
    for (const id of dragState.cardIds) {
      const card = data.cards.find((item) => item.id === id);
      if (!card) continue;
      const parentEl = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
      const parentBottom = parentEl ? parentEl.offsetTop + parentEl.offsetHeight : card.y + cardHeight(card);
      const notes = data.cards.filter((c) => c.parentId === id);
      let cursorY = parentBottom + 10;
      for (const note of notes) {
        const noteEl = elements.cardLayer.querySelector<HTMLElement>(`[data-card-id="${note.id}"]`);
        if (!noteEl) continue;
        noteEl.style.left = `${card.x}px`;
        noteEl.style.top = `${cursorY}px`;
        cursorY += noteEl.offsetHeight + 8;
      }
    }
    const draggedStandaloneNote = dragState.cardIds.length === 1
      ? data.cards.find((card) => card.id === dragState!.cardIds[0] && isStandaloneNote(card))
      : undefined;
    const attachTarget = draggedStandaloneNote
      ? taskCardAtClientPoint(event.clientX, event.clientY, new Set(dragState.cardIds))
      : undefined;
    setNoteAttachTarget(attachTarget?.id ?? null);
    const insertionCard = dragState.cardIds.length === 1
      ? data.cards.find((card) => card.id === dragState!.cardIds[0])
      : undefined;
    const canInsert = insertionCard
      && isTaskCard(insertionCard)
      && !activeEdges().some((edge) => edge.sourceId === insertionCard.id || edge.targetId === insertionCard.id);
    const insertionEdge = canInsert
      ? edgeAtClientPoint(event.clientX, event.clientY) ?? edgeAtWorldPoint(point)
      : undefined;
    setDragInsertionPreview(insertionEdge ? insertionCard!.id : null);
    renderEdges();
  });

  window.addEventListener('pointerup', (event) => {
    endStandaloneNoteTextSelection(event);
    if (finishDrawing()) return;
    if (noteResize) {
      const resize = noteResize;
      const card = data.cards.find((c) => c.id === resize.cardId);
      noteResize = null;
      document.body.style.userSelect = '';
      if (card) { card.updatedAt = now(); render(); scheduleSave(); }
      return;
    }
    if (marqueeState) {
      marqueeState = null;
      elements.selectionMarquee.hidden = true;
      render();
      return;
    }
    if (!dragState) return;
    const moved = dragState.moved;
    const original = dragState.startPositions;
    const changedCards = dragState.cardIds.map((id) => data.cards.find((card) => card.id === id)).filter(Boolean) as TaskCard[];
    const attachTargetId = changedCards.length === 1 && isStandaloneNote(changedCards[0]) ? noteAttachTargetId : null;
    const existingGroupIds = new Set(changedCards.map((card) => card.groupId).filter((id): id is string => Boolean(id)));
    const dropGroupId = changedCards.some((card) => !card.parentId)
      ? groupAtClientPoint(event.clientX, event.clientY, existingGroupIds.size === 1 ? [...existingGroupIds][0] : null)
      : null;
    setDragInsertionPreview(null);
    setNoteAttachTarget(null);
    dragState = null;
    draggedGroupId = null;
    if (moved) {
      suppressDraggedCardClick = true;
      window.setTimeout(() => { suppressDraggedCardClick = false; }, 0);
      const droppedCard = changedCards.length === 1 && isTaskCard(changedCards[0])
        && !activeEdges().some((edge) => edge.sourceId === changedCards[0].id || edge.targetId === changedCards[0].id)
        ? changedCards[0]
        : undefined;
      const insertEdge = droppedCard
        ? edgeAtClientPoint(event.clientX, event.clientY) ?? edgeAtWorldPoint(clientToWorld(event.clientX, event.clientY))
        : undefined;
      const currentPositions = changedCards.map((card) => ({ id: card.id, x: card.x, y: card.y }));
      for (const card of changedCards) {
        const start = original.get(card.id)!;
        card.x = start.x;
        card.y = start.y;
      }
      mutate(() => {
        for (const position of currentPositions) {
          const card = data.cards.find((item) => item.id === position.id)!;
          card.x = position.x;
          card.y = position.y;
          card.updatedAt = now();
        }
        if (droppedCard && insertEdge) {
          const card = data.cards.find((item) => item.id === droppedCard.id)!;
          insertCardIntoEdge(card, insertEdge);
        }
        if (attachTargetId && changedCards.length === 1) {
          const note = data.cards.find((item) => item.id === changedCards[0].id);
          const parent = data.cards.find((item) => item.id === attachTargetId);
          if (note && parent && isStandaloneNote(note) && isTaskCard(parent)) {
            note.parentId = parent.id;
            note.x = parent.x;
            note.y = noteParentY(parent);
            note.noteWidth = CARD_WIDTH;
            note.noteCollapsed = false;
            note.updatedAt = now();
          }
        }
        if (dropGroupId) {
          for (const card of changedCards) {
            if (!card.parentId) { card.groupId = dropGroupId; card.updatedAt = now(); }
          }
        }
      }, attachTargetId ? t('taskflow.toast.noteAttached') : dropGroupId ? t('taskflow.toast.joinedGroup') : undefined);
    }
  });

  window.addEventListener('pointercancel', (event) => {
    endStandaloneNoteTextSelection(event);
    finishDrawing();
    setDragInsertionPreview(null);
    setNoteAttachTarget(null);
    draggedGroupId = null;
  });

  elements.cardLayer.addEventListener('contextmenu', (event) => {
    if ((event.target as HTMLElement).closest('[data-note-canvas]')) event.preventDefault();
  });

  elements.cardLayer.addEventListener('keydown', (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (!target.matches('[data-editor]')) return;
    if (event.key === 'Escape') {
      editingCardId = null;
      editingField = null;
      render();
    } else if (event.key === 'Enter') {
      if (editingField === 'title') {
        // 标题是单行输入：Enter 与 Shift+Enter 均提交标题并直接转入正文，
        // 不受“回车 / Shift+回车互换”设置影响。
        event.preventDefault();
        const cardEl = target.closest<HTMLElement>('[data-card-id]');
        const id = cardEl?.dataset.cardId;
        commitEditing(cardEl ?? undefined);
        if (id) {
          editingCardId = id;
          editingField = 'body';
          editEnterAt = Date.now();
          render();
        }
        return;
      }
      const commitVariant = taskFlowPreferences.enterSwap ? event.shiftKey : !event.shiftKey;
      const newlineVariant = taskFlowPreferences.enterSwap ? !event.shiftKey : event.shiftKey;
      if (commitVariant) {
        const cardEl = target.closest<HTMLElement>('[data-card-id]');
        const id = cardEl?.dataset.cardId;
        const card = data.cards.find((c) => c.id === id);
        const isNote = card ? isNoteCard(card) : false;
        if (editingField === 'body') {
          if (isNote) {
            // 说明框正文：新建同级说明框
            event.preventDefault();
            commitEditing(cardEl ?? undefined);
            if (card?.parentId) createNoteCard(card.parentId);
            else if (id) selectedCardIds = new Set([id]);
          } else {
            // 主卡片正文：退出编辑态，选中该卡片
            event.preventDefault();
            commitEditing(cardEl ?? undefined);
            if (id) selectedCardIds = new Set([id]);
          }
        }
      } else if (newlineVariant && target instanceof HTMLTextAreaElement) {
        // 勾选框行换行：下一行行首自动补 `- [ ] `（保留行首缩进）
        const value = target.value;
        const caret = target.selectionStart ?? 0;
        const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
        const line = value.slice(lineStart, caret);
        const checkbox = line.match(/^(\s*)- \[[ xX]\]/);
        const unorderedList = line.match(/^(\s*)([-*+])\s+/);
        const orderedList = line.match(/^(\s*)(\d+)([.)])\s+/);
        const continuation = checkbox
          ? `${checkbox[1]}- [ ] `
          : unorderedList
            ? `${unorderedList[1]}${unorderedList[2]} `
            : orderedList
              ? `${orderedList[1]}${Number(orderedList[2]) + 1}${orderedList[3]} `
              : null;
        if (continuation) {
          event.preventDefault();
          target.setRangeText(`\n${continuation}`, caret, caret, 'end');
          autoSizeTextarea(target);
          layoutNoteCards();
        }
      }
    }
    // 非勾选框行的换行不拦截，走浏览器默认行为
  });

  // 正文 textarea 内容变化时，动态调整高度，保持与阅读态一致、无抖动
  elements.cardLayer.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement && target.matches('[data-editor="body"]')) {
      // 先保存滚动位置：autoSize/高度更新/重排都可能把滚动条顶回顶部
      const cardEl = target.closest<HTMLElement>('[data-card-id]');
      const noteBody = cardEl?.querySelector<HTMLElement>('.task-note__body');
      const prevTop = noteBody ? noteBody.scrollTop : 0;
      autoSizeTextarea(target);
      // 说明框编辑时：高度随内容实时更新（clamp 154~308），超长靠内部滚动；不再等到退出编辑才变长。
      // 必须用 textarea 实时值计算行数——card.markdown 在编辑期间是旧值，会导致高度偏小、滚动条被钳回顶部。
      const card = cardEl ? data.cards.find((c) => c.id === cardEl.dataset.cardId) : undefined;
      if (card && card.parentId && cardEl && card.noteHeight === undefined) {
        const lineCount = Math.max(1, target.value.split('\n').length);
        const contentHeight = Math.max(154, lineCount * 24 + 28);
        cardEl.style.height = `${Math.min(contentHeight, 308)}px`;
      }
      layoutNoteCards(); // 内容变化改变高度，重新定位说明框
      if (noteBody) noteBody.scrollTop = prevTop; // 恢复滚动位置
    }
  });

  // 用户主动滚动说明框时清除待恢复位置（程序恢复由 restoringNoteScroll 区分，不受影响）
  elements.cardLayer.addEventListener('scroll', (event) => {
    if (restoringNoteScroll) return;
    if (event.target instanceof HTMLElement && event.target.classList.contains('task-note__body')) {
      pendingNoteScrollTop = null;
    }
  });

  elements.cardLayer.addEventListener('focusout', (event) => {
    const related = event.relatedTarget as Node | null;
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
    // 进入编辑后的短暂时间窗内忽略失焦，避免"按下进入输入、松开立即退出"的闪退
    if (Date.now() - editEnterAt < 150) return;
    // 焦点移到了另一个编辑元素（input/textarea）时，视为编辑态内部切换，不退出
    if (related && (related instanceof HTMLInputElement || related instanceof HTMLTextAreaElement)) return;
    // skipRender：失焦提交时不立即重建，避免点击另一张卡片时目标被移除导致切换失败；
    // 后续 click 的 render 或点击空白的 render 会负责界面更新
    if (card && (!related || !card.contains(related))) commitEditing(card, true);
  });
}

function shortcutMatches(event: KeyboardEvent, configured: string | null): boolean {
  if (!configured) return false;
  const parts = configured.toLowerCase().split('+');
  const key = parts.pop()!;
  const requiresCtrl = parts.includes('ctrl');
  const requiresAlt = parts.includes('alt');
  const requiresShift = parts.includes('shift');
  if ((event.ctrlKey || event.metaKey) !== requiresCtrl || event.altKey !== requiresAlt || event.shiftKey !== requiresShift) return false;
  const eventKey = event.key === ' ' ? 'space' : event.key.toLowerCase();
  return eventKey === key || (key === ',' && event.key === ',');
}

function applyTheme(theme: AppSettings['taskFlowTheme']): void {
  const root = document.documentElement.style;
  root.setProperty('--tf-coral', theme.coral);
  root.setProperty('--tf-coral-hover', theme.coral);
  root.setProperty('--tf-coral-pressed', theme.coral);
  root.setProperty('--tf-leaf', theme.leaf);
  root.setProperty('--tf-leaf-dark', theme.leaf);
  root.setProperty('--tf-amber', theme.amber);
  root.setProperty('--tf-ink', theme.ink);
  root.setProperty('--tf-sand', theme.sand);
  root.setProperty('--tf-paper', theme.paper);
  root.setProperty('--tf-complete', theme.complete);
}

function beginSelectedCardEditing(): void {
  if (selectedCardIds.size !== 1) return;
  const id = [...selectedCardIds][0];
  const card = data.cards.find((item) => item.id === id);
  if (!card) return;
  editingCardId = card.id;
  editingField = 'body';
  editEnterAt = Date.now();
  render();
}

function wireKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.archiveDialog.hidden) {
      event.preventDefault();
      closeArchiveDialog();
      return;
    }
    const editing = (event.target as HTMLElement).matches('input,textarea');
    if (!editing && event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      const project = visibleSidebarProjects()[Number(event.key) - 1];
      if (project) {
        event.preventDefault();
        setActiveProject(project.id);
      }
      return;
    }
    // Ctrl+方向键：沿连接线在卡片间前后切换（编辑态也生效，navigateFlow 会先提交当前编辑）
    if (event.ctrlKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      navigateFlow(event.key);
      return;
    }
    if (event.code === 'KeyC' && !event.repeat && !editing && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      enterQuickConnectMode();
      return;
    }
    if (editing) {
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        const cardElement = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
        const cardId = cardElement?.dataset.cardId;
        commitEditing(cardElement ?? undefined, true);
        if (cardId) selectedCardIds = new Set([cardId]);
        createFollowingCard(false);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (quickConnectActive) {
        event.preventDefault();
        exitQuickConnectMode();
        return;
      }
      exitPlacementMode();
      connectionState = null;
      clearConnectionSnap();
      renderEdges();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowAddCard)) {
      event.preventDefault();
      enterPlacementMode();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowAddNote)) {
      event.preventDefault();
      enterPlacementMode('note');
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowPlaceTask)) {
      event.preventDefault();
      enterPlacementMode('task');
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowDetachCard)) {
      event.preventDefault();
      detachSelectedCardFromFlow();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowUndo)) {
      event.preventDefault();
      undo();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowRedo)) {
      event.preventDefault();
      redo();
    } else if (event.key === 'Delete') {
      if (selectedEdgeId || selectedCardIds.size > 0) {
        deleteSelection();
      } else if (data.activeProjectId) {
        archiveProject(data.activeProjectId);
      }
    } else if (event.code === 'Space' && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      beginSelectedCardEditing();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowToggleSidebar)) {
      toggleSidebar();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowNewProject)) {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>('#new-project')!.click();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.openSettings)) {
      event.preventDefault();
      window.settingsAPI.open();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowToggleNPanel)) {
      event.preventDefault();
      toggleNPanel();
    } else if (event.ctrlKey && event.shiftKey && event.code === 'KeyG' && selectedCardIds.size > 0) {
      event.preventDefault();
      removeSelectedCardsFromGroups();
    } else if (shortcutMatches(event, taskFlowPreferences.shortcuts.taskflowGroup) && selectedCardIds.size > 0) {
      event.preventDefault();
      // Ctrl+G：给选中的非子卡片创建群组。
      // 只选中了附属文本框/说明框时不应建组：空组没有位置信息，画布无法渲染其外框，
      // 右键菜单也随之失效（见 renderGroupBoxes 注释）。历史 bug 已产生过这类幽灵组，
      // 由 mutate() 统一清理。
      const groupable = [...selectedCardIds].filter((id) => {
        const card = data.cards.find((c) => c.id === id);
        return card && !card.parentId;
      });
      if (!groupable.length) {
        showToast(t('taskflow.toast.groupRequiresCards'));
        return;
      }
      const groupId = createId('group');
      mutate(() => {
        for (const id of groupable) {
          const card = data.cards.find((c) => c.id === id);
          if (card) card.groupId = groupId;
        }
        // 保留 color 字段兼容旧数据；群组视觉统一使用当前主题黄。
        data.groups.push({ id: groupId, color: '#FFC454' });
      });
    } else if (event.key === 'F2' && selectedCardIds.size === 1) {
      event.preventDefault();
      const id = [...selectedCardIds][0];
      const card = data.cards.find((c) => c.id === id);
      if (card && !card.parentId) {
        editingCardId = card.id;
        editingField = 'title';
        render();
      }
    } else if (event.key === 'Enter' && selectedCardIds.size === 1) {
      event.preventDefault();
      const id = [...selectedCardIds][0];
      const card = data.cards.find((c) => c.id === id);
      // 选中普通卡片且非编辑态：生成附属文本框
      if (card && isTaskCard(card)) createNoteCard(card.id);
      else createFollowingCard(true);
    } else if (event.key === 'Tab' && selectedCardIds.size === 1) {
      event.preventDefault();
      createFollowingCard(false);
    }
  });

  window.addEventListener('keyup', (event) => {
    if (event.code === 'KeyC') exitQuickConnectMode();
  });

  window.addEventListener('blur', () => exitQuickConnectMode());
}

async function start(): Promise<void> {
  data = await window.taskFlowAPI.load();
  if (pruneEmptyGroups()) scheduleSave(); // 一次性清理历史遗留的空群组（幽灵组）
  const expandedLegacyCards = expandLegacyCollapsedTaskCards();
  const restoredInitialViewport = restoreProjectTransform(data.activeProjectId);
  const initialSettings = await window.settingsAPI.load();
  setLocale(initialSettings.language);
  applyLocaleToDocument();
  applyTheme(initialSettings.taskFlowTheme);
  taskFlowPreferences = getTaskFlowPreferences(initialSettings);
  wireToolbar();
  wireCanvas();
  wireKeyboard();
  window.taskFlowAPI.onFocusCard(focusCard);
  window.taskFlowAPI.onSettingsUpdated((next) => {
    const languageChanged = next.language !== getLocale();
    taskFlowPreferences = getTaskFlowPreferences(next);
    spacePressed = spaceKeyDown && shiftKeyDown;
    applyTheme(next.taskFlowTheme);
    if (languageChanged) {
      setLocale(next.language);
      applyLocaleToDocument();
      render();
      renderArchiveList();
    }
  });
  window.taskFlowAPI.onDataReloaded(() => {
    void window.taskFlowAPI.load().then((next) => {
      data = next;
      if (pruneEmptyGroups()) scheduleSave();
      const expandedLegacyCards = expandLegacyCollapsedTaskCards();
      const restoredViewport = restoreProjectTransform(data.activeProjectId);
      selectedCardIds.clear();
      selectedEdgeId = null;
      editingCardId = null;
      editingField = null;
      exitQuickConnectMode(false);
      render();
      if (expandedLegacyCards) scheduleSave();
      if (!restoredViewport) requestAnimationFrame(fitView);
    });
  });
  toggleNPanel(true); // N 面板默认展开
  render();
  if (expandedLegacyCards) scheduleSave();
  if (!restoredInitialViewport) requestAnimationFrame(fitView);
}

void start();
