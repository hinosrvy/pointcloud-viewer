import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  minDistanceForSize,
  computeTargetAfterRotate,
  dynamicNear,
  computeDoubleClickZoomPosition,
  clampCameraDistance,
  easeOutCubic,
  computeSceneBounds,
} from './Viewer';

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

// Issue #7: near平面(camera.near)がフィット時の値(size/5000)に固定されていると、
// minDistance(size*1e-6)に到達するはるか手前でニアクリップが始まり、範囲の広い点群ほど
// 「ズームインの終盤で点群がすり抜けて消える」不具合が顕著になる。カメラ-target間距離に
// 追従してnearを動的に縮めることで、この200倍のギャップを解消する。
describe('dynamicNear', () => {
  it('距離がmaxNearの100倍以上離れている場合はmaxNear（フィット時のnear）を返す', () => {
    expect(dynamicNear(7952, 7.9283e-3, 1.5857)).toBe(1.5857);
    expect(dynamicNear(158.57, 7.9283e-3, 1.5857)).toBeCloseTo(1.5857);
  });

  it('距離がminNearの100倍未満の場合はminNear（minDistance相当）を返す', () => {
    expect(dynamicNear(7.9283e-3, 7.9283e-3, 1.5857)).toBeCloseTo(7.9283e-3);
    expect(dynamicNear(0, 7.9283e-3, 1.5857)).toBeCloseTo(7.9283e-3);
  });

  it('中間の距離ではdistance/100に追従する', () => {
    expect(dynamicNear(10, 7.9283e-3, 1.5857)).toBeCloseTo(0.1);
  });
});

// Issue #7 追加調査2: zoomSpeed引き下げでも改善しなかったため、PotreeViewer同様に
// ダブルクリックした地点までズームインする操作を追加する。歩幅は現在距離の半分とし、
// minDistance未満には縮めない。
describe('computeDoubleClickZoomPosition', () => {
  it('現在距離の半分の位置までヒット点に近づく', () => {
    const cameraPosition = new THREE.Vector3(0, 0, 10);
    const hitPoint = new THREE.Vector3(0, 0, 0);
    const result = computeDoubleClickZoomPosition(cameraPosition, hitPoint, 0.1);
    expect(result.distanceTo(hitPoint)).toBeCloseTo(5);
    // 元のカメラ位置とヒット点を結ぶ直線上に留まる
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(5);
  });

  it('半分に縮めるとminDistance未満になる場合はminDistanceでクランプする', () => {
    const cameraPosition = new THREE.Vector3(0, 0, 0.1);
    const hitPoint = new THREE.Vector3(0, 0, 0);
    const result = computeDoubleClickZoomPosition(cameraPosition, hitPoint, 0.08);
    expect(result.distanceTo(hitPoint)).toBeCloseTo(0.08);
  });

  it('既にヒット点とほぼ同じ位置の場合はカメラ位置を変更しない', () => {
    const cameraPosition = new THREE.Vector3(1, 2, 3);
    const hitPoint = new THREE.Vector3(1, 2, 3);
    const result = computeDoubleClickZoomPosition(cameraPosition, hitPoint, 0.1);
    expect(result.distanceTo(cameraPosition)).toBeCloseTo(0);
  });
});

// Issue #7 追加調査4: ダブルクリックズームが瞬時にジャンプして視点が把握しづらいとの指摘を受け、
// カメラ位置・targetを短時間で滑らかに補間するアニメーションを追加する。
describe('easeOutCubic', () => {
  it('t=0で0、t=1で1を返す', () => {
    expect(easeOutCubic(0)).toBeCloseTo(0);
    expect(easeOutCubic(1)).toBeCloseTo(1);
  });

  it('t=0.5では減速カーブにより0.5より大きい値を返す', () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });
});

// Issue #7 追加調査3: ホイールズームを繰り返すと、デバッグパネル上でdistanceがminDistanceを
// 大きく下回る（例: 7e-9 < minDistance=7.9e-3）状態になり、以降ズームイン・パン・ダブルクリック
// ズームのいずれも効かなくなる不具合を実機で確認した。zoomToCursor有効時、OrbitControls内部で
// マウスカーソル方向へ直接カメラ位置を移動する経路(_dollyDirection)があり、target方向と
// 完全には一致しないため、理論上はclampされているはずのdistanceが実際には
// minDistance未満に落ち込みうる（詳細は docs/research/7-zoom-in-stuck-wide-scale.md 追加調査3）。
// render()の毎フレームで、OrbitControls.update()後にこの不変条件を強制的に再クランプする。
describe('clampCameraDistance', () => {
  it('距離がminDistance以上ならカメラ位置を変更しない', () => {
    const cameraPosition = new THREE.Vector3(0, 0, 10);
    const target = new THREE.Vector3(0, 0, 0);
    const result = clampCameraDistance(cameraPosition, target, 0.1, new THREE.Vector3(0, 0, 1));
    expect(result.equals(cameraPosition)).toBe(true);
  });

  it('距離がminDistance未満の場合は同じ方向を保ったままminDistanceまで押し戻す', () => {
    const cameraPosition = new THREE.Vector3(0, 0, 0.001);
    const target = new THREE.Vector3(0, 0, 0);
    const result = clampCameraDistance(cameraPosition, target, 0.1, new THREE.Vector3(1, 0, 0));
    expect(result.distanceTo(target)).toBeCloseTo(0.1);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0.1);
  });

  it('カメラ位置とtargetがほぼ一致する縮退ケースではfallbackDirectionを使う', () => {
    const cameraPosition = new THREE.Vector3(5, 5, 5);
    const target = new THREE.Vector3(5, 5, 5);
    const result = clampCameraDistance(cameraPosition, target, 0.1, new THREE.Vector3(0, 1, 0));
    expect(result.distanceTo(target)).toBeCloseTo(0.1);
    expect(result.x).toBeCloseTo(5);
    expect(result.y).toBeCloseTo(5.1);
    expect(result.z).toBeCloseTo(5);
  });
});

// Issue #12: 3DGS レイヤーも fitCamera / near・far / minDistance の基準となる bounds に含める
describe('computeSceneBounds', () => {
  it('LAS レイヤーの実座標範囲を origin 基準のシーン座標に変換して合わせる', () => {
    const b = computeSceneBounds([100, 200, 10], [{ min: [100, 200, 10], max: [110, 220, 15] }], []);
    expect(b.min.toArray()).toEqual([0, 0, 0]);
    expect(b.max.toArray()).toEqual([10, 20, 5]);
  });

  it('3DGS レイヤーのシーン座標範囲も含める', () => {
    const splat = new THREE.Box3(new THREE.Vector3(-5, -5, -1), new THREE.Vector3(1, 1, 30));
    const b = computeSceneBounds([100, 200, 10], [{ min: [100, 200, 10], max: [110, 220, 15] }], [splat]);
    expect(b.min.toArray()).toEqual([-5, -5, -1]);
    expect(b.max.toArray()).toEqual([10, 20, 30]);
  });

  it('3DGS レイヤーのみ（origin 未確定）でも範囲を返す', () => {
    const splat = new THREE.Box3(new THREE.Vector3(-1, -2, 0), new THREE.Vector3(1, 2, 3));
    const b = computeSceneBounds(null, [], [splat]);
    expect(b.min.toArray()).toEqual([-1, -2, 0]);
    expect(b.max.toArray()).toEqual([1, 2, 3]);
  });

  it('レイヤーがなければ空', () => {
    expect(computeSceneBounds(null, [], []).isEmpty()).toBe(true);
  });
});
