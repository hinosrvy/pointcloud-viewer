import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { minDistanceForSize, computeTargetAfterRotate } from './Viewer';

// Issue #5: ホイールズームインを繰り返すと効かなくなる不具合の修正。
// OrbitControls.minDistance をシーンサイズに応じた妥当な下限に設定し、
// 距離0付近での浮動小数点の丸め誤差によるズームインのフリーズを防ぐ。
// 追加調査（デバッグ情報パネルによる実測）: near平面と同じ比率(size/5000)を
// minDistanceに使うと、通常のズーム操作で数回のホイール操作だけで下限に到達してしまい、
// 「ズームインが効かない」と「パン感度が距離に比例して潰れ、右ドラッグ移動が効かない」の
// 両方を引き起こすことを確認した。near平面とは切り離し、実用上まず到達しない程度に
// 小さい比率(size*1e-6)へ変更する。
describe('minDistanceForSize', () => {
  it('小さいサイズでは下限値1e-6を返す', () => {
    expect(minDistanceForSize(1)).toBe(1e-6);
    expect(minDistanceForSize(0)).toBe(1e-6);
  });

  it('サイズに比例した値が下限を上回る場合はその値を返す', () => {
    expect(minDistanceForSize(100)).toBeCloseTo(100 * 1e-6);
    expect(minDistanceForSize(5000)).toBeCloseTo(5000 * 1e-6);
  });
});

// Issue #5 追加調査: クリック位置中心の回転(rotatePivot)終了後、古いtargetとカメラ位置が
// 偶然近づいていると target がカメラ位置とほぼ一致し、以降のズーム・パンが効かなくなる。
describe('computeTargetAfterRotate', () => {
  it('カメラ正面方向にminDistance未満まで古いtargetが近づいていた場合はminDistanceでクランプする', () => {
    const cameraPosition = new THREE.Vector3(0, 0, 0);
    const forward = new THREE.Vector3(0, 1, 0);
    const oldTarget = new THREE.Vector3(0, 0.0001, 0); // カメラのほぼ真上、距離0.0001
    const result = computeTargetAfterRotate(cameraPosition, forward, oldTarget, 0.5);
    expect(result.distanceTo(cameraPosition)).toBeCloseTo(0.5);
  });

  it('古いtargetまでの距離がminDistance以上であればその距離をそのまま使う', () => {
    const cameraPosition = new THREE.Vector3(0, 0, 0);
    const forward = new THREE.Vector3(0, 1, 0);
    const oldTarget = new THREE.Vector3(0, 10, 0); // 距離10
    const result = computeTargetAfterRotate(cameraPosition, forward, oldTarget, 0.5);
    expect(result.distanceTo(cameraPosition)).toBeCloseTo(10);
  });
});
