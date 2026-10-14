# three.js 0.161.0 (r161), vendored and pinned

No build step in this project, so the one file the sky dome needs is kept here.

| | |
| --- | --- |
| File | `three.module.min.js` (675,320 bytes), **byte-for-byte upstream, no local changes** |
| Taken from | the official npm package: https://registry.npmjs.org/three/-/three-0.161.0.tgz, path `package/build/three.module.min.js` |
| Fetched | 2026-10-12 |
| File sha256 | `8da856fd9ddfe38fdb286da04bc1d85f3bf108bf083e0eac71cd276ec6674030` (base64 `jahW/Z3f44/bKG2gS8HYXzvxCL8IPg6scc0nbsZnQDA=`, the value unpkg lists for this file) |
| npm tarball | sha1 `38aafaa82fe5467fde2e33933515d1b6beb17d91`, sha512 `LC28VFtjbOyEu5b93K0bNRLw1rQlMJ85lilKsYj6dgTu+7i17W+JCCEbvrpmNHF1F3NAUqDSWq50UD7w9H2xQw==` (both equal the registry's own `dist` record) |
| Licence | MIT, `LICENSE` beside this file (the package's own copy); the file also carries its `@license` header |
| Used by | `js/app/dome.js` only, loaded with a dynamic `import()` after first paint. `tools/checks/skymap.check.mjs` imports it in Node to prove the label maths agrees with the camera. |

The hash is recorded here and not in a header added to the file, so the file stays
identical to upstream and anyone can re-check it:

    shasum -a 256 vendor/three-0.161.0/three.module.min.js

No add-ons are vendored (no controls, no post-processing, no `CSS2DRenderer`).
