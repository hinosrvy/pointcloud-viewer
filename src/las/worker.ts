/**
 * 点群読み込み Worker。実処理は decode.ts。
 * 起動直後に 'ready' を送り、メインスレッド側で Worker が起動できたか判定できるようにする。
 */
import { runLoad } from './decode';
import type { LoadRequest, WorkerMessage } from './messages';

const ctx: Worker = self as unknown as Worker;
const post = (msg: WorkerMessage, transfer?: Transferable[]) => ctx.postMessage(msg, transfer ?? []);

// 想定外の例外も必ずメッセージとして返す（file:// 由来だとエラー内容が伏せられるため）
self.addEventListener('error', (ev) => {
  post({ type: 'error', id: 0, message: `Uncaught: ${ev.message} (${ev.filename}:${ev.lineno})` });
});
self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  post({ type: 'error', id: 0, message: `Unhandled rejection: ${ev.reason instanceof Error ? ev.reason.message : String(ev.reason)}` });
});

ctx.onmessage = (ev: MessageEvent<LoadRequest>) => {
  if (ev.data.type === 'load') void runLoad(ev.data, post);
};

post({ type: 'ready', id: 0 });
