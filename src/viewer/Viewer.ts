import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WalkControls } from './WalkControls';
import type { LasHeader, PointBatch } from '../las/format';
import { COLOR_MODE_INDEX, createPointMaterial, createSharedUniforms } from './shaders';
import type { ColorMode, SharedUniforms } from './shaders';
import { SparkRenderer, type SplatMesh } from '@sparkjsdev/spark';
import { computeSplatTransform, defaultPlacement, splatSceneBox, type SplatPlacement } from './splatPlacement';
import type { LoadedSplat } from './splats';

export interface Layer {
  id: number;
  name: string;
  header: LasHeader;
  group: THREE.Group;
  material: THREE.ShaderMaterial;
  pointCount: number;
  visible: boolean;
  is16bitColor: boolean;
  hasRgb: boolean;
}

/** ガウシアンスプラット（3DGS）レイヤー（Issue #12） */
export interface SplatLayer {
  id: number;
  name: string;
  mesh: SplatMesh;
  /** ファイル座標での範囲 */
  localBox: THREE.Box3;
  placement: SplatPlacement;
  splatCount: number;
  visible: boolean;
}

export interface Measurement {
  a: THREE.Vector3;
  b: THREE.Vector3;
  line: THREE.Line;
  label: THREE.Sprite;
  distance: number;
}

/** Issue #5/#7 調査用のカメラ/OrbitControls状態スナップショット */
export interface ViewerDebugInfo {
  cameraPosition: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
  minDistance: number;
  near: number;
  far: number;
  /** 読み込み済み点群全体のバウンディングボックス対角長 */
  sceneSize: number;
  controlsEnabled: boolean;
  rotateCandidate: boolean;
  rotateActive: boolean;
}

/**
 * 全レイヤーのシーン座標での範囲を求める（Issue #12）。
 * LAS は実座標の min/max を origin 基準に変換し、3DGS は配置後のシーン座標範囲をそのまま合わせる。
 */
export function computeSceneBounds(
  origin: [number, number, number] | null,
  lasRanges: { min: [number, number, number]; max: [number, number, number] }[],
  splatBoxes: THREE.Box3[],
): THREE.Box3 {
  const o = origin ?? [0, 0, 0];
  const box = new THREE.Box3();
  for (const r of lasRanges) {
    box.expandByPoint(new THREE.Vector3(r.min[0] - o[0], r.min[1] - o[1], r.min[2] - o[2]));
    box.expandByPoint(new THREE.Vector3(r.max[0] - o[0], r.max[1] - o[1], r.max[2] - o[2]));
  }
  for (const b of splatBoxes) box.union(b);
  return box;
}

/**
 * ホイールズームインの下限距離（OrbitControls.minDistance）を対象サイズから算出する。
 * 距離0に近づくほど1回のズーム操作あたりの絶対移動量が浮動小数点の丸め誤差を下回り、
 * ズームインが反応しなくなる問題（Issue #5）を防ぐための下限。
 */
// near平面（size/5000）とは意図的に切り離す。near相当まで縮めると通常のズーム操作で
// すぐに下限へ到達し、OrbitControlsのパン感度（カメラ-target間距離に比例）も一緒に潰れて
// 「右ドラッグ移動が効かない」体感になることをデバッグ情報パネルで実測確認済み（Issue #5）。
// ここでは浮動小数点精度崩壊（size比で1e-15程度）に対して十分余裕を持たせつつ、
// 実用上のズーム操作では到達しない程度に小さい値とする。
export function minDistanceForSize(size: number): number {
  return Math.max(1e-6, size * 1e-6);
}

/**
 * クリック位置中心の回転終了後に OrbitControls.target を置き直す先を計算する。
 * 回転前の旧targetまでの距離が minDistance 未満だと、target がカメラ位置とほぼ一致して
 * 以降のズーム・パンが反応しなくなるため（Issue #5）、minDistanceを下限としてクランプする。
 */
