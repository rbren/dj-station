#!/usr/bin/env node
// Vendors the MediaPipe hand-tracking runtime into app/public/mediapipe/
// so the packaged app never loads it from a CDN (PRD R-2: a synth that
// requires internet access to open a patch is broken).
//
//  - The WASM runtime + JS loaders come from the npm package
//    @mediapipe/tasks-vision (version pinned by package-lock.json) and
//    are copied out of node_modules.
//  - The hand_landmarker .task model is not shipped on npm; it is
//    downloaded once from the pinned (versioned, not "latest") Google
//    storage URL and verified against a pinned SHA-256. Re-runs are
//    offline no-ops when the file already matches.
//
// Vite copies public/ into dist/, which tauri::generate_context! embeds,
// so at runtime everything resolves locally under /mediapipe/.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmSrc = join(appDir, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const outDir = join(appDir, 'public', 'mediapipe');
const wasmOut = join(outDir, 'wasm');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MODEL_SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';
const modelOut = join(outDir, 'hand_landmarker.task');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

mkdirSync(wasmOut, { recursive: true });

if (!existsSync(wasmSrc)) {
  console.error('fetch-mediapipe-assets: @mediapipe/tasks-vision not installed (run npm ci)');
  process.exit(1);
}
for (const f of readdirSync(wasmSrc)) {
  copyFileSync(join(wasmSrc, f), join(wasmOut, f));
}

if (existsSync(modelOut) && sha256(readFileSync(modelOut)) === MODEL_SHA256) {
  console.log('fetch-mediapipe-assets: model up to date');
} else {
  console.log(`fetch-mediapipe-assets: downloading ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    console.error(`fetch-mediapipe-assets: download failed (${res.status})`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== MODEL_SHA256) {
    console.error(`fetch-mediapipe-assets: sha256 mismatch: got ${got}, want ${MODEL_SHA256}`);
    process.exit(1);
  }
  writeFileSync(modelOut, buf);
  console.log(`fetch-mediapipe-assets: model written (${buf.length} bytes)`);
}
console.log(`fetch-mediapipe-assets: vendored into ${outDir}`);
