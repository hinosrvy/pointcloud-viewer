/**
 * 点群読み込みのコア（Worker からもメインスレッドからも呼べる）。
 *  - LAS (非圧縮)   : File.slice / HTTP Range で分割読み込み → 間引き
 *  - COPC LAZ       : 階層(オクツリー)ページを辿り、点数バジェット内のノードのみ展開
 *  - 通常の LAZ     : laz-perf にファイル全体を渡して逐次展開（サイズ上限あり）
 */
import { createLazPerf } from 'laz-perf';
import type { LazPerf } from 'laz-perf';
import wasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import { HEADER_READ_BYTES, PointBatchBuilder, extractPoints, layoutFor, parseHeader } from './format';
import type { LasHeader, PointBatch } from './format';
import type { LoadRequest, WorkerMessage } from './messages';

const MAX_WHOLE_LAZ_BYTES = 1.5 * 1024 ** 3; // 通常 LAZ をまるごと WASM メモリに載せる上限
const BATCH = 262_144;

type Getter = (begin: number, end: number) => Promise<Uint8Array>;

interface Source {
  size: number;
  get: Getter;
}

let lazPerfPromise: Promise<LazPerf> | null = null;
async function getLazPerf(): Promise<LazPerf> {
  if (!lazPerfPromise) {
    lazPerfPromise = (async () => {
      const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
      return createLazPerf({ wasmBinary } as Partial<EmscriptenModule>);
    })();
  }
  return lazPerfPromise;
}

