# onnxruntime-web 1.30.0, vendored and pinned

No build step in this project, so the files the song analysis needs are kept here. They run
the neural models (vocal separation, pitch) in the browser. **41.2 MB in all**, of which two
WebAssembly files are 41.0 MB: decide before merging whether the repo should carry them
(the alternative is loading the same pinned files from a public CDN after the visitor's press).

| | |
| --- | --- |
| Taken from | the official npm package: https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz, path `package/dist/` |
| Fetched | 2026-10-12 |
| npm tarball | sha1 `b88b09117992e6f486321e931a826fd2f7775377` (equals the registry's `dist.shasum`), sha256 `d2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71` |
| Changes | none: all six files are **byte-for-byte upstream** |
| Licence | MIT (Microsoft Corporation). The npm package ships no licence file; `LICENSE` here is https://github.com/microsoft/onnxruntime/blob/v1.30.0/LICENSE |
| Used by | `js/app/analyse/separate.js` (`loadOrt`), loaded with a dynamic `import()` only after the visitor presses Download in `labs/analyse-lab.html`. Nothing in the app loads it. |

| File | Bytes | sha256 |
| --- | --- | --- |
| `ort.webgpu.min.mjs` | 66,349 | `3dffff71811bc13a3a3d9591c57ca5ee5735b8f5f3eaf789510b02bb040ae3a0` |
| `ort-wasm-simd-threaded.asyncify.mjs` | 53,057 | `3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28` |
| `ort-wasm-simd-threaded.asyncify.wasm` | 26,781,914 | `39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da` |
| `ort.wasm.min.mjs` | 50,126 | `219e6a1fc8a9938268d18efca3c91d310bd2f4a59bbd13744df5b2b7fc6cee3b` |
| `ort-wasm-simd-threaded.mjs` | 24,381 | `e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b` |
| `ort-wasm-simd-threaded.wasm` | 14,239,897 | `3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2` |

Re-check with `shasum -a 256 vendor/onnxruntime-web-1.30.0/*`.

## Why two builds

Measured in Chrome 154 on 2026-10-12; neither build does both jobs.

- **`ort.webgpu` + `asyncify`** runs HTDemucs on WebGPU. It is the only build that accepts
  `forceCpuNodeNames`, which the model needs (its input normalisation gives NaN in half
  precision on the GPU). Its CPU side cannot open SwiftF0:
  `Could not find an implementation for Cast(13)`.
- **`ort.wasm` + plain wasm** runs SwiftF0 (the second pitch reader) on the CPU. It has no
  WebGPU. Dropping SwiftF0 drops these three files (14.3 MB).

The `.mjs` files end in a `sourceMappingURL` comment; the maps are not vendored, so browser
developer tools may log a missing map. That is harmless.

## Threads

WebAssembly threads need a cross-origin isolated page (`Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers). `serve.py` does not send them, so the CPU paths run
on one thread. WebGPU does not need them.

## The models are not here

Model files are never in the repo. Their pinned URLs, sizes, sha256 and licences are in
`js/app/analyse/models.js`; `node tools/fetch-analyse-models.mjs` downloads a test copy into
the git-ignored `tools/.cache/models/`.
