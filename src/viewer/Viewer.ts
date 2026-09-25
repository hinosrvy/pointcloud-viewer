import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WalkControls } from './WalkControls';
import type { LasHeader, PointBatch } from '../las/format';
import { COLOR_MODE_INDEX, createPointMaterial, createSharedUniforms } from './shaders';
import type { ColorMode, SharedUniforms } from './shaders';

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

export interface Measurement {
  a: THREE.Vector3;
  b: THREE.Vector3;
  line: THREE.Line;
  label: THREE.Sprite;
  distance: number;
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
  /** シーン座標での全レイヤーの範囲 */
  readonly bounds = new THREE.Box3();
  readonly measurements: Measurement[] = [];
  measureMode = false;
  readonly walk: WalkControls;
  walkMode = false;
  private savedNear = 0.1;
  onWalkModeChange: ((on: boolean) => void) | null = null;
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
    // 独自の回転中心ドラッグ中はOrbitControls.update()を呼ばない（毎フレームlookAt(target)で
    // 向きが上書きされ、クリック位置中心の回転が壊れてしまうため）。
    else if (!this.rotateActive) this.controls.update();
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
    if (!this.origin) {
      this.origin = [header.min[0], header.min[1], header.min[2]];
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
    this.bounds.expandByPoint(this.toScene(header.min[0], header.min[1], header.min[2]));
    this.bounds.expandByPoint(this.toScene(header.max[0], header.max[1], header.max[2]));
    this.updateZRange();
    if (this.layers.length === 1) this.fitCamera();
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
    this.bounds.makeEmpty();
    for (const l of this.layers) {
      this.bounds.expandByPoint(this.toScene(l.header.min[0], l.header.min[1], l.header.min[2]));
      this.bounds.expandByPoint(this.toScene(l.header.max[0], l.header.max[1], l.header.max[2]));
    }
    this.updateZRange();
  }

  private updateZRange() {
    if (this.bounds.isEmpty()) return;
    this.shared.uZRange.value.set(this.bounds.min.z, this.bounds.max.z);
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
    this.camera.near = Math.max(0.01, size / 5000);
    this.camera.far = size * 50;
    this.camera.updateProjectionMatrix();
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
  private onPointerDown(e: PointerEvent) {
    this.downPos = { x: e.clientX, y: e.clientY };
    this.lastPointerPos = { x: e.clientX, y: e.clientY };
    this.rotateCandidate = e.button === 0 && !this.walkMode && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    this.rotateActive = false;
    this.rotatePivot = null;
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
        const dist = this.camera.position.distanceTo(this.controls.target);
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        this.controls.target.copy(this.camera.position).addScaledVector(forward, dist);
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
