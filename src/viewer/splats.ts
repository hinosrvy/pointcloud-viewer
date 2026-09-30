import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';

// ガウシアンスプラット（3DGS）の読み込み（Issue #12）。
// 調査結果: docs/research/12-gaussian-splatting.md

export interface LoadedSplat {
  mesh: SplatMesh;
  /** ファイル座標での範囲（スプラット中心） */
  localBox: THREE.Box3;
  splatCount: number;
}

/**
 * バイト列から SplatMesh を生成し、デコード完了を待つ。形式は fileName の拡張子から Spark が判定する。
 * 標準形式は中心座標を float16 で持ち、実座標（数万 m）では位置が破綻するため、常に extSplats（float32）を使う。
 */
export async function loadSplatMesh(bytes: Uint8Array, fileName: string): Promise<LoadedSplat> {
  const mesh = new SplatMesh({ fileBytes: bytes, fileName, extSplats: true });
  try {
    await mesh.initialized;
  } catch (e) {
    mesh.dispose();
    throw new Error(`3DGS ファイルを読み込めません（${(e as Error).message ?? e}）`);
  }
  const splatCount = mesh.extSplats?.numSplats ?? mesh.packedSplats?.numSplats ?? 0;
  if (splatCount === 0) {
    mesh.dispose();
    throw new Error('3DGS ファイルにスプラットが含まれていません');
  }
  return { mesh, localBox: mesh.getBoundingBox(true), splatCount };
}
