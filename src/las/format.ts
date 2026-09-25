/**
 * LAS 1.0〜1.4 ヘッダ／点レコードの最小パーサ。
 * LAZ(圧縮) の場合も公開ヘッダは同じ構造なのでそのまま使える。
 */

export interface LasHeader {
  versionMajor: number;
  versionMinor: number;
  headerSize: number;
  pointDataOffset: number;
  vlrCount: number;
  pointFormat: number; // 圧縮ビット(0x80)を除いた実フォーマット
  compressed: boolean; // LAZ か
  pointLength: number;
  pointCount: number; // 1.4 の場合は 64bit 値を採用
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  evlrOffset: number;
  evlrCount: number;
  copc?: CopcInfo;
  wkt?: string;
}

export interface CopcInfo {
  center: [number, number, number];
  halfSize: number;
  spacing: number;
  rootHierOffset: number;
  rootHierSize: number;
}

export const HEADER_READ_BYTES = 375 + 54 + 160 + 4096; // ヘッダ + COPC VLR + 余裕(WKT VLR用)

export function parseHeader(buf: ArrayBuffer): LasHeader {
  const dv = new DataView(buf);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('LAS ファイルではありません（シグネチャ不一致）');

  const versionMajor = dv.getUint8(24);
  const versionMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const pointDataOffset = dv.getUint32(96, true);
  const vlrCount = dv.getUint32(100, true);
  const rawFormat = dv.getUint8(104);
  const pointLength = dv.getUint16(105, true);
  let pointCount = dv.getUint32(107, true);

  const rd = (o: number) => dv.getFloat64(o, true);
  const scale: [number, number, number] = [rd(131), rd(139), rd(147)];
  const offset: [number, number, number] = [rd(155), rd(163), rd(171)];
  // LAS はヘッダ内で max/min が交互に並ぶ (maxX, minX, maxY, minY, maxZ, minZ)
  const max: [number, number, number] = [rd(179), rd(195), rd(211)];
  const min: [number, number, number] = [rd(187), rd(203), rd(219)];

  let evlrOffset = 0;
  let evlrCount = 0;
  if (versionMinor >= 4 && headerSize >= 375) {
    evlrOffset = Number(dv.getBigUint64(235, true));
    evlrCount = dv.getUint32(243, true);
    const count64 = Number(dv.getBigUint64(247, true));
    if (count64 > 0) pointCount = count64;
  }

  const header: LasHeader = {
    versionMajor,
    versionMinor,
    headerSize,
    pointDataOffset,
    vlrCount,
    pointFormat: rawFormat & 0x3f,
    compressed: (rawFormat & 0x80) !== 0,
    pointLength,
    pointCount,
    scale,
    offset,
    min,
    max,
    evlrOffset,
    evlrCount,
  };

  // VLR を走査（COPC info / WKT）
  let p = headerSize;
  for (let i = 0; i < vlrCount && p + 54 <= buf.byteLength; i++) {
    const userId = readAscii(dv, p + 2, 16);
    const recordId = dv.getUint16(p + 18, true);
    const recLen = dv.getUint16(p + 20, true);
    const dataStart = p + 54;
    if (dataStart + recLen > buf.byteLength) break;
    if (userId === 'copc' && recordId === 1 && recLen >= 160) {
      header.copc = {
        center: [rd(dataStart), rd(dataStart + 8), rd(dataStart + 16)],
        halfSize: rd(dataStart + 24),
        spacing: rd(dataStart + 32),
        rootHierOffset: Number(dv.getBigUint64(dataStart + 40, true)),
        rootHierSize: Number(dv.getBigUint64(dataStart + 48, true)),
      };
    } else if (userId === 'LASF_Projection' && recordId === 2112) {
      header.wkt = readAscii(dv, dataStart, recLen);
    }
    p = dataStart + recLen;
  }
  return header;
}

