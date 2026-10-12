// Vector helpers for 2D world coordinates. Everything here is
// pure: no state, no side effects, tests go in test/geometry.*.

export interface Vec2 { x: number; y: number; }
export interface Point { x: number; y: number; }

export function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function sub(a: Point, b: Point): Vec2 {
    return { x: a.x - b.x, y: a.y - b.y };
}

export function magnitude(v: Vec2): number {
    return Math.hypot(v.x, v.y);
}

/** Scale a vector to a target length. A zero vector stays zero
 *  (any heading is as good as any other, let the server pick). */
export function scaleTo(v: Vec2, length: number): Vec2 {
    const m = magnitude(v);
    if (m === 0) return { x: 0, y: 0 };
    const k = length / m;
    return { x: v.x * k, y: v.y * k };
}

/** Linear interpolation on a scalar. `t` is clamped to [0, 1]. */
export function lerp(a: number, b: number, t: number): number {
    const u = Math.max(0, Math.min(1, t));
    return a + (b - a) * u;
}
