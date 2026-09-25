import type { LasHeader, PointBatch } from './format';

export interface LoadRequest {
  type: 'load';
  id: number;
  source: File | string;
  budget: number;
}

export type LoadMode = 'las' | 'laz' | 'copc';

export type WorkerMessage =
  | { type: 'ready'; id: number }
  | { type: 'warn'; id: number; message: string }
  | { type: 'header'; id: number; header: LasHeader; mode: LoadMode }
  | { type: 'copcPlan'; id: number; totalNodes: number; usedNodes: number; maxLevel: number }
  | { type: 'batch'; id: number; batch: PointBatch }
  | { type: 'progress'; id: number; fraction: number; points: number }
  | { type: 'done'; id: number; loadedPoints: number }
  | { type: 'error'; id: number; message: string };
