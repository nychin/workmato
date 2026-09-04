/**
 * 任务流程管理器跨进程领域类型。
 *
 * 该文件只描述稳定的数据契约，不包含 Electron、DOM 或渲染细节。
 * 后续把 JSON 仓储替换为 SQLite，或把原生画布替换为 React Flow 时，
 * 主进程与渲染进程仍可继续复用这些类型。
 */

export interface TaskProject {
  id: string;
  title: string;
  archived: boolean;
  /** 归档时间，用于归档箱按最近归档排序。 */
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** 置顶时间戳；有值表示置顶，多个置顶按该时间倒序（后置顶优先） */
  pinnedAt?: string | null;
  /** 手动排序序号：越大越靠前（用于任务栏拖动排序） */
  sortOrder?: number;
  /** 该任务画布最后一次离开时的平移与缩放状态。 */
  viewport?: { x: number; y: number; zoom: number };
  /** 任务栏分组；置顶时暂时显示在置顶区，取消置顶后回到该分组。 */
  sidebarGroupId?: string | null;
  /** 左侧任务栏卡片的色彩标签内描边。 */
  colorTag?: string;
}

export interface TaskProjectGroup {
  id: string;
  title: string;
  collapsed: boolean;
  sortOrder: number;
}

export interface TaskCard {
  id: string;
  projectId: string;
  title: string;
  markdown: string;
  x: number;
  y: number;
  collapsed: boolean;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * 附属文本框子卡片关联：指向父卡片 id。
   * 有值时表示该卡片是挂在父卡片下缘的"补充说明框"（独立实体，跟随父卡移动）。
   */
  parentId?: string | null;
  /** 独立说明卡；未设置时保持原有任务卡兼容行为。 */
  cardType?: 'task' | 'note';
  /** 说明卡内容模式：文本或涂鸦。 */
  noteMode?: 'text' | 'draw';
  /** 涂鸦笔迹，使用归一化坐标序列化保存。 */
  drawing?: string;
  /** 附属文本框是否收起（收起时显示为挂在父卡下缘的细条） */
  noteCollapsed?: boolean;
  /** 附属文本框宽度；默认等于父卡宽度，可通过右缘拖动增大到最多两倍，不可缩短 */
  noteWidth?: number;
  /** 说明卡手动调整后的高度；未设置时按内容使用默认自动高度。 */
  noteHeight?: number;
  /** 便签背景颜色；未设置时使用默认淡黄色。 */
  noteColor?: string;
  /** 任务卡片右键设置的内描边色彩标签。 */
  colorTag?: string;
  /** 所属打组的 id（Ctrl+G 创建）；同一组的所有卡片共享一个外围彩色边界框 */
  groupId?: string | null;
}

/** 打组：选中卡片合为一组，外围共用一个彩色边界框 */
export interface TaskGroup {
  id: string;
  color: string;
}

/** 有向连接：sourceId 是前置卡片，targetId 是后续卡片。 */
export interface TaskEdge {
  id: string;
  projectId: string;
  sourceId: string;
  targetId: string;
  createdAt: string;
}

export interface TaskFlowData {
  version: 1;
  projects: TaskProject[];
  projectGroups: TaskProjectGroup[];
  cards: TaskCard[];
  edges: TaskEdge[];
  groups: TaskGroup[];
  pinnedCardId: string | null;
  activeProjectId: string | null;
}

export interface TaskFlowWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface TaskFlowSavePayload {
  data: TaskFlowData;
}

export interface TaskFlowAPI {
  load: () => Promise<TaskFlowData>;
  save: (data: TaskFlowData) => Promise<void>;
  completeCard: (cardId: string, completed: boolean) => Promise<void>;
  closeWindow: () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  toggleHalfScreen: () => Promise<boolean>;
  toggleAlwaysOnTop: () => Promise<boolean>;
  getAlwaysOnTop: () => Promise<boolean>;
}
