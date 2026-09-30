import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  isSplatSource,
  axisToZUp,
  isGeoreferenced,
  GEOREF_THRESHOLD,
  defaultPlacement,
  computeSplatTransform,
  splatSceneBox,
  type SplatPlacement,
} from './splatPlacement';

const box = (min: [number, number, number], max: [number, number, number]) =>
  new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

/** computeSplatTransform の結果でファイル座標の点をシーン座標へ写す */
function apply(t: ReturnType<typeof computeSplatTransform>, p: THREE.Vector3): THREE.Vector3 {
  return p.clone().multiply(t.scale).applyQuaternion(t.quaternion).add(t.position);
}

function expectVec(v: THREE.Vector3, x: number, y: number, z: number) {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
}

// Issue #12: 読み込み元を 3DGS と点群に振り分ける
describe('isSplatSource', () => {
  it('3DGS の各拡張子を true と判定する', () => {
    for (const n of ['a.ply', 'a.spz', 'a.splat', 'a.ksplat', 'a.sog']) expect(isSplatSource(n)).toBe(true);
  });

  it('大文字の拡張子も判定する', () => {
    expect(isSplatSource('SCENE.PLY')).toBe(true);
    expect(isSplatSource('Scene.Spz')).toBe(true);
  });

  it('URL のクエリ・フラグメントを除いて判定する', () => {
    expect(isSplatSource('https://example.com/data/scene.spz?token=abc')).toBe(true);
    expect(isSplatSource('https://example.com/data/scene.ply#v1')).toBe(true);
    expect(isSplatSource('https://example.com/data/scene.laz?x=a.ply')).toBe(false);
  });

  it('点群ファイルは false と判定する', () => {
    for (const n of ['a.las', 'a.laz', 'a.copc.laz', 'https://example.com/a.copc.laz']) expect(isSplatSource(n)).toBe(false);
  });

  it('拡張子なし・似た名前は false', () => {
    expect(isSplatSource('ply')).toBe(false);
    expect(isSplatSource('a.plyx')).toBe(false);
  });
});

// ファイル内の「上」方向がシーンの +Z に写ること
describe('axisToZUp', () => {
  it('z-up は回転しない', () => {
    expectVec(new THREE.Vector3(0, 0, 1).applyQuaternion(axisToZUp('z-up')), 0, 0, 1);
  });

  it('y-up は +Y を +Z へ写す', () => {
    expectVec(new THREE.Vector3(0, 1, 0).applyQuaternion(axisToZUp('y-up')), 0, 0, 1);
  });

  it('y-down（OpenCV/COLMAP系）は -Y を +Z へ写す', () => {
    expectVec(new THREE.Vector3(0, -1, 0).applyQuaternion(axisToZUp('y-down')), 0, 0, 1);
  });

  it('X 軸（東）はどの軸指定でも変わらない', () => {
    for (const a of ['z-up', 'y-up', 'y-down'] as const) {
      expectVec(new THREE.Vector3(1, 0, 0).applyQuaternion(axisToZUp(a)), 1, 0, 0);
    }
  });
});

describe('isGeoreferenced', () => {
  it('範囲の中心が水平方向にしきい値以上離れていれば実座標とみなす', () => {
    expect(isGeoreferenced(box([-30002, 39998, 50], [-29998, 40002, 55]))).toBe(true);
    expect(isGeoreferenced(box([GEOREF_THRESHOLD - 1, 0, 0], [GEOREF_THRESHOLD + 1, 1, 1]))).toBe(true);
  });

  it('しきい値未満はローカル座標とみなす', () => {
    expect(isGeoreferenced(box([-5, -5, -2], [5, 5, 2]))).toBe(false);
    expect(isGeoreferenced(box([GEOREF_THRESHOLD - 3, 0, 0], [GEOREF_THRESHOLD - 1, 1, 1]))).toBe(false);
  });

  it('高さ方向だけが大きくても実座標とはみなさない', () => {
    expect(isGeoreferenced(box([-1, -1, 20000], [1, 1, 20010]))).toBe(false);
  });

  it('負の座標でも絶対値で判定する', () => {
    expect(isGeoreferenced(box([-1, -50001, 0], [1, -49999, 1]))).toBe(true);
  });
});

