import DecodeWorker from './worker?worker&inline';
import type { LasHeader, PointBatch } from './format';
import type { LoadMode, WorkerMessage } from './messages';

export interface LoadHandlers {
  onHeader: (header: LasHeader, mode: LoadMode) => void;
  onCopcPlan?: (info: { totalNodes: number; usedNodes: number; maxLevel: number }) => void;
  onBatch: (batch: PointBatch) => void;
  onProgress: (fraction: number, points: number) => void;
  onWarn?: (message: string) => void;
  /** Worker が使えずメインスレッドで処理する場合に呼ばれる */
  onFallback?: (reason: string) => void;
}

/**
 * Worker を 1 ファイル 1 個立ち上げて読み込む（複数ファイルは並列に走る）。
 * Worker が起動できない環境（CSP で blob: Worker が禁止されたビューア等）では
 * メインスレッドで同じ処理を実行する。
 */
export function loadPointCloud(source: File | string, budget: number, h: LoadHandlers): { promise: Promise<number>; cancel: () => void } {
  let cancelled = false;
  let worker: Worker | null = null;
  let ready = false;

  const handle = (m: WorkerMessage, resolve: (n: number) => void, reject: (e: Error) => void) => {
    if (cancelled) return;
    switch (m.type) {
      case 'ready':
        ready = true;
        break;
      case 'warn':
        h.onWarn?.(m.message);
        break;
      case 'header':
        h.onHeader(m.header, m.mode);
        break;
      case 'copcPlan':
        h.onCopcPlan?.(m);
        break;
      case 'batch':
        h.onBatch(m.batch);
        break;
      case 'progress':
        h.onProgress(Number.isFinite(m.fraction) ? m.fraction : 0, m.points);
        break;
      case 'done':
        worker?.terminate();
        resolve(m.loadedPoints);
        break;
      case 'error':
        worker?.terminate();
        reject(new Error(m.message));
        break;
    }
  };

  const runInline = async (resolve: (n: number) => void, reject: (e: Error) => void, reason: string) => {
    h.onFallback?.(reason);
    const { runLoad } = await import('./decode');
    await runLoad({ type: 'load', id: 1, source, budget }, (m) => handle(m, resolve, reject));
  };

  const promise = new Promise<number>((resolve, reject) => {
    try {
      worker = new DecodeWorker();
    } catch (e) {
      void runInline(resolve, reject, `Worker を生成できません: ${(e as Error).message}`);
      return;
    }
    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => handle(ev.data, resolve, reject);
    worker.onerror = (e) => {
      const detail = e.message || '(詳細不明)';
      worker?.terminate();
      if (!ready) {
        // 起動前のエラー = Worker 自体が動かない環境 → メインスレッドで実行
        worker = null;
        void runInline(resolve, reject, `Worker を起動できませんでした (${detail})`);
      } else {
        reject(new Error(`Worker が異常終了しました: ${detail}。メモリ不足の可能性があります。表示点数上限を下げて再読込してください`));
      }
    };
    worker.postMessage({ type: 'load', id: 1, source, budget });
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      worker?.terminate();
    },
  };
}
