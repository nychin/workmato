export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Maps a browser client point into the viewport's layout coordinate space.
 *
 * `clientX` / `getBoundingClientRect()` use visual pixels, while canvas
 * transforms use layout pixels. They normally match, but can differ when an
 * Electron window is rendered with an OS or page scale factor.
 */
export function clientPointToViewport(
  clientX: number,
  clientY: number,
  rect: ViewportRect,
  viewport: ViewportSize,
): { x: number; y: number } {
  const scaleX = rect.width > 0 && viewport.width > 0 ? viewport.width / rect.width : 1;
  const scaleY = rect.height > 0 && viewport.height > 0 ? viewport.height / rect.height : 1;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}