function readAscii(dv: DataView, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** 点フォーマットごとの各フィールドのオフセット */
export interface FieldLayout {
  rgb: number; // -1 なら無し
  intensity: number;
  classification: number;
  classIsPdrf6: boolean; // 6以降は classification が独立バイト
}

export function layoutFor(format: number): FieldLayout {
  if (format >= 6) {
    const rgb = format === 7 || format === 8 || format === 10 ? 30 : -1;
    return { rgb, intensity: 12, classification: 16, classIsPdrf6: true };
  }
  const rgb = format === 2 ? 20 : format === 3 || format === 5 ? 28 : -1;
  return { rgb, intensity: 12, classification: 15, classIsPdrf6: false };
}

/** 1つのチャンクから点属性を抽出するための出力バッファ */
export interface PointBatch {
  count: number;
  /** ファイルヘッダ min を原点とした相対座標 (float32) */
  positions: Float32Array;
  colors: Uint16Array; // RGB 生値 (8bit/16bit はファイルにより異なる。無ければ 255)
  maxColor: number;
  intensity: Uint16Array;
  classification: Uint8Array;
  hasRgb: boolean;
}

/**
 * 生の点レコード配列 (LAS 非圧縮 / laz-perf 展開後) から stride ごとに点を取り出す。
 * @param src  レコードが連続で並んだバイト列
 * @param n    レコード数
 */
export function extractPoints(
  src: Uint8Array,
  n: number,
  header: LasHeader,
  stride: number,
  startIndex: number,
  out: PointBatchBuilder,
): number {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const len = header.pointLength;
  const lay = layoutFor(header.pointFormat);
  const [sx, sy, sz] = header.scale;
  const [ox, oy, oz] = header.offset;
  const [mx, my, mz] = header.min;
  let taken = 0;
  // startIndex はファイル全体での先頭レコード番号。stride の位相を合わせる
  let i = (stride - (startIndex % stride)) % stride;
  for (; i < n; i += stride) {
    const b = i * len;
    const x = dv.getInt32(b, true) * sx + ox - mx;
    const y = dv.getInt32(b + 4, true) * sy + oy - my;
    const z = dv.getInt32(b + 8, true) * sz + oz - mz;
    const inten = dv.getUint16(b + lay.intensity, true);
    let cls = dv.getUint8(b + lay.classification);
    if (!lay.classIsPdrf6) cls &= 0x1f;
    let r = 255, g = 255, bl = 255;
    if (lay.rgb >= 0) {
      r = dv.getUint16(b + lay.rgb, true);
      g = dv.getUint16(b + lay.rgb + 2, true);
      bl = dv.getUint16(b + lay.rgb + 4, true);
    }
    out.push(x, y, z, r, g, bl, inten, cls);
    taken++;
  }
  return taken;
}

/** 可変長で点を貯め、一定数ごとに flush する */
export class PointBatchBuilder {
  private pos: Float32Array;
  private col: Uint16Array;
  private inten: Uint16Array;
  private cls: Uint8Array;
  private n = 0;
  maxColor = 0;
  constructor(
    private capacity: number,
    private hasRgb: boolean,
    private onFlush: (b: PointBatch) => void,
  ) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Uint16Array(capacity * 3);
    this.inten = new Uint16Array(capacity);
    this.cls = new Uint8Array(capacity);
  }
  push(x: number, y: number, z: number, r: number, g: number, b: number, inten: number, cls: number) {
    const i = this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    if (r > this.maxColor) this.maxColor = r;
    if (g > this.maxColor) this.maxColor = g;
    if (b > this.maxColor) this.maxColor = b;
    this.inten[i] = inten;
    this.cls[i] = cls;
    this.n++;
    if (this.n === this.capacity) this.flush();
  }
  flush() {
    if (this.n === 0) return;
    const n = this.n;
    this.onFlush({
      count: n,
      positions: this.pos.slice(0, n * 3),
      colors: this.col.slice(0, n * 3),
      maxColor: this.maxColor,
      intensity: this.inten.slice(0, n),
      classification: this.cls.slice(0, n),
      hasRgb: this.hasRgb,
    });
    this.n = 0;
  }
}
