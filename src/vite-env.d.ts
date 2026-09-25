/// <reference types="vite/client" />
/// <reference types="emscripten" />
declare module '*.wasm?url' { const url: string; export default url; }
