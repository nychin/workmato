/** Cross-process settings contract. Persistence remains in the main process. */

export type RestMode = 'auto' | 'manual';
export type AppLanguage = 'zh-CN' | 'en-US' | 'ja-JP';

export const APP_LANGUAGES: readonly AppLanguage[] = ['zh-CN', 'en-US', 'ja-JP'];

export type SoundEvent = 'focusStart' | 'prolongation' | 'restStart' | 'restEnd' | 'taskComplete';
export type BuiltInSoundAsset = 'focus_start' | 'prolongation' | 'rest_start' | 'rest_end' | 'happy'
  | 'rage' | 'focus_start_02' | 'focus_start_03' | 'prolongation_02';
export type SoundAsset = BuiltInSoundAsset | `custom:${string}` | null;

export type ShortcutAction =
  | 'toggleMainWindow'
  | 'toggleTimer'
  | 'taskflowNewProject'
  | 'taskflowAddCard'
  | 'taskflowUndo'
  | 'taskflowRedo'
  | 'openSettings'
  | 'taskflowToggleSidebar'
  | 'taskflowAddNote'
  | 'taskflowPlaceTask'
  | 'taskflowDetachCard'
  | 'taskflowGroup'
  | 'taskflowToggleNPanel';

export interface TimerSettings {
  focusMinutes: number;
  restMode: RestMode;
  /** Automatic short-rest duration divided by focus duration. */
  autoShortRestRatio: number;
  /** Automatic long-rest duration divided by focus duration. */
  autoLongRestRatio: number;
  includeProlongationInAutoRest: boolean;
  shortRestMinutes: number;
  longRestMinutes: number;
  longRestInterval: number;
}

export interface SoundSettings {
  enabled: boolean;
  /** Integer percentage, from 0 through 100. */
  volume: number;
  events: Record<SoundEvent, SoundAsset>;
}

export interface TaskFlowTheme {
  coral: string;
  leaf: string;
  amber: string;
  ink: string;
  sand: string;
  paper: string;
  complete: string;
}

export interface AppSettings {
  version: 1;
  language: AppLanguage;
  timer: TimerSettings;
  shortcuts: Record<ShortcutAction, string | null>;
  enterSwap: boolean;
  wheelCtrlSwap: boolean;
  /** Tomato panel display scale, from 0.5 through 2. */
  tomatoPanelScale: number;
  launchAtLogin: boolean;
  sound: SoundSettings;
  taskFlowTheme: TaskFlowTheme;
}

export interface TaskFlowPreferences {
  shortcuts: Pick<AppSettings['shortcuts'],
    'taskflowNewProject' | 'taskflowAddCard' | 'taskflowUndo' | 'taskflowRedo' | 'openSettings' | 'taskflowToggleSidebar'
    | 'taskflowAddNote' | 'taskflowPlaceTask' | 'taskflowDetachCard' | 'taskflowGroup' | 'taskflowToggleNPanel'>;
  enterSwap: boolean;
  wheelCtrlSwap: boolean;
}

export interface FocusRecord {
  id: string;
  startedAt: string;
  completedAt: string;
  localDate: string;
  taskCardId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
  focusSeconds: number;
  plannedSeconds: number;
  completed: boolean;
}

export interface PeriodSummary {
  focusSeconds: number;
  pomodoroCount: number;
}

export interface TaskFocusRanking {
  taskTitle: string;
  projectTitle: string | null;
  focusSeconds: number;
  pomodoroCount: number;
}

export interface ProjectFocusRanking {
  id: string;
  projectTitle: string;
  focusSeconds: number;
  pomodoroCount: number;
  tasks: TaskFocusRanking[];
}

export interface StatisticsDashboard {
  day: PeriodSummary;
  week: PeriodSummary;
  month: PeriodSummary;
  rankings: TaskFocusRanking[];
  projectRankings: ProjectFocusRanking[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  language: 'zh-CN',
  timer: {
    focusMinutes: 30,
    restMode: 'auto',
    autoShortRestRatio: 0.2,
    autoLongRestRatio: 0.6,
    includeProlongationInAutoRest: false,
    shortRestMinutes: 5,
    longRestMinutes: 15,
    longRestInterval: 3,
  },
  shortcuts: {
    toggleMainWindow: 'Alt+P',
    toggleTimer: 'Alt+O',
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
  wheelCtrlSwap: true,
  tomatoPanelScale: 1,
  launchAtLogin: false,
  sound: {
    enabled: true,
    volume: 60,
    events: {
      focusStart: 'focus_start',
      prolongation: 'prolongation',
      restStart: 'rest_start',
      restEnd: 'rest_end',
      taskComplete: 'happy',
    },
  },
  taskFlowTheme: {
    coral: '#F15D3E',
    leaf: '#79B64D',
    amber: '#FFC454',
    ink: '#273560',
    sand: '#DBCFBD',
    paper: '#FFFFFF',
    complete: '#CD7078',
  },
};

export function createDefaultSettings(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

export function getTaskFlowPreferences(settings: AppSettings): TaskFlowPreferences {
  const { shortcuts, enterSwap, wheelCtrlSwap } = settings;
  return {
    shortcuts: {
      taskflowNewProject: shortcuts.taskflowNewProject,
      taskflowAddCard: shortcuts.taskflowAddCard,
      taskflowUndo: shortcuts.taskflowUndo,
      taskflowRedo: shortcuts.taskflowRedo,
      openSettings: shortcuts.openSettings,
      taskflowToggleSidebar: shortcuts.taskflowToggleSidebar,
      taskflowAddNote: shortcuts.taskflowAddNote,
      taskflowPlaceTask: shortcuts.taskflowPlaceTask,
      taskflowDetachCard: shortcuts.taskflowDetachCard,
      taskflowGroup: shortcuts.taskflowGroup,
      taskflowToggleNPanel: shortcuts.taskflowToggleNPanel,
    },
    enterSwap,
    wheelCtrlSwap,
  };
}
