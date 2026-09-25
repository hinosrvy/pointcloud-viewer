import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { Viewer } from './Viewer';
import type { Crs } from './crs';

// ------------------------------------------------------------------ 地図タイル
export interface TileSource {
  id: string;
  name: string;
  url: string; // {z}/{x}/{y}
  maxZoom: number;
  attribution: string;
}

export const TILE_SOURCES: TileSource[] = [
  { id: 'gsi-std', name: '地理院 標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxZoom: 18, attribution: '国土地理院' },
  { id: 'gsi-pale', name: '地理院 淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxZoom: 18, attribution: '国土地理院' },
  { id: 'gsi-photo', name: '地理院 全国最新写真（シームレス）', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxZoom: 18, attribution: '国土地理院' },
  { id: 'osm', name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap contributors' },
];

function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return [x, y];
}
function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

export class MapOverlay {
  readonly group = new THREE.Group();
  private materials: THREE.MeshBasicMaterial[] = [];
  private loader = new THREE.TextureLoader();
  opacity = 1;
  tileCount = 0;
  zoom = 0;

  constructor(private viewer: Viewer) {
    this.loader.setCrossOrigin('anonymous');
    viewer.overlays.add(this.group);
  }

  clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.MeshBasicMaterial)?.map?.dispose();
      (m.material as THREE.Material)?.dispose();
    }
    this.materials = [];
    this.tileCount = 0;
  }

  setOpacity(o: number) {
    this.opacity = o;
    for (const m of this.materials) m.opacity = o;
  }
  setZ(z: number) {
    this.group.position.z = z;
  }

  /**
   * 点群の範囲（＋余白）を覆う地図タイルを敷く。
   * @param zScene 地図を置く高さ（シーン座標）
   * @param maxTiles 使用タイル数の上限（ズームレベルはこれから自動決定）
   */
  build(crs: Crs, source: TileSource, zScene: number, margin = 0.2, maxTiles = 64) {
    this.clear();
    const v = this.viewer;
    if (v.bounds.isEmpty() || !v.origin) return;
    const b = v.bounds;
    const size = b.getSize(new THREE.Vector3());
    const [ox, oy] = v.origin;
    const minX = b.min.x - size.x * margin + ox;
    const maxX = b.max.x + size.x * margin + ox;
    const minY = b.min.y - size.y * margin + oy;
    const maxY = b.max.y + size.y * margin + oy;

    // 4隅を経緯度へ
    const corners = [crs.toLonLat(minX, minY), crs.toLonLat(maxX, minY), crs.toLonLat(minX, maxY), crs.toLonLat(maxX, maxY)];
    const lonMin = Math.min(...corners.map((c) => c[0]));
    const lonMax = Math.max(...corners.map((c) => c[0]));
    const latMin = Math.min(...corners.map((c) => c[1]));
    const latMax = Math.max(...corners.map((c) => c[1]));
    if (!isFinite(lonMin) || Math.abs(latMin) > 85) throw new Error('座標系の変換結果が不正です。座標系や X/Y の入替設定を確認してください');

    let z = source.maxZoom;
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (; z >= 1; z--) {
      const [tx0, ty1] = lonLatToTile(lonMin, latMin, z);
      const [tx1, ty0] = lonLatToTile(lonMax, latMax, z);
      x0 = Math.floor(tx0); x1 = Math.floor(tx1); y0 = Math.floor(ty0); y1 = Math.floor(ty1);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) break;
    }
    this.zoom = z;
    this.group.position.z = zScene;

    const SUB = 6; // タイルを SUB×SUB に分割して投影歪みを追従
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const geom = new THREE.PlaneGeometry(1, 1, SUB, SUB);
        const pos = geom.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          // PlaneGeometry の頂点は x:-0.5..0.5, y:0.5..-0.5 (上→下)
          const u = pos.getX(i) + 0.5;
          const vv = 0.5 - pos.getY(i);
          const [lon, lat] = tileToLonLat(tx + u, ty + vv, z);
          const [lx, ly] = crs.toLocal(lon, lat);
          pos.setXYZ(i, lx - ox, ly - oy, 0);
        }
        pos.needsUpdate = true;
        geom.computeBoundingSphere();
        const mat = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: this.opacity, side: THREE.DoubleSide, depthWrite: false });
        const url = source.url.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
        this.loader.load(url, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          mat.map = tex;
          mat.color.set(0xffffff);
          mat.needsUpdate = true;
        });
        this.materials.push(mat);
        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = -1;
        this.group.add(mesh);
        this.tileCount++;
      }
    }
  }
}

