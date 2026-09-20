/**
 * 任务流连接线几何。纯计算、无 DOM 依赖，渲染与命中判定共用同一份实现。
 *
 * 正向（目标在右侧）：三次贝塞尔，控制点不越过中点，近距离保持紧凑。
 * 反向（目标在左侧）：两端各留一段可见的水平引出段，中段沿用同一条曲线。
 *
 * 反向曲线天然会折回，折回段落到卡片矩形内就会被上层卡片遮住
 * （.card-layer 的 z-index 高于 .edge-layer，见 taskflow.css）。
 * 这里不额外绕行 —— 绕行需要把曲线改成直角折线，与画布上其它连线的形态不一致；
 * 只保证两端连接点近旁的线头始终露在卡片之外。
 */

export type CanvasPoint = { x: number; y: number };

/** 连接点相对卡片顶部的中轴偏移（与 CSS .connection-handle 的 top:23.1 / height:37.8 保持一致） */
export const CONNECTION_HANDLE_OFFSET_Y = 23.1 + 37.8 / 2;
/** 反向连接：两端保留的可见水平引出段长度 */
export const EDGE_REVERSE_STUB = 30;
/** 反向连接：三次贝塞尔控制距离上限 */
const EDGE_REVERSE_CONTROL_LIMIT = 140;

type EdgeSegment =
  | { kind: 'line'; to: CanvasPoint }
  | { kind: 'cubic'; controlStart: CanvasPoint; controlEnd: CanvasPoint; to: CanvasPoint };

export interface EdgeGeometry {
  /** SVG path 指令 */
  path: string;
  /** 与 path 完全一致的采样折线（世界坐标），供命中判定复用同一份几何 */
  points: CanvasPoint[];
}

function appendCubic(points: CanvasPoint[], start: CanvasPoint, controlStart: CanvasPoint, controlEnd: CanvasPoint, end: CanvasPoint): void {
  const estimate = Math.hypot(controlStart.x - start.x, controlStart.y - start.y)
    + Math.hypot(controlEnd.x - controlStart.x, controlEnd.y - controlStart.y)
    + Math.hypot(end.x - controlEnd.x, end.y - controlEnd.y);
  const steps = Math.min(160, Math.max(4, Math.ceil(estimate / 8)));
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const inverse = 1 - t;
    points.push({
      x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * controlStart.x + 3 * inverse * t ** 2 * controlEnd.x + t ** 3 * end.x,
      y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * controlStart.y + 3 * inverse * t ** 2 * controlEnd.y + t ** 3 * end.y,
    });
  }
}

/** 由段列表同时生成 path 指令与命中采样点，避免渲染与命中各写一套几何而漂移。 */
export function buildEdgeGeometry(start: CanvasPoint, segments: readonly EdgeSegment[]): EdgeGeometry {
  let path = `M ${start.x} ${start.y}`;
  const points: CanvasPoint[] = [start];
  let cursor = start;
  for (const segment of segments) {
    if (segment.kind === 'line') {
      path += ` L ${segment.to.x} ${segment.to.y}`;
      // 直线段由命中判定按线段处理，只记录端点即可
      points.push(segment.to);
    } else {
      path += ` C ${segment.controlStart.x} ${segment.controlStart.y}, ${segment.controlEnd.x} ${segment.controlEnd.y}, ${segment.to.x} ${segment.to.y}`;
      appendCubic(points, cursor, segment.controlStart, segment.controlEnd, segment.to);
    }
    cursor = segment.to;
  }
  return { path, points };
}

/**
 * 生成一条连接线的几何。
 *
 * 正向：单条三次贝塞尔，控制点不越过中点，近距离不会形成回折。
 * 反向：两端各推出一段水平引出段，再用三次贝塞尔连接两侧引出端，
 *   使两个连接点近旁始终有一段线露在卡片之外。
 */
export function edgeGeometry(source: CanvasPoint, target: CanvasPoint): EdgeGeometry {
  const dx = target.x - source.x;

  if (dx > 0) {
    const distance = Math.min(dx * 0.45, 160);
    return buildEdgeGeometry(source, [{
      kind: 'cubic',
      controlStart: { x: source.x + distance, y: source.y },
      controlEnd: { x: target.x - distance, y: target.y },
      to: target,
    }]);
  }

  const stub = EDGE_REVERSE_STUB;
  const from = { x: source.x + stub, y: source.y };
  const to = { x: target.x - stub, y: target.y };
  // 控制距离按两侧引出端之间的总跨度取比例，避免近距离时控制点互相越过造成急折。
  const distance = Math.min((Math.abs(dx) + stub * 2) * 0.45, EDGE_REVERSE_CONTROL_LIMIT);

  return buildEdgeGeometry(source, [
    { kind: 'line', to: from },
    {
      kind: 'cubic',
      controlStart: { x: from.x + distance, y: from.y },
      controlEnd: { x: to.x - distance, y: to.y },
      to,
    },
    { kind: 'line', to: target },
  ]);
}
