import * as THREE from 'three';

/**
 * キーボードによるウォークスルー（一人称）操作。Z-up 前提。
 *  W / ↑ : 前進        S / ↓ : 後退
 *  A     : 左移動      D     : 右移動
 *  ← / → : 左右旋回    Q / E : 上下俯仰（Q=上, E=下）
 *  R / F : 上昇 / 下降 Shift : 高速  Esc: 終了
 *  マウス左ドラッグ: 視線を回す   ホイール: 前後移動
 */
export class WalkControls {
  enabled = false;
  /** 移動速度 [m/s] */
  speed = 1.5;
  /** 旋回速度 [deg/s] */
  turnSpeed = 60;
  private yaw = 0; // Z 軸まわり。0 = +Y(北)向き、反時計回りが正
  private pitch = 0; // 0 = 水平、正で上向き
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastTime = 0;
  onExit: (() => void) | null = null;

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', () => (this.dragging = false));
    dom.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** 現在のカメラ姿勢から yaw/pitch を取り出して開始 */
  enable() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.yaw = Math.atan2(-dir.x, dir.y);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1));
    this.enabled = true;
    this.lastTime = performance.now();
    this.keys.clear();
    this.applyRotation();
  }

  disable() {
    this.enabled = false;
    this.keys.clear();
    this.dragging = false;
  }

  /** 視線方向（水平成分） */
  get forwardXY(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), Math.cos(this.yaw), 0);
  }
  get rightXY(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.yaw), Math.sin(this.yaw), 0);
  }
  get viewDir(): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.cos(this.yaw) * cp, Math.sin(this.pitch));
  }

  private applyRotation() {
    const target = this.camera.position.clone().add(this.viewDir);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(target);
  }

  /** 毎フレーム呼ぶ */
  update() {
    if (!this.enabled) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const k = this.keys;
    const fast = k.has('shift') ? 3 : 1;
    const v = this.speed * fast * dt;
    const rot = THREE.MathUtils.degToRad(this.turnSpeed) * dt;
    const pos = this.camera.position;

    if (k.has('w') || k.has('arrowup')) pos.add(this.forwardXY.multiplyScalar(v));
    if (k.has('s') || k.has('arrowdown')) pos.add(this.forwardXY.multiplyScalar(-v));
    if (k.has('a')) pos.add(this.rightXY.multiplyScalar(-v));
    if (k.has('d')) pos.add(this.rightXY.multiplyScalar(v));
    if (k.has('r') || k.has('pageup')) pos.z += v;
    if (k.has('f') || k.has('pagedown')) pos.z -= v;
    if (k.has('arrowleft')) this.yaw += rot;
    if (k.has('arrowright')) this.yaw -= rot;
    if (k.has('q')) this.pitch += rot;
    if (k.has('e')) this.pitch -= rot;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.applyRotation();
  }

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || this.isTyping(e)) return;
    if (e.key === 'Escape') {
      this.onExit?.();
      return;
    }
    this.keys.add(e.key.toLowerCase());
    if (e.key.startsWith('Arrow') || e.key.startsWith('Page') || e.key === ' ') e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
    if (e.key === 'Shift') this.keys.delete('shift');
  };
  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.enabled || !this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.yaw -= dx * 0.004;
    this.pitch -= dy * 0.004;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.applyRotation();
  };
  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const step = -Math.sign(e.deltaY) * this.speed * 0.5;
    this.camera.position.add(this.viewDir.multiplyScalar(step));
  };
}