// ------------------------------------------------------------------ 3D モデル
export class ModelOverlay {
  readonly group = new THREE.Group();
  readonly inner = new THREE.Group(); // Y-up → Z-up 変換用
  name = '';
  constructor(private viewer: Viewer) {
    this.group.add(this.inner);
    viewer.overlays.add(this.group);
  }

  async load(file: File): Promise<void> {
    this.clear();
    const url = URL.createObjectURL(file);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      let obj: THREE.Object3D;
      if (ext === 'glb' || ext === 'gltf') {
        const gltf = await new GLTFLoader().loadAsync(url);
        obj = gltf.scene;
      } else if (ext === 'obj') {
        obj = await new OBJLoader().loadAsync(url);
        obj.traverse((o) => {
          if (o instanceof THREE.Mesh) o.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
        });
      } else {
        throw new Error('対応形式: .glb / .gltf / .obj');
      }
      this.inner.add(obj);
      this.name = file.name;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  clear() {
    for (const c of [...this.inner.children]) this.inner.remove(c);
    this.name = '';
  }

  /** 実座標での配置 */
  setPlacement(p: { x: number; y: number; z: number; scale: number; headingDeg: number; yUp: boolean }) {
    this.group.position.copy(this.viewer.toScene(p.x, p.y, p.z));
    this.group.scale.setScalar(p.scale);
    this.group.rotation.set(0, 0, (p.headingDeg * Math.PI) / 180);
    this.inner.rotation.set(p.yUp ? Math.PI / 2 : 0, 0, 0);
  }

  /** モデルの原点を底面中心にする（配置しやすく） */
  centerOnBase(yUp: boolean) {
    this.inner.updateWorldMatrix(true, true);
    // モデル座標系(inner ローカル)での範囲
    const box = new THREE.Box3().setFromObject(this.inner).applyMatrix4(this.inner.matrixWorld.clone().invert());
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    for (const child of this.inner.children) {
      child.position.x -= c.x;
      if (yUp) {
        child.position.y -= box.min.y; // Y-up モデルは Y が高さ
        child.position.z -= c.z;
      } else {
        child.position.y -= c.y;
        child.position.z -= box.min.z;
      }
    }
  }

  get bboxSize(): THREE.Vector3 {
    return new THREE.Box3().setFromObject(this.inner).getSize(new THREE.Vector3());
  }
}

// ------------------------------------------------------------------ 写真
export class PhotoOverlay {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private material = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
  aspect = 1;
  name = '';
  constructor(private viewer: Viewer) {
    viewer.overlays.add(this.group);
  }

  async load(file: File): Promise<void> {
    this.clear();
    const url = URL.createObjectURL(file);
    try {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.material.map = tex;
      this.material.needsUpdate = true;
      const img = tex.image as HTMLImageElement;
      this.aspect = img.width / img.height;
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
      this.group.add(this.mesh);
      this.name = file.name;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  clear() {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.material.map?.dispose();
    this.material.map = null;
    this.name = '';
  }

  /**
   * @param width 実寸幅 [m]
   * @param headingDeg Z 軸周りの回転
   * @param tiltDeg 0=地面に水平, 90=垂直に立てる
   */
  setPlacement(p: { x: number; y: number; z: number; width: number; headingDeg: number; tiltDeg: number; opacity: number }) {
    this.group.position.copy(this.viewer.toScene(p.x, p.y, p.z));
    this.group.rotation.set((p.tiltDeg * Math.PI) / 180, 0, (p.headingDeg * Math.PI) / 180, 'ZXY');
    this.group.scale.set(p.width, p.width / this.aspect, 1);
    this.material.opacity = p.opacity;
  }
}
