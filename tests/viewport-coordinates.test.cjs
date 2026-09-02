const assert = require('node:assert/strict');
const test = require('node:test');

const { clientPointToViewport } = require('../dist/shared/viewport-coordinates.js');

test('maps pointer coordinates from a scaled viewport into layout coordinates', () => {
  const rect = { left: 80, top: 50, width: 1200, height: 750 };
  const viewport = { width: 960, height: 600 };

  assert.deepEqual(clientPointToViewport(680, 425, rect, viewport), { x: 480, y: 300 });
  assert.deepEqual(clientPointToViewport(80, 50, rect, viewport), { x: 0, y: 0 });
});

test('keeps pointer coordinates unchanged when visual and layout pixels match', () => {
  const rect = { left: 32, top: 64, width: 800, height: 500 };
  const viewport = { width: 800, height: 500 };

  assert.deepEqual(clientPointToViewport(432, 314, rect, viewport), { x: 400, y: 250 });
});