describe('defaultPlacement', () => {
  it('実座標データは world モード（z-up、倍率1、方位0）', () => {
    const p = defaultPlacement(box([-30002, 39998, 50], [-29998, 40002, 55]), new THREE.Box3(), null);
    expect(p.mode).toBe('world');
    expect(p.axis).toBe('z-up');
    expect(p.scale).toBe(1);
    expect(p.headingDeg).toBe(0);
  });

  it('ローカルデータで既存 bounds があれば、その底面中心（実座標）に置く', () => {
    const scene = box([0, 0, 0], [100, 200, 10]); // シーン座標
    const p = defaultPlacement(box([-1, -1, -1], [1, 1, 1]), scene, [-30000, 40000, 50]);
    expect(p.mode).toBe('local');
    expect(p.axis).toBe('y-down');
    expect(p.scale).toBe(1);
    expect(p.headingDeg).toBe(0);
    expect([p.x, p.y, p.z]).toEqual([-30000 + 50, 40000 + 100, 50]);
  });

  it('ローカルデータで bounds が空なら実座標 (0,0,0) に置く', () => {
    const p = defaultPlacement(box([-1, -1, -1], [1, 1, 1]), new THREE.Box3(), null);
    expect(p.mode).toBe('local');
    expect([p.x, p.y, p.z]).toEqual([0, 0, 0]);
  });
});

describe('computeSplatTransform', () => {
  const world: SplatPlacement = { mode: 'world', axis: 'z-up', x: 0, y: 0, z: 0, scale: 1, headingDeg: 0 };

  it('world モード: ファイル座標 - origin がシーン座標になる', () => {
    const origin: [number, number, number] = [-30002, 39998, 50];
    const t = computeSplatTransform(world, box([-30002, 39998, 50], [-29998, 40002, 55]), origin);
    expectVec(t.position, 30002, -39998, -50);
    expectVec(apply(t, new THREE.Vector3(-30000, 40000, 53)), 2, 2, 3);
  });

  it('world モードでは軸・倍率・方位角の指定を無視する', () => {
    const t = computeSplatTransform({ ...world, axis: 'y-down', scale: 3, headingDeg: 45 }, box([0, 0, 0], [1, 1, 1]), [10, 20, 30]);
    expectVec(apply(t, new THREE.Vector3(11, 22, 33)), 1, 2, 3);
  });

  it('local モード（z-up）: 底面中心が指定実座標に来る', () => {
    const local: SplatPlacement = { mode: 'local', axis: 'z-up', x: 105, y: 210, z: 35, scale: 1, headingDeg: 0 };
    const t = computeSplatTransform(local, box([-2, -4, 1], [2, 4, 5]), [100, 200, 30]);
    // 底面中心 (0,0,1) → 実座標 (105,210,35) → シーン (5,10,5)
    expectVec(apply(t, new THREE.Vector3(0, 0, 1)), 5, 10, 5);
    expectVec(apply(t, new THREE.Vector3(2, 4, 5)), 7, 14, 9);
  });

  it('local モード（y-down）: 軸変換後の底面中心を基準にする', () => {
    const local: SplatPlacement = { mode: 'local', axis: 'y-down', x: 0, y: 0, z: 0, scale: 1, headingDeg: 0 };
    // y-down では -Y が上。Y の最大値側が底面になる
    const t = computeSplatTransform(local, box([-1, -3, -1], [1, 5, 1]), [0, 0, 0]);
    expectVec(apply(t, new THREE.Vector3(0, 5, 0)), 0, 0, 0); // 底面中心
    expectVec(apply(t, new THREE.Vector3(0, -3, 0)), 0, 0, 8); // 最上部
  });

  it('local モード: 倍率と方位角（反時計回り）を基準点まわりに適用する', () => {
    const local: SplatPlacement = { mode: 'local', axis: 'z-up', x: 0, y: 0, z: 0, scale: 2, headingDeg: 90 };
    const t = computeSplatTransform(local, box([-1, -1, 0], [1, 1, 1]), [0, 0, 0]);
    expectVec(apply(t, new THREE.Vector3(1, 0, 0)), 0, 2, 0); // +X(東) が 90° 回って +Y(北)、2 倍
    expectVec(apply(t, new THREE.Vector3(0, 0, 1)), 0, 0, 2);
    expect(t.scale.x).toBeCloseTo(2);
  });
});

describe('splatSceneBox', () => {
  it('world モードの配置後のシーン座標範囲', () => {
    const local = box([-30002, 39998, 50], [-29998, 40002, 55]);
    const origin: [number, number, number] = [-30002, 39998, 50];
    const b = splatSceneBox(local, computeSplatTransform({ mode: 'world', axis: 'z-up', x: 0, y: 0, z: 0, scale: 1, headingDeg: 0 }, local, origin));
    expectVec(b.min, 0, 0, 0);
    expectVec(b.max, 4, 4, 5);
  });

  it('local モード（y-down、倍率2）の配置後のシーン座標範囲', () => {
    const local = box([-1, -3, -1], [1, 5, 1]);
    const t = computeSplatTransform({ mode: 'local', axis: 'y-down', x: 10, y: 20, z: 0, scale: 2, headingDeg: 0 }, local, [0, 0, 0]);
    const b = splatSceneBox(local, t);
    expectVec(b.min, 8, 18, 0);
    expectVec(b.max, 12, 22, 16);
  });
});