export function computeTargetAfterRotate(
  cameraPosition: THREE.Vector3,
  forward: THREE.Vector3,
  oldTarget: THREE.Vector3,
  minDistance: number,
): THREE.Vector3 {
  const dist = Math.max(cameraPosition.distanceTo(oldTarget), minDistance);
  return cameraPosition.clone().addScaledVector(forward, dist);
}

/**
 * ダブルクリックした地点までズームインする際の新しいカメラ位置を計算する（Issue #7）。
 * クリック地点までの距離を半分に縮めるが、minDistance未満にはしない。
 * zoomSpeedの調整だけではtargetが遠くに固定されたままのため効果が薄かったことから、
 * PotreeViewer同様にクリック地点を基準にズームインする操作を追加する。
 */
export function computeDoubleClickZoomPosition(
  cameraPosition: THREE.Vector3,
  hitPoint: THREE.Vector3,
  minDistance: number,
): THREE.Vector3 {
  const offset = cameraPosition.clone().sub(hitPoint);
  const dist = offset.length();
  if (dist < 1e-9) return cameraPosition.clone();
  const newDist = Math.max(dist * 0.5, minDistance);
  offset.setLength(newDist);
  return hitPoint.clone().add(offset);
}

/**
 * カメラ・target間の距離がminDistance未満に落ち込んでいないかを毎フレーム強制的に
 * 再クランプする（Issue #7 追加調査3）。zoomToCursor有効時はOrbitControls内部で
 * カーソル方向へ直接カメラ位置を動かす経路があり、target方向とずれるとクランプ済みの
 * はずのdistanceが実際にはminDistance未満まで落ち込みうることを実機で確認した。
 * 方向ベクトルが定まらないほど近い場合はfallbackDirectionを使う。
 */
export function clampCameraDistance(
  cameraPosition: THREE.Vector3,
  target: THREE.Vector3,
  minDistance: number,
  fallbackDirection: THREE.Vector3,
): THREE.Vector3 {
  const offset = cameraPosition.clone().sub(target);
  const dist = offset.length();
  if (dist >= minDistance) return cameraPosition.clone();
  const dir = dist > 1e-6 ? offset.divideScalar(dist) : fallbackDirection.clone().normalize();
  return target.clone().addScaledVector(dir, minDistance);
}

/** ダブルクリックズームのアニメーションで使う減速イージング（Issue #7 追加調査4） */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * カメラ-target間距離に追従してnear平面を動的に縮める（Issue #7）。
 * フィット時のnear（size/5000、maxNear）とminDistance相当（minNear）は`size`によらず
 * 常に約200倍の比率で固定されており、distanceがminDistanceへ到達するはるか手前で
 * near平面クリップにより点群がすり抜けて見える不具合があった。distanceが縮むほどnearも
 * distance/100に追従して縮めることで、クリップ開始をminDistance付近まで遅らせる。
 */
export function dynamicNear(distance: number, minNear: number, maxNear: number): number {
  return Math.min(maxNear, Math.max(minNear, distance / 100));
}

/**
 * three.js による点群ビューア。
 * シーン座標 = 実座標 - origin（最初に読んだファイルの min）。float32 の精度落ちを防ぐ。
 */
