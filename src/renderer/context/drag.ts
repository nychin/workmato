import type { ContextAPI } from '../../shared/context';

/** 小番茄和速记顶部共用拖拽手势；超过阈值才移动，拖动结束不触发点击动作。 */
export function bindContextDrag(handle: HTMLElement, api: ContextAPI): void {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let moved = false;

  function end(): void {
    handle.classList.remove('pressing', 'dragging');
    if (pointerId === null) return;
    const previous = pointerId;
    pointerId = null;
    api.dragEnd();
    if (handle.hasPointerCapture(previous)) handle.releasePointerCapture(previous);
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    moved = false;
    handle.classList.add('pressing');
    handle.setPointerCapture(pointerId);
    api.dragStart();
  });
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    if (!(event.buttons & 1)) { end(); return; }
    if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
    moved = true;
    handle.classList.add('dragging');
    api.dragMove();
  });
  handle.addEventListener('pointerup', (event) => {
    if (event.pointerId !== pointerId) return;
    if (moved) api.dragMove();
    end();
  });
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
  window.addEventListener('blur', end);
  handle.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') handle.classList.add('pressing');
  });
  handle.addEventListener('keyup', () => handle.classList.remove('pressing'));
  handle.addEventListener('blur', end);
  handle.addEventListener('click', (event) => {
    if (moved && event.detail !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}
