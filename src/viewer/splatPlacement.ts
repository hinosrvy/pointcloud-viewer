import * as THREE from 'three';

// ガウシアンスプラット（3DGS）の形式判定と配置計算（Issue #12）。
// Spark に依存させない（単体テストで WASM/WebGL を読み込まないため）。

export const SPLAT_EXTENSIONS = ['.ply', '.spz', '.splat', '.ksplat', '.sog'];

/** ファイル名または URL（クエリ・フラグメントは除く）の拡張子で 3DGS かを判定する */
export function isSplatSource(nameOrUrl: string): boolean {
  const path = nameOrUrl.split(/[?#]/)[0].toLowerCase();
  return SPLAT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** ファイル内の座標軸の向き。Y-down は OpenCV/COLMAP 系（3DGS の学習結果に多い） */
export type SplatAxis = 'z-up' | 'y-up' | 'y-down';

/** ファイル座標 → Z-up（シーン）への回転 */
export function axisToZUp(axis: SplatAxis): THREE.Quaternion {
  const angle = axis === 'y-up' ? Math.PI / 2 : axis === 'y-down' ? -Math.PI / 2 : 0;
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
}

/** ファイル座標の範囲の中心が水平方向にこの距離 [m] 以上離れていれば、実座標で記録されたデータとみなす */
export const GEOREF_THRESHOLD = 10_000;

export function isGeoreferenced(localBox: THREE.Box3): boolean {
  const c = localBox.getCenter(new THREE.Vector3());
  return Math.max(Math.abs(c.x), Math.abs(c.y)) >= GEOREF_THRESHOLD;
}

export interface SplatPlacement {
  /** world: ファイル内の座標を実座標（Z-up）として扱う / local: 位置・倍率・方位角で配置する */
  mode: 'world' | 'local';
  /** world モードでは 'z-up' 固定 */
  axis: SplatAxis;
  /** local モード: 基準点（軸変換後の底面中心）を置く実座標 */
  x: number;
  y: number;
  z: number;
  /** local モードのみ */
  scale: number;
  /** local モードのみ。Z 軸まわり、反時計回り [度] */
  headingDeg: number;
}

/** 読み込み直後の初期配置 */
export function defaultPlacement(localBox: THREE.Box3, sceneBounds: THREE.Box3, origin: [number, number, number] | null): SplatPlacement {
  if (isGeoreferenced(localBox)) return { mode: 'world', axis: 'z-up', x: 0, y: 0, z: 0, scale: 1, headingDeg: 0 };
  let x = 0, y = 0, z = 0;
  if (!sceneBounds.isEmpty()) {
    const o = origin ?? [0, 0, 0];
    const c = sceneBounds.getCenter(new THREE.Vector3());
    [x, y, z] = [c.x + o[0], c.y + o[1], sceneBounds.min.z + o[2]];
  }
  return { mode: 'local', axis: 'y-down', x, y, z, scale: 1, headingDeg: 0 };
}

export interface SplatTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/** SplatMesh に設定する position / quaternion / scale を求める */
export function computeSplatTransform(p: SplatPlacement, localBox: THREE.Box3, origin: [number, number, number]): SplatTransform {
  if (p.mode === 'world') {
    return {
      position: new THREE.Vector3(-origin[0], -origin[1], -origin[2]),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
    };
  }
  // シーン座標 = T(toScene(x,y,z)) · Rz(heading) · S(scale) · Q(axis) · T(-基準点のファイル座標)
  const qAxis = axisToZUp(p.axis);
  const rotated = localBox.clone().applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(qAxis));
  const baseRotated = new THREE.Vector3((rotated.min.x + rotated.max.x) / 2, (rotated.min.y + rotated.max.y) / 2, rotated.min.z);
  const qHeading = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(p.headingDeg));
  // 基準点（軸変換後の座標）を方位回転・倍率した分だけ差し引く
  const baseMoved = baseRotated.applyQuaternion(qHeading).multiplyScalar(p.scale);
  const target = new THREE.Vector3(p.x - origin[0], p.y - origin[1], p.z - origin[2]);
  return {
    position: target.sub(baseMoved),
    quaternion: qHeading.clone().multiply(qAxis),
    scale: new THREE.Vector3(p.scale, p.scale, p.scale),
  };
}

/** 配置後のシーン座標での範囲（bounds 計算用） */
export function splatSceneBox(localBox: THREE.Box3, t: SplatTransform): THREE.Box3 {
  return localBox.clone().applyMatrix4(new THREE.Matrix4().compose(t.position, t.quaternion, t.scale));
}
