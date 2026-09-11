#!/usr/bin/env node
'use strict';

/**
 * build-masks.js
 * ------------------------------------------------------------------
 * 離線把「飄動物件 e」圖片庫每一張圖的碰撞遮罩算好，存成 masks.json，
 * 取代網站進站當下才即時算（甚至進站現查 Drive）的做法。
 *
 * 依賴 build-e-manifest.js 先跑過、產生 e-manifest.json + e-images/，
 * 這裡直接讀那份本地檔案，不用再打一次 Google Drive API。
 *
 * 演算法跟 index.html 前端 buildAlphaMaskFromSourceChunked() / finishMask()
 * 完全同一套（兩階段縮圖、格內多數決、輪廓點抽取），確保產出格式跟前端
 * requestAlphaMask() 讀取 masks.json 時預期的欄位（mask/w/h/boundary/
 * fullBBox）完全吻合。
 *
 * 用法：
 *   node scripts/build-masks.js
 *
 * 依賴 npm 套件：canvas（node-canvas，提供 Node.js 版的 Canvas 2D API）。
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'e-manifest.json');
const MASKS_PATH = path.join(OUTPUT_DIR, 'masks.json');

// 跟 index.html 裡「高畫質」那組常數完全一致（對應前端非低效能裝置的
// 那組數值）。離線預算不受裝置效能限制，直接用最高精細度即可——前端
// 不管使用者是不是低效能裝置，只要查表命中就會直接套用這份現成資料，
// 不會再自己重算，所以這裡值得用最好的畫質產生一次。
const PF_ALPHA_MASK_MAX_DIM = 72;
const PF_ALPHA_MASK_THRESHOLD = 10;
const PF_ALPHA_MASK_CELL_MAJORITY = 0.5;
const PF_ALPHA_MASK_FULL_CAP_DIM = 560;

function buildAlphaMask(image, naturalW, naturalH) {
  const fullScale = Math.min(1, PF_ALPHA_MASK_FULL_CAP_DIM / Math.max(naturalW, naturalH));
  const fullW = Math.max(1, Math.round(naturalW * fullScale));
  const fullH = Math.max(1, Math.round(naturalH * fullScale));
  const fullCanvas = createCanvas(fullW, fullH);
  const fullCtx = fullCanvas.getContext('2d');
  fullCtx.drawImage(image, 0, 0, fullW, fullH);
  const fullData = fullCtx.getImageData(0, 0, fullW, fullH).data;

  const scale = Math.min(1, PF_ALPHA_MASK_MAX_DIM / Math.max(fullW, fullH));
  const maskW = Math.max(2, Math.round(fullW * scale));
  const maskH = Math.max(2, Math.round(fullH * scale));
  const mask = new Uint8Array(maskW * maskH);

  let pxMinX = Infinity, pxMinY = Infinity, pxMaxX = -Infinity, pxMaxY = -Infinity;

  for (let my = 0; my < maskH; my++) {
    const sy0 = Math.floor(my * fullH / maskH);
    const sy1 = Math.max(sy0 + 1, Math.floor((my + 1) * fullH / maskH));
    for (let mx = 0; mx < maskW; mx++) {
      const sx0 = Math.floor(mx * fullW / maskW);
      const sx1 = Math.max(sx0 + 1, Math.floor((mx + 1) * fullW / maskW));
      let solidCount = 0, totalCount = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const rowBase = sy * fullW;
        for (let sx = sx0; sx < sx1; sx++) {
          totalCount++;
          if (fullData[(rowBase + sx) * 4 + 3] > PF_ALPHA_MASK_THRESHOLD) {
            solidCount++;
            if (sx < pxMinX) pxMinX = sx; if (sx > pxMaxX) pxMaxX = sx;
            if (sy < pxMinY) pxMinY = sy; if (sy > pxMaxY) pxMaxY = sy;
          }
        }
      }
      mask[my * maskW + mx] = (totalCount > 0 && solidCount / totalCount >= PF_ALPHA_MASK_CELL_MAJORITY) ? 1 : 0;
    }
  }

  const boundaryPts = [];
  for (let y = 0; y < maskH; y++) {
    const rowBase = y * maskW;
    for (let x = 0; x < maskW; x++) {
      if (mask[rowBase + x] !== 1) continue;
      const left = x > 0 ? mask[rowBase + x - 1] : 0;
      const right = x < maskW - 1 ? mask[rowBase + x + 1] : 0;
      const up = y > 0 ? mask[rowBase - maskW + x] : 0;
      const down = y < maskH - 1 ? mask[rowBase + maskW + x] : 0;
      if (left === 1 && right === 1 && up === 1 && down === 1) continue;
      boundaryPts.push((x + 0.5) / maskW, (y + 0.5) / maskH);
    }
  }

  const fullBBox = (pxMaxX >= pxMinX && pxMaxY >= pxMinY)
    ? { u0: pxMinX / fullW, u1: (pxMaxX + 1) / fullW, v0: pxMinY / fullH, v1: (pxMaxY + 1) / fullH }
    : null;

  return { mask: Array.from(mask), w: maskW, h: maskH, boundary: boundaryPts, fullBBox };
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`找不到 ${MANIFEST_PATH}，請先跑過 build-e-manifest.js。`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const images = Array.isArray(manifest.images) ? manifest.images : [];
  if (images.length === 0) {
    console.warn('e-manifest.json 沒有任何圖片，不產生 masks.json。');
    return;
  }

  const masks = {};
  for (const entry of images) {
    const filePath = path.join(OUTPUT_DIR, entry.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠ 找不到圖片檔案 ${entry.file}，略過 ${entry.id}`);
      continue;
    }
    console.log(`算遮罩 ${entry.id} (${entry.file}) ...`);
    try {
      const image = await loadImage(filePath);
      masks[entry.id] = buildAlphaMask(image, image.width, image.height);
    } catch (err) {
      console.warn(`  ⚠ 算遮罩失敗 ${entry.id}：${err.message}`);
    }
  }

  fs.writeFileSync(MASKS_PATH, JSON.stringify(masks));
  console.log(`完成：${Object.keys(masks).length} 張圖片，masks 寫入 ${MASKS_PATH}`);
}

main().catch(err => {
  console.error('build-masks.js 失敗：', err);
  process.exit(1);
});