export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly shared: SharedUniforms = createSharedUniforms();
  readonly layers: Layer[] = [];
  readonly overlays = new THREE.Group();
  /** 実座標 → シーン座標の原点（double 精度） */
  origin: [number, number, number] | null = null;
  /** シーン座標での全レイヤー（LAS + 3DGS）の範囲。視点・near/far の基準 */
  readonly bounds = new THREE.Box3();
  /** シーン座標での LAS レイヤーのみの範囲。標高の色分けレンジの基準 */
  readonly pointBounds = new THREE.Box3();
  readonly splatLayers: SplatLayer[] = [];
  /** 最初の 3DGS レイヤー追加時に生成する（3DGS を使わないときの負荷をなくすため） */
  private spark: SparkRenderer | null = null;
  readonly measurements: Measurement[] = [];
  measureMode = false;
  readonly walk: WalkControls;
  walkMode = false;
  private savedNear = 0.1;
  /** フィット時のnear（size/5000）。ズーム中のnear動的再計算(dynamicNear)の上限として使う */
  private baseNear = 0.1;
  onWalkModeChange: ((on: boolean) => void) | null = null;
  /** ズーム/パン不具合（Issue #5）の調査用。毎フレーム getDebugInfo() の内容を通知する */
  onDebugUpdate: ((info: ViewerDebugInfo) => void) | null = null;
  private pendingPoint: THREE.Vector3 | null = null;
  private pendingMarker: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  onPick: ((scenePos: THREE.Vector3, worldPos: [number, number, number]) => void) | null = null;
  onMeasure: ((m: Measurement) => void) | null = null;
  private layerSeq = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x1b1e24);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(50, -50, 50);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true; // ホイールズームはカーソル位置を中心に
    // 既定値(1.0)だと、点群読み込み中のメインスレッド混雑でフレームが遅延した際、
    // その間に溜まったホイールイベント分の倍率が次のupdate()で一括適用され、
    // 軽く触れただけで大きくズームインしてしまう（Issue #7）。感度を下げて緩和する。
    this.controls.zoomSpeed = 0.5;
    this.controls.minDistance = minDistanceForSize(0);
    this.scene.add(this.overlays);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(1, -1, 2);
    this.scene.add(dir);

    this.pendingMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffff00 }));
    this.pendingMarker.visible = false;
    this.scene.add(this.pendingMarker);

    window.addEventListener('resize', () => this.resize());
    this.resize();
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    window.addEventListener('pointermove', (e) => this.onPointerMoveForRotatePivot(e));
    this.walk = new WalkControls(this.camera, canvas);
    this.walk.onExit = () => this.setWalkMode(false);
    this.renderer.setAnimationLoop(() => this.render());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.shared.uScreenHeight.value = h * this.renderer.getPixelRatio();
  }

  private render() {
    if (this.walkMode) this.walk.update();
    else {
      if (this.zoomAnim) {
        this.updateZoomAnim();
      } else if (!this.rotateActive) {
        // 独自の回転中心ドラッグ中はOrbitControls.update()を呼ばない（毎フレームlookAt(target)で
        // 向きが上書きされ、クリック位置中心の回転が壊れてしまうため）。
        this.controls.update();
        // zoomToCursor有効時、内部でカーソル方向へ直接カメラ位置を動かす経路があり、
        // target方向とずれるとdistanceがminDistance未満まで落ち込むことがある（Issue #7）。
        // 起きてしまった場合に備え、毎フレーム強制的に再クランプする。
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        this.camera.position.copy(
          clampCameraDistance(this.camera.position, this.controls.target, this.controls.minDistance, forward.negate()),
        );
      }
      const distance = this.camera.position.distanceTo(this.controls.target);
      const near = dynamicNear(distance, this.controls.minDistance, this.baseNear);
      if (near !== this.camera.near) {
        this.camera.near = near;
        this.camera.updateProjectionMatrix();
      }
    }
    // ラベル・マーカーは画面上のピクセルサイズが一定になるよう、各オブジェクトまでの距離で決める
    const LABEL_PX = 18; // ラベル高さ
    const MARKER_PX = 5; // マーカー半径
    for (const m of this.measurements) {
      const asp = (m.label as THREE.Sprite & { aspect?: number }).aspect ?? 4;
      const h = LABEL_PX * this.worldPerPixel(m.label.position);
      m.label.scale.set(h * asp, h, 1);
    }
    if (this.pendingMarker.visible) this.pendingMarker.scale.setScalar(MARKER_PX * this.worldPerPixel(this.pendingMarker.position));
    this.renderer.render(this.scene, this.camera);
    this.onDebugUpdate?.(this.getDebugInfo());
  }

  /** ダブルクリックズームのカメラ位置・targetを毎フレーム補間する（Issue #7 追加調査4）。
   * targetもstart/endとも視線方向上の点として計算済みのため、lookAt()は呼ばず視線方向を固定する
   * （呼ぶとクリック地点が画面中心へスナップし、不自然な見た目になる）。 */
  private updateZoomAnim() {
    const anim = this.zoomAnim;
    if (!anim) return;
    const t = Math.min((performance.now() - anim.startTime) / anim.duration, 1);
    const e = easeOutCubic(t);
    this.camera.position.lerpVectors(anim.startPos, anim.endPos, e);
    this.controls.target.lerpVectors(anim.startTarget, anim.endTarget, e);
    if (t >= 1) this.zoomAnim = null;
  }

  /** カメラ位置・target・距離など、ズーム/パン不具合（Issue #5/#7）の調査用デバッグ情報 */
  getDebugInfo(): ViewerDebugInfo {
    return {
      cameraPosition: this.camera.position.clone(),
      target: this.controls.target.clone(),
      distance: this.camera.position.distanceTo(this.controls.target),
      minDistance: this.controls.minDistance,
      near: this.camera.near,
      far: this.camera.far,
      sceneSize: this.bounds.isEmpty() ? 0 : this.bounds.getSize(new THREE.Vector3()).length(),
      controlsEnabled: this.controls.enabled,
      rotateCandidate: this.rotateCandidate,
      rotateActive: this.rotateActive,
    };
  }

  // ------------------------------------------------------------ layers
  toScene(x: number, y: number, z: number): THREE.Vector3 {
    const o = this.origin ?? [0, 0, 0];
    return new THREE.Vector3(x - o[0], y - o[1], z - o[2]);
  }
  toWorld(v: THREE.Vector3): [number, number, number] {
    const o = this.origin ?? [0, 0, 0];
    return [v.x + o[0], v.y + o[1], v.z + o[2]];
  }

  addLayer(name: string, header: LasHeader): Layer {
    const isFirstData = this.layers.length === 0 && this.splatLayers.length === 0;
    if (!this.origin) {
      this.origin = [header.min[0], header.min[1], header.min[2]];
      // local モードの 3DGS は実座標で配置を持っているので、origin 確定に合わせて置き直す
      for (const sl of this.splatLayers) this.applySplatTransform(sl);
    }
    const group = new THREE.Group();
    group.position.copy(this.toScene(header.min[0], header.min[1], header.min[2]));
    const material = createPointMaterial(this.shared, 257); // 8bit と仮定して開始
    const layer: Layer = {
      id: ++this.layerSeq,
      name,
      header,
      group,
      material,
      pointCount: 0,
      visible: true,
      is16bitColor: false,
      hasRgb: false,
    };
    this.layers.push(layer);
    this.scene.add(group);
    this.recomputeBounds();
    if (isFirstData) this.fitCamera();
    else if (this.layers.length === 1) this.fitToLayer(layer); // 先に 3DGS だけがあった場合は点群に合わせる
    return layer;
  }

  appendBatch(layer: Layer, b: PointBatch) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(b.colors, 3, true));
    geom.setAttribute('intensity', new THREE.BufferAttribute(b.intensity, 1, true));
    geom.setAttribute('classification', new THREE.BufferAttribute(b.classification, 1, false));
    geom.computeBoundingSphere();
    const pts = new THREE.Points(geom, layer.material);
    pts.frustumCulled = true;
    layer.group.add(pts);
    layer.pointCount += b.count;
    layer.hasRgb = b.hasRgb;
    if (b.maxColor > 255 && !layer.is16bitColor) {
      layer.is16bitColor = true;
      layer.material.uniforms.uColorScale.value = 1;
    }
  }

  removeLayer(layer: Layer) {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.scene.remove(layer.group);
    layer.group.traverse((o) => {
      if (o instanceof THREE.Points) o.geometry.dispose();
    });
    layer.material.dispose();
    this.recomputeBounds();
  }

  setLayerVisible(layer: Layer, v: boolean) {
    layer.visible = v;
    layer.group.visible = v;
  }

  private recomputeBounds() {
    const las = this.layers.map((l) => ({ min: l.header.min, max: l.header.max }));
    this.pointBounds.copy(computeSceneBounds(this.origin, las, []));
    this.bounds.copy(computeSceneBounds(this.origin, las, this.splatLayers.map((sl) => this.splatBox(sl))));
    this.updateZRange();
  }

  private updateZRange() {
    if (this.pointBounds.isEmpty()) return;
    this.shared.uZRange.value.set(this.pointBounds.min.z, this.pointBounds.max.z);
  }

  // ------------------------------------------------------------ 3DGS layers (Issue #12)
  addSplatLayer(name: string, loaded: LoadedSplat): SplatLayer {
    if (!this.spark) {
      this.spark = new SparkRenderer({ renderer: this.renderer });
      this.scene.add(this.spark);
    }
    const isFirstData = this.layers.length === 0 && this.splatLayers.length === 0;
    const placement = defaultPlacement(loaded.localBox, this.bounds, this.origin);
    // world モードでは LAS と同様に範囲の min を origin とする（local モードでは確定させない）
    if (!this.origin && placement.mode === 'world') {
      const m = loaded.localBox.min;
      this.origin = [m.x, m.y, m.z];
    }
    const layer: SplatLayer = {
      id: ++this.layerSeq,
      name,
      mesh: loaded.mesh,
      localBox: loaded.localBox,
      placement,
      splatCount: loaded.splatCount,
      visible: true,
    };
    this.splatLayers.push(layer);
    this.scene.add(layer.mesh);
    this.applySplatTransform(layer);
    this.recomputeBounds();
    if (isFirstData) this.fitCamera();
    return layer;
  }

  setSplatPlacement(layer: SplatLayer, p: SplatPlacement) {
    layer.placement = { ...p };
    this.applySplatTransform(layer);
    this.recomputeBounds();
  }

  setSplatLayerVisible(layer: SplatLayer, v: boolean) {
    layer.visible = v;
    layer.mesh.visible = v;
  }

  removeSplatLayer(layer: SplatLayer) {
    const i = this.splatLayers.indexOf(layer);
    if (i < 0) return;
    this.splatLayers.splice(i, 1);
    this.scene.remove(layer.mesh);
    layer.mesh.dispose();
    this.recomputeBounds();
  }

  fitToSplatLayer(layer: SplatLayer) {
    this.fitCamera(this.splatBox(layer));
  }

  private splatTransform(layer: SplatLayer) {
    return computeSplatTransform(layer.placement, layer.localBox, this.origin ?? [0, 0, 0]);
  }

  private splatBox(layer: SplatLayer): THREE.Box3 {
    return splatSceneBox(layer.localBox, this.splatTransform(layer));
  }

  private applySplatTransform(layer: SplatLayer) {
    const t = this.splatTransform(layer);
    layer.mesh.position.copy(t.position);
    layer.mesh.quaternion.copy(t.quaternion);
    layer.mesh.scale.copy(t.scale);
    layer.mesh.updateMatrixWorld();
  }

  /** ウォークスルー（一人称キーボード操作）の切替 */
  setWalkMode(on: boolean) {
    if (on === this.walkMode) return;
    this.walkMode = on;
    if (on) {
      this.controls.enabled = false;
      this.savedNear = this.camera.near;
      this.camera.near = 0.05; // 近くの壁が消えないように
      this.camera.updateProjectionMatrix();
      this.walk.enable();
      this.canvas.focus();
    } else {
      this.walk.disable();
      this.camera.near = this.savedNear;
      this.camera.updateProjectionMatrix();
      // 視線の 5m 先を注視点にして軌道操作へ戻す
      this.controls.target.copy(this.camera.position).add(this.walk.viewDir.multiplyScalar(5));
      this.controls.enabled = true;
      this.controls.update();
    }
    this.onWalkModeChange?.(on);
  }

  /** 指定位置（実座標）に目線高さで立ってウォークスルーを開始 */
  startWalkAt(world: [number, number, number], eyeHeight = 1.6) {
    const p = this.toScene(world[0], world[1], world[2]);
    const dir = this.walkMode ? this.walk.forwardXY : new THREE.Vector3().subVectors(this.controls.target, this.camera.position).setZ(0).normalize();
    this.camera.position.set(p.x, p.y, p.z + eyeHeight);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.camera.position.clone().add(dir.lengthSq() > 0 ? dir : new THREE.Vector3(0, 1, 0)));
    this.setWalkMode(false);
    this.setWalkMode(true);
  }

  fitToLayer(layer: Layer) {
    const box = new THREE.Box3();
    box.expandByPoint(this.toScene(...layer.header.min));
    box.expandByPoint(this.toScene(...layer.header.max));
    this.fitCamera(box);
  }

  fitCamera(box: THREE.Box3 = this.bounds) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(size * 0.5, -size * 0.6, size * 0.5));
    this.baseNear = Math.max(0.01, size / 5000);
    this.camera.near = this.baseNear;
    this.camera.far = size * 50;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = minDistanceForSize(size);
    this.controls.update();
  }

  setView(kind: 'top' | 'north' | 'east' | 'iso') {
    if (this.bounds.isEmpty()) return;
    const c = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3()).length();
    const d: Record<typeof kind, THREE.Vector3> = {
      top: new THREE.Vector3(0, -0.0001, 1),
      north: new THREE.Vector3(0, -1, 0.15),
      east: new THREE.Vector3(1, 0, 0.15),
      iso: new THREE.Vector3(0.5, -0.6, 0.5),
    };
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(d[kind].normalize().multiplyScalar(size));
    this.controls.update();
  }

  // ------------------------------------------------------------ display settings
  setColorMode(m: ColorMode) {
    this.shared.uMode.value = COLOR_MODE_INDEX[m];
  }
  setPointSize(px: number) {
    this.shared.uPointSize.value = px;
  }
  setAttenuate(on: boolean) {
    this.shared.uAttenuate.value = on ? 1 : 0;
  }
  setIntensityRange(lo: number, hi: number) {
    this.shared.uIntensityRange.value.set(lo, hi);
  }
  setElevationRange(lo: number | null, hi: number | null) {
    // 実座標での標高 → シーン座標
    const oz = this.origin?.[2] ?? 0;
    const min = lo == null ? this.bounds.min.z : lo - oz;
    const max = hi == null ? this.bounds.max.z : hi - oz;
    this.shared.uZRange.value.set(min, max);
  }
  setBackground(hex: number) {
    (this.scene.background as THREE.Color).setHex(hex);
  }

  // ------------------------------------------------------------ picking / measurement
  private downPos = { x: 0, y: 0 };
  private lastPointerPos = { x: 0, y: 0 };
  /** 現在のドラッグが回転操作の候補か（左ボタン・非ウォーク・修飾キーなし。Ctrl/Meta/ShiftはOrbitControls側でパン扱いになるため対象外） */
  private rotateCandidate = false;
  /** クリック位置を中心にOrbitControlsを介さず独自回転を行っている最中か */
  private rotateActive = false;
  /** 回転中心（ワールド座標）。ドラッグ開始位置でpick()した点 */
  private rotatePivot: THREE.Vector3 | null = null;
  /** ダブルクリックズームの補間アニメーション状態（Issue #7 追加調査4） */
  private zoomAnim: {
    startPos: THREE.Vector3;
    endPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startTime: number;
    duration: number;
  } | null = null;
  private onPointerDown(e: PointerEvent) {
    this.downPos = { x: e.clientX, y: e.clientY };
    this.lastPointerPos = { x: e.clientX, y: e.clientY };
    this.rotateCandidate = e.button === 0 && !this.walkMode && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    this.rotateActive = false;
    this.rotatePivot = null;
    // ダブルクリックズームアニメーション中に別の操作を始めた場合は即座に中断する
    this.zoomAnim = null;
    // ドラッグと判定されるまでOrbitControlsの回転処理を止め、旧回転中心での余計な回転が
    // 混ざらないようにする（有効化はonPointerMoveForRotatePivot/onPointerUpで行う）。
    if (this.rotateCandidate) this.controls.enabled = false;
  }
  /**
   * クリック位置を回転の原点にする。OrbitControls.target をクリック位置へ差し替えると
   * 毎フレームの lookAt(target) でその点が画面中心へスナップしてしまうため使わず、
   * カメラの位置と向きを同時に、クリックした点を中心に回転させることで見た目上の
   * ジャンプなしに「クリック位置中心の回転」を実現する。
   */
  private onPointerMoveForRotatePivot(e: PointerEvent) {
    if (!this.rotateCandidate) return;
    const dx = e.clientX - this.lastPointerPos.x;
    const dy = e.clientY - this.lastPointerPos.y;
    this.lastPointerPos = { x: e.clientX, y: e.clientY };
    if (!this.rotateActive) {
      if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) < 4) return; // 単純クリックは対象外
      const hit = this.pick(this.downPos.x, this.downPos.y);
      if (!hit) {
        // ヒットしない場合は通常のOrbitControls回転（既存のtarget中心）に任せる
        this.rotateCandidate = false;
        this.controls.enabled = true;
        return;
      }
      this.rotateActive = true;
      this.rotatePivot = hit;
    }
    this.rotateAroundPivot(dx, dy);
  }
  /** クリックした点（rotatePivot）を中心に、カメラの位置と向きを一体で回転させる */
  private rotateAroundPivot(dx: number, dy: number) {
    if (!this.rotatePivot) return;
    const h = this.canvas.clientHeight || window.innerHeight;
    const yawAngle = (-2 * Math.PI * dx) / h;
    const pitchAngle = (-2 * Math.PI * dy) / h;
    const offset = this.camera.position.clone().sub(this.rotatePivot);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(this.camera.up, yawAngle);
    offset.applyQuaternion(qYaw);
    this.camera.quaternion.premultiply(qYaw);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, pitchAngle);
    offset.applyQuaternion(qPitch);
    this.camera.quaternion.premultiply(qPitch);
    this.camera.position.copy(this.rotatePivot).add(offset);
  }
  private onPointerUp(e: PointerEvent) {
    if (this.rotateCandidate) {
      if (this.rotateActive) {
        // 現在のカメラの向きの先（画面中心）にtargetを置き直す。lookAt()を呼んでも
        // 向きが変わらない位置なので、OrbitControlsへ戻す際に視点はスナップしない。
        // 距離はminDistance未満に潰れないようクランプする（Issue #5: 潰れるとズーム・パンが反応しなくなる）。
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        this.controls.target.copy(
          computeTargetAfterRotate(this.camera.position, forward, this.controls.target, this.controls.minDistance),
        );
      }
      this.controls.enabled = true;
      this.rotateCandidate = false;
      this.rotateActive = false;
      this.rotatePivot = null;
    }
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 4) return; // ドラッグは無視
    const hit = this.pick(e.clientX, e.clientY);
    if (!hit) return;
    // シングルクリックでtargetをクリック地点へ更新する挙動は撤回した（Issue #7 追加調査5）。
    // 視線が画面中心へスナップし、ダブルクリックズームとも挙動が競合して不自然だったため。
    this.onPick?.(hit, this.toWorld(hit));
    if (!this.measureMode) return;
    if (!this.pendingPoint) {
      this.pendingPoint = hit;
      this.pendingMarker.position.copy(hit);
      this.pendingMarker.visible = true;
    } else {
      const m = this.addMeasurement(this.pendingPoint, hit);
      this.pendingPoint = null;
      this.pendingMarker.visible = false;
      this.onMeasure?.(m);
    }
  }

  /** ダブルクリックした地点までズームインする（Issue #7）。PotreeViewer同様のズーム操作。
   * 瞬時にカメラを移動させると視点が把握しづらいため、短時間のアニメーションで滑らかに補間する。
   * targetをクリック地点そのものにすると視線が画面中心へスナップして不自然なため、
   * 現在の視線方向は変えず、その方向に沿ってカメラを前進させることでクリック地点の
   * 画面上の位置を保ったままズームする（ホイールのzoomToCursorと同様の見え方）。 */
  private onDoubleClick(e: MouseEvent) {
    if (this.walkMode) return;
    const hit = this.pick(e.clientX, e.clientY);
    if (!hit) return;
    const endPos = computeDoubleClickZoomPosition(this.camera.position, hit, this.controls.minDistance);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const startDist = Math.max(this.camera.position.distanceTo(this.controls.target), this.controls.minDistance);
    const endDist = endPos.distanceTo(hit);
    this.zoomAnim = {
      startPos: this.camera.position.clone(),
      endPos,
      startTarget: this.camera.position.clone().addScaledVector(forward, startDist),
      endTarget: endPos.clone().addScaledVector(forward, endDist),
      startTime: performance.now(),
      duration: 300,
    };
  }

  /** 指定位置において 1 ピクセルが何ワールド単位に相当するか */
  worldPerPixel(pos: THREE.Vector3): number {
    const d = this.camera.position.distanceTo(pos);
    const h = this.canvas.clientHeight || window.innerHeight;
    return (d * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
  }

  pick(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const camDist = this.camera.position.distanceTo(this.controls.target);
    // 注視点距離で約 6px 相当の太さのレイで拾う
    this.raycaster.params.Points.threshold = 6 * this.worldPerPixel(this.controls.target);
    const targets: THREE.Object3D[] = [];
    for (const l of this.layers) if (l.visible) targets.push(l.group);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return null;
    // 点群のレイキャストは「レイに近い順」ではなく距離順に返るので、
    // 手前側の一定範囲内で最もレイに近い点を選ぶ
    const nearest = hits[0].distance;
    let best = hits[0];
    for (const h of hits) {
      if (h.distance > nearest + camDist * 0.02) break;
      if ((h.distanceToRay ?? Infinity) < (best.distanceToRay ?? Infinity)) best = h;
    }
    return best.point.clone();
  }

  addMeasurement(a: THREE.Vector3, b: THREE.Vector3): Measurement {
    const distance = a.distanceTo(b);
    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xffdd33, depthTest: false }));
    line.renderOrder = 10;
    const dxy = Math.hypot(b.x - a.x, b.y - a.y);
    const dz = b.z - a.z;
    const label = makeLabel(`${distance.toFixed(3)} m  (水平 ${dxy.toFixed(3)} / 高低差 ${dz.toFixed(3)})`);
    label.position.copy(a).add(b).multiplyScalar(0.5);
    this.scene.add(line, label);
    const m: Measurement = { a, b, line, label, distance };
    this.measurements.push(m);
    return m;
  }

  clearMeasurements() {
    for (const m of this.measurements) {
      this.scene.remove(m.line, m.label);
      m.line.geometry.dispose();
      (m.label.material as THREE.SpriteMaterial).map?.dispose();
    }
    this.measurements.length = 0;
    this.pendingPoint = null;
    this.pendingMarker.visible = false;
  }
}

function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = '28px sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  canvas.width = w;
  canvas.height = 48;
  ctx.font = '28px sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, w, 48);
  ctx.fillStyle = '#ffdd33';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, 24);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.renderOrder = 11;
  sp.center.set(0.5, 0);
  (sp as THREE.Sprite & { aspect: number }).aspect = w / 48;
  return sp;
}
