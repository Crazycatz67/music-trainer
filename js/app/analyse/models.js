// models.js — the one list of what the song analysis downloads, from where, how big, and
// under which licence. Pure data: imports in Node (tools/fetch-analyse-models.mjs reads it).
//
// Why a list with pins: the page must be able to tell the visitor the exact download size
// BEFORE the press that starts it, and a model that changed upstream must fail loudly (wrong
// sha256) instead of quietly giving different numbers than the ones measured in the lab.
// Every URL names a fixed revision, never "main".
//
// CONTRACT
//   MODELS.<id> = { name, licence, source, base, dir, files: [{ name, bytes, sha256 }] }
//     base + file.name   the pinned public URL
//     dir                folder under tools/.cache/models/ for the local test copy
//   modelBytes(id)       -> total bytes of that model
//   megabytes(bytes)     -> "126 MB" style text for buttons (decimal megabytes, as browsers show)

const HTDEMUCS_REV = 'a4a57cc0cf707e5b9a3e6ad3c2c4b21fcbe608c1';   // Hugging Face, 2026-07-07
const SWIFTF0_REV = 'd1ba77fe5331310b778ebe126b6cb3656d41d24f';    // GitHub, 2026-09-25

const piece = (i, bytes, sha256) => ({ name: `htdemucs_p${String(i).padStart(2, '0')}.onnx`, bytes, sha256 });

export const MODELS = Object.freeze({
  htdemucs: {
    name: 'HTDemucs (mixed precision, 21 pieces)',
    licence: 'MIT (weights: Meta AI demucs; this export: monteslu)',
    source: 'https://huggingface.co/monteslu/htdemucs-web-onnx',
    base: `https://huggingface.co/monteslu/htdemucs-web-onnx/resolve/${HTDEMUCS_REV}/`,
    dir: 'htdemucs',
    files: [
      { name: 'htdemucs_split_manifest.json', bytes: 5318, sha256: '3b8f5089fa43b9483b816c837d69a955aeb8d0fb88bc8a0b57b778c1e9005768' },
      piece(0, 28110, 'dc981b294afd05180890334d7a1994bd01af049c828634f5e9589c996baf9342'), piece(1, 16551977, 'a3dbe16bfa14cc438bc9906e7949658794d4df8a23260815d4ebc7bbaa0e2cba'), piece(2, 293808, '2dd65ec05b6d1b3eba32394b7c39c3081d7086542373a5011e01a414b4f8504e'), piece(3, 6207085, 'e306ad650ef8f41c34f5c68b0f25fbc2d9944ebecc810dddfd00e96f9370bf82'),
      piece(4, 21052, 'b67b06ddbacdce6d25f3c2390018b1c3cac81124e85e99abeaab223b7a5ea4bd'), piece(5, 36401, '72800f59b4897a8d4768ae89a60712c24c3b35528348b6d3298a53cceed1df2a'), piece(6, 293435, '3a13a16ba15a5a6b1afb99597ab4dc72333d002d634964017244b46fec14be7d'), piece(7, 6205601, '745602c473ea3887e483fd2ced4ed191356294c9591d0cf595c9cf048c81ebf1'),
      piece(8, 16789948, '9885a20cd42090b0033c2dc9be4f236b15e930896d0040caf684f0600402e0a0'), piece(9, 12663168, 'c477f4ce84e2a936effab2a2c6260dba42a4062e02fddeb5f18afe1d2c757615'), piece(10, 12656234, '56cc39a9bb812a5cd4daefe0a0d903dc7b752866d88694b4e7063dcf764a6060'), piece(11, 12663251, '6bbb50b8afe31ea1dce6c9c2a5025d5dd35a05331841eeeade983ac443b21e09'),
      piece(12, 12655956, '857583f4618a255f675cb146aef3276cf3aca682a0df34c05c2913ef6197ed50'), piece(13, 22007636, 'a72774f04ee131596066c9768f430f8671e85635a44b56972310e368a3a5f71b'), piece(14, 5149584, '90542229d4662c01e428282838d1b39b840dfce7f2081a4ac5157e7b6fd3b6e3'), piece(15, 884773, 'e46d3a24d84627ed85b13328a07e2717a9ddfdfb7fe8e318739d08db022b97c3'),
      piece(16, 441716, '1f4acdec85a277613cc7929d4f51601ce0a58bee5f77034f437192b7a8db0d66'), piece(17, 184145, '396a306a69ab388eb4b6773106c10862bb3249808109144c2d8e9b49c1d28988'), piece(18, 43437, '488d9cb2672cb1211a719a9170c76eef1cf1d278d832f8a756ce4cfa85836346'), piece(19, 73203, '331d197571f917b752416592b3cc776ede027a87258adf461d65bfd5753db327'),
      piece(20, 30725, 'b7acdfcda80ca8d1f23768af12ec8b93d5b46d5f3918629859380ee5d864777e'),
    ],
  },
  swiftf0: {
    name: 'SwiftF0',
    licence: 'MIT (lars76)',
    source: 'https://github.com/lars76/swift-f0',
    base: `https://raw.githubusercontent.com/lars76/swift-f0/${SWIFTF0_REV}/swift_f0/`,
    dir: 'swiftf0',
    files: [{ name: 'model.onnx', bytes: 135090, sha256: '6385e8c2ebc3872e82c9ff5946228de44cd3be77a750ea53698b7dbfe94b0a22' }],
  },
});

export function modelBytes(id) {
  return MODELS[id].files.reduce((sum, f) => sum + f.bytes, 0);
}

export function megabytes(bytes) {
  const mb = bytes / 1e6;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}
