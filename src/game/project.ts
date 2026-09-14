/**
 * CPU projection of world positions to screen space.
 *
 * Box selection tests unit positions, not unit meshes: raycasting 500 units
 * costs far more than transforming 500 points, and the positions are already
 * sitting in contiguous typed arrays. This is the transform, kept free of
 * Babylon so it can be exercised with a hand-written matrix.
 *
 * The matrix is column-major with translation in elements 12..14, which is
 * both Babylon's layout and WebGL's.
 */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  /** False when the point is behind the camera or outside the frustum. */
  readonly visible: boolean;
}

const BEHIND: ScreenPoint = { x: 0, y: 0, visible: false };

export function projectPoint(
  viewProjection: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): ScreenPoint {
  const m = viewProjection;
  const cx = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
  const cy = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
  const cw = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);

  // w <= 0 means the point is at or behind the eye; dividing would fold it
  // back onto the screen mirrored, which is how phantom selections happen.
  if (cw <= 1e-6) return BEHIND;

  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (0.5 - ndcY * 0.5) * height,
    visible: true,
  };
}

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Normalise a drag into a rect, whichever corner it started from. */
export function rectFromDrag(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ScreenRect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

export function rectContains(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Area in square pixels, for telling a click from a drag. */
export function rectArea(rect: ScreenRect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}