async function openSource(src: File | string): Promise<Source> {
  if (typeof src !== 'string') {
    const file = src;
    return {
      size: file.size,
      get: async (b, e) => new Uint8Array(await file.slice(b, e).arrayBuffer()),
    };
  }
  const head = await fetch(src, { method: 'HEAD' });
  if (!head.ok) throw new Error(`URL にアクセスできません (${head.status})`);
  const len = Number(head.headers.get('content-length') ?? 0);
  if (head.headers.get('accept-ranges') !== 'bytes' && len === 0) {
    throw new Error('サーバーが Range リクエストに対応していません');
  }
  return {
    size: len,
    get: async (b, e) => {
      const r = await fetch(src, { headers: { Range: `bytes=${b}-${e - 1}` } });
      if (!r.ok) throw new Error(`Range リクエスト失敗 (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

export type Poster = (msg: WorkerMessage, transfer?: Transferable[]) => void;
let post: Poster = () => {};

function makeBuilder(id: number, header: LasHeader, counter: { n: number }) {
  const hasRgb = layoutFor(header.pointFormat).rgb >= 0;
  return new PointBatchBuilder(BATCH, hasRgb, (b: PointBatch) => {
    counter.n += b.count;
    post({ type: 'batch', id, batch: b }, [
      b.positions.buffer,
      b.colors.buffer,
      b.intensity.buffer,
      b.classification.buffer,
    ]);
  });
}

/** 読み込みを実行し、結果を poster 経由で通知する。例外は 'error' メッセージに変換する。 */
export async function runLoad(req: LoadRequest, poster: Poster): Promise<void> {
  post = poster;
  const { id, budget } = req;
  try {
    const source = await openSource(req.source);
    const headBytes = await source.get(0, Math.min(HEADER_READ_BYTES, source.size));
    const header = parseHeader(headBytes.buffer as ArrayBuffer);
    const counter = { n: 0 };

    if (!header.compressed) {
      post({ type: 'header', id, header, mode: 'las' });
      await loadLas(id, source, header, budget, counter);
    } else if (header.copc) {
      post({ type: 'header', id, header, mode: 'copc' });
      await loadCopc(id, source, header, budget, counter);
    } else {
      if (source.size > MAX_WHOLE_LAZ_BYTES) {
        throw new Error(
          `通常の LAZ はファイル全体を展開する必要があるため ${(MAX_WHOLE_LAZ_BYTES / 1024 ** 3).toFixed(1)} GB までです。` +
            `大容量ファイルは COPC 形式に変換してください（例: pdal translate in.laz out.copc.laz）`,
        );
      }
      post({ type: 'header', id, header, mode: 'laz' });
      await loadLazWhole(id, source, header, budget, counter);
    }
    post({ type: 'done', id, loadedPoints: counter.n });
  } catch (e) {
    post({ type: 'error', id, message: describeError(e) });
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

// ---------------------------------------------------------------- LAS
async function loadLas(id: number, source: Source, header: LasHeader, budget: number, counter: { n: number }) {
  const len = header.pointLength;
  if (len < 20) throw new Error(`点レコード長が不正です (${len} bytes)`);
  if (header.pointDataOffset >= source.size) throw new Error(`点データのオフセットがファイルサイズを超えています (offset=${header.pointDataOffset}, size=${source.size})`);
  // ヘッダの点数が 0 / 過大な場合はファイルサイズから補正
  const byFileSize = Math.floor((source.size - header.pointDataOffset) / len);
  let total = header.pointCount;
  if (total === 0 || total > byFileSize) {
    post({ type: 'warn', id, message: `ヘッダの点数 (${total}) をファイルサイズから ${byFileSize} に補正しました` });
    total = byFileSize;
    header.pointCount = total;
  }
  const stride = Math.max(1, Math.floor(total / budget));
  const builder = makeBuilder(id, header, counter);
  const recPerChunk = Math.max(1, Math.floor((8 * 1024 * 1024) / len));
  let index = 0;
  let pos = header.pointDataOffset;
  while (index < total) {
    const n = Math.min(recPerChunk, total - index);
    const bytes = await source.get(pos, pos + n * len);
    const got = Math.floor(bytes.byteLength / len);
    if (got === 0) break;
    extractPoints(bytes, got, header, stride, index, builder);
    index += got;
    pos += got * len;
    post({ type: 'progress', id, fraction: index / total, points: counter.n });
  }
  builder.flush();
}

// ---------------------------------------------------------------- LAZ (whole file)
async function loadLazWhole(id: number, source: Source, header: LasHeader, budget: number, counter: { n: number }) {
  const lp = await getLazPerf();
  const size = source.size;
  const filePtr = lp._malloc(size);
  if (!filePtr) throw new Error(`WASM メモリを ${(size / 1024 ** 2).toFixed(0)} MB 確保できません。ファイルを COPC に変換するか、ブラウザを再起動してください`);
  // JS 側に全体のコピーを作らず、分割して WASM ヒープへ直接書き込む（ピークメモリ削減）
  const CHUNK = 64 * 1024 * 1024;
  for (let off = 0; off < size; off += CHUNK) {
    const part = await source.get(off, Math.min(size, off + CHUNK));
    lp.HEAPU8.set(part, filePtr + off);
    post({ type: 'progress', id, fraction: (off / size) * 0.1, points: 0 });
  }
  const zip = new lp.LASZip();
  try {
    zip.open(filePtr, size);
    const total = zip.getCount();
    const len = zip.getPointLength();
    const stride = Math.max(1, Math.floor(total / budget));
    const builder = makeBuilder(id, header, counter);
    const block = 65_536;
    const blockPtr = lp._malloc(block * len);
    try {
      let index = 0;
      while (index < total) {
        const n = Math.min(block, total - index);
        for (let i = 0; i < n; i++) zip.getPoint(blockPtr + i * len);
        const view = lp.HEAPU8.subarray(blockPtr, blockPtr + n * len);
        extractPoints(view, n, header, stride, index, builder);
        index += n;
        if ((index / block) % 8 === 0 || index === total) {
          post({ type: 'progress', id, fraction: 0.1 + 0.9 * (index / total), points: counter.n });
          await yieldToEventLoop();
        }
      }
      builder.flush();
    } finally {
      lp._free(blockPtr);
    }
  } finally {
    zip.delete();
    lp._free(filePtr);
  }
}

// ---------------------------------------------------------------- COPC
interface HierEntry {
  key: string;
  level: number;
  offset: number;
  byteSize: number;
  pointCount: number; // -1: 別ページへの参照
}

function parseHierarchyPage(buf: Uint8Array): HierEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: HierEntry[] = [];
  for (let p = 0; p + 32 <= buf.byteLength; p += 32) {
    const level = dv.getInt32(p, true);
    const x = dv.getInt32(p + 4, true);
    const y = dv.getInt32(p + 8, true);
    const z = dv.getInt32(p + 12, true);
    out.push({
      key: `${level}-${x}-${y}-${z}`,
      level,
      offset: Number(dv.getBigUint64(p + 16, true)),
      byteSize: dv.getInt32(p + 24, true),
      pointCount: dv.getInt32(p + 28, true),
    });
  }
  return out;
}

async function loadCopc(id: number, source: Source, header: LasHeader, budget: number, counter: { n: number }) {
  const info = header.copc!;
  const lp = await getLazPerf();

  // 階層を全て読み込む（ページ参照は再帰的に解決）。エントリ数はファイルサイズに比べ十分小さい。
  const nodes = new Map<string, HierEntry>();
  const loadPage = async (offset: number, size: number) => {
    const entries = parseHierarchyPage(await source.get(offset, offset + size));
    const pending: Promise<void>[] = [];
    for (const e of entries) {
      if (e.pointCount === -1) pending.push(loadPage(e.offset, e.byteSize));
      else nodes.set(e.key, e);
    }
    await Promise.all(pending);
  };
  await loadPage(info.rootHierOffset, info.rootHierSize);

  // レベル順に集計し、バジェット内で採用するレベル／間引き率を決める
  const byLevel = new Map<number, HierEntry[]>();
  for (const n of nodes.values()) {
    if (n.pointCount <= 0) continue;
    (byLevel.get(n.level) ?? byLevel.set(n.level, []).get(n.level)!).push(n);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const plan: { node: HierEntry; stride: number }[] = [];
  let remaining = budget;
  for (const lv of levels) {
    const list = byLevel.get(lv)!;
    const lvPoints = list.reduce((s, n) => s + n.pointCount, 0);
    if (lvPoints <= remaining) {
      for (const node of list) plan.push({ node, stride: 1 });
      remaining -= lvPoints;
    } else {
      if (remaining <= 0) break;
      const stride = Math.ceil(lvPoints / remaining);
      for (const node of list) plan.push({ node, stride });
      remaining = 0;
      break;
    }
  }
  post({ type: 'copcPlan', id, totalNodes: nodes.size, usedNodes: plan.length, maxLevel: plan.length ? plan[plan.length - 1].node.level : 0 });

  const builder = makeBuilder(id, header, counter);
  const len = header.pointLength;
  const decoder = new lp.ChunkDecoder();
  let done = 0;
  try {
    for (const { node, stride } of plan) {
      const compressed = await source.get(node.offset, node.offset + node.byteSize);
      const inPtr = lp._malloc(compressed.byteLength);
      const outPtr = lp._malloc(node.pointCount * len);
      try {
        lp.HEAPU8.set(compressed, inPtr);
        decoder.open(header.pointFormat, len, inPtr);
        for (let i = 0; i < node.pointCount; i++) decoder.getPoint(outPtr + i * len);
        const view = lp.HEAPU8.subarray(outPtr, outPtr + node.pointCount * len);
        extractPoints(view, node.pointCount, header, stride, 0, builder);
      } finally {
        lp._free(inPtr);
        lp._free(outPtr);
      }
      done++;
      if (done % 4 === 0 || done === plan.length) {
        post({ type: 'progress', id, fraction: done / plan.length, points: counter.n });
        await yieldToEventLoop();
      }
    }
    builder.flush();
  } finally {
    decoder.delete();
  }
}

function yieldToEventLoop() {
  return new Promise<void>((r) => setTimeout(r, 0));
}
