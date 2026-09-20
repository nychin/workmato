const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONNECTION_HANDLE_OFFSET_Y,
  EDGE_REVERSE_STUB,
  edgeGeometry,
} = require('../dist/shared/taskflow-edge-geometry.js');

const CARD_WIDTH = 286;
const CARD_MIN_HEIGHT = 154;

/** 由连接点还原卡片矩形：out 端点在右边缘，in 端点在左边缘 */
function cardRect(anchor, side, height = CARD_MIN_HEIGHT) {
  return {
    left: side === 'out' ? anchor.x - CARD_WIDTH : anchor.x,
    right: side === 'out' ? anchor.x : anchor.x + CARD_WIDTH,
    top: anchor.y - CONNECTION_HANDLE_OFFSET_Y,
    bottom: anchor.y - CONNECTION_HANDLE_OFFSET_Y + height,
  };
}

function insideRect(point, rect) {
  return point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
}

test('forward connection stays compact and never folds back', () => {
  const source = { x: 0, y: 100 };
  const target = { x: 90, y: 180 };
  const geometry = edgeGeometry(source, target);

  // 近距离正向：控制点各取 0.45 * dx = 40.5，不越过中点
  assert.equal(geometry.path, 'M 0 100 C 40.5 100, 49.5 180, 90 180');
  for (let index = 1; index < geometry.points.length; index += 1) {
    assert.ok(
      geometry.points[index].x >= geometry.points[index - 1].x - 1e-9,
      '正向连接的采样点不应回折',
    );
  }
});

test('reverse connection keeps a visible horizontal stub at both ends', () => {
  const source = { x: 660, y: 400 };
  const target = { x: 330, y: 480 };
  const geometry = edgeGeometry(source, target);

  assert.deepEqual(geometry.points[0], source);
  assert.deepEqual(geometry.points[geometry.points.length - 1], target);

  // 起点先水平向右推出一段
  assert.equal(geometry.points[1].y, source.y);
  assert.equal(geometry.points[1].x, source.x + EDGE_REVERSE_STUB);

  // 终点前由一段水平线接入
  const beforeTarget = geometry.points[geometry.points.length - 2];
  assert.equal(beforeTarget.y, target.y);
  assert.equal(beforeTarget.x, target.x - EDGE_REVERSE_STUB);

  // 两段引出段整体落在卡片之外，线头不会被卡片压住
  const sourceRect = cardRect(source, 'out');
  const targetRect = cardRect(target, 'in');
  for (let step = 0; step <= EDGE_REVERSE_STUB; step += 1) {
    assert.ok(
      !insideRect({ x: source.x + step, y: source.y }, sourceRect),
      '起点引出段不应落在卡片矩形内',
    );
    assert.ok(
      !insideRect({ x: target.x - step, y: target.y }, targetRect),
      '终点引出段不应落在卡片矩形内',
    );
  }
});

test('reverse connection keeps both stubs visible across relative positions', () => {
  const scenarios = [
    { source: { x: 660, y: 400 }, target: { x: 330, y: 400 } },
    { source: { x: 660, y: 400 }, target: { x: 330, y: 520 } },
    { source: { x: 660, y: 400 }, target: { x: 330, y: 280 } },
    { source: { x: 900, y: 200 }, target: { x: 200, y: 700 } },
    { source: { x: 400, y: 400 }, target: { x: 390, y: 420 } },
    { source: { x: 400, y: 400 }, target: { x: 400, y: 600 } },
  ];

  for (const scenario of scenarios) {
    const { source, target } = scenario;
    const geometry = edgeGeometry(source, target);
    const label = JSON.stringify(scenario);

    assert.deepEqual(geometry.points[0], source, label);
    assert.deepEqual(geometry.points[geometry.points.length - 1], target, label);
    assert.deepEqual(geometry.points[1], { x: source.x + EDGE_REVERSE_STUB, y: source.y }, label);
    assert.deepEqual(
      geometry.points[geometry.points.length - 2],
      { x: target.x - EDGE_REVERSE_STUB, y: target.y },
      label,
    );
  }
});

test('reverse connection stays geometrically valid at close range', () => {
  const source = { x: 100, y: 300 };
  const target = { x: 95, y: 340 };
  const geometry = edgeGeometry(source, target);

  assert.ok(!geometry.path.includes('NaN'));
  const numbers = geometry.path.match(/-?\d+(\.\d+)?/g).map(Number);
  assert.ok(numbers.every((value) => Number.isFinite(value)));
  assert.deepEqual(geometry.points[0], source);
  assert.deepEqual(geometry.points[geometry.points.length - 1], target);
});

test('reverse curve folds back behind the cards, which is the accepted trade-off', () => {
  // 这是本方案的已知代价：中段折回并进入卡片矩形，被上层卡片遮住。
  // 把该行为固化下来，避免以后被误当成 bug 而改回绕行方案。
  const source = { x: 660, y: 400 };
  const target = { x: 330, y: 400 };
  const geometry = edgeGeometry(source, target);

  const hidden = geometry.points.some((point) => insideRect(point, cardRect(source, 'out')));
  assert.equal(hidden, true, '反向曲线中段预期会进入卡片矩形（并被卡片遮住）');
});

test('hit-test polyline spans the same endpoints as the drawn path', () => {
  const source = { x: 600, y: 300 };
  const target = { x: 200, y: 520 };
  const geometry = edgeGeometry(source, target);

  assert.ok(geometry.path.startsWith(`M ${source.x} ${source.y}`));
  assert.ok(geometry.path.endsWith(`${target.x} ${target.y}`));
  assert.ok(geometry.points.length >= 12, '曲线段应有足够采样点支撑命中判定');
  assert.deepEqual(geometry.points[0], source);
  assert.deepEqual(geometry.points[geometry.points.length - 1], target);
});
