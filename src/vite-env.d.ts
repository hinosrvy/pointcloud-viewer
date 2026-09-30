/// <reference types="vite/client" />
/// <reference types="emscripten" />
declare module '*.wasm?url' { const url: string; export default url; }

// vite.config.ts の define で埋め込まれるビルド時定数（Issue #9）
declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;
declare const __BUILD_DATE__: string;
