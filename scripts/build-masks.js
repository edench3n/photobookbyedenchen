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
 * ---------- 修正：遮罩座標系統跟前端「裁切後的圖」對不上 ----------
 * 前端流程是「先用 trimLoadedImage() 裁掉圖片四周的透明留白，再對裁切
 * 後的那張小圖算遮罩」（見 index.html 的 trimLoadedImage() / 
 * requestAlphaMask() 說明），遮罩的正規化座標（0~1）因此是相對「裁切後
 * 的框」，不是相對「原始、還帶著留白的整張圖」。
 * 這裡如果直接對 e-images/ 裡還沒裁切的原始圖算遮罩，兩邊座標系統會對
 * 不上：同樣是 0~1，一個框是裁切後的小框、一個是還帶著留白的大框，
 * 套到畫面上遮罩範圍就會跑位、往外多凸出一圈，導致碰撞判斷提早重疊
 * （肉眼看到的症狀是「圖案明明還沒真的碰到，就已經疊在一起」）。
 * 修法：算遮罩之前，先做跟前端 trimLoadedImage() 完全同一步「掃描 alpha
 * 找出最小可視範圍、裁掉四周留白」，再對裁切後的圖算遮罩，兩邊座標系統
 * 才會一致。
 *
 * 演算法（裁切門檻、遮罩兩階段縮圖、格內多數決、輪廓點抽取）都跟
 * index.html 前端 trimLoadedImage() / buildAlphaMaskFromSourceChunked() /
 * finishMask() 完全同一套，確保產出格式、座標系統都跟前端 requestAlphaMask()
 * 讀取 masks.json 時預期的完全吻合。
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

// 跟 index.html 的 trimLoadedImage() 用同一個門檻：alpha 大於這個值才算
// 「真的有畫到東西」，忽略幾乎透明的雜訊殘留像素。
const TRIM_ALPHA_THRESHOLD = 10;
// 跟 index.html 的 estimateEdgeBackgroundColor()／DVD_TRIM_BG_COLOR_THRESHOLD
// 同一組數值：處理「素材本身沒有去背、是純色背景畫布」的備援情況。
const TRIM_BG_COLOR_THRESHOLD = 26;

// 跟 index.html 裡「高畫質」那組常數完全一致（對應前端非低效能裝置的
// 那組數值）。離線預算不受裝置效能限制，直接用最高精細度即可——前端
// 不管使用者是不是低效能裝置，只要查表命中就會直接套用這份現成資料，
// 不會再自己重算，所以這裡值得用最好的畫質產生一次。
const PF_ALPHA_MASK_MAX_DIM = 72;
const PF_ALPHA_MASK_THRESHOLD = 10;
const PF_ALPHA_MASK_CELL_MAJORITY = 0.5;
const PF_ALPHA_MASK_FULL_CAP_DIM = 560;

// 從圖片四個邊框取樣顏色，統計出現次數最多的顏色當作背景色估計值——
// 跟 index.html 的 estimateEdgeBackgroundColor() 同一套邏輯。
function estimateEdgeBackgroundColor(data, w, h) {
  const counts = new Map();
  const step = Math.max(1, Math.floor(Math.min(w, h) / 60));
  function sample(x, y) {
    const idx = (y * w + x) * 4;
    const key = (data[idx] << 16) | (data[idx + 1] << 8) | data[idx + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
  let bestKey = null, bestCount = -1;
  counts.forEach((count, key) => { if (count > bestCount) { bestCount = count; bestKey = key; } });
  if (bestKey === null) return null;
  return { r: (bestKey >> 16) & 255, g: (bestKey >> 8) & 255, b: bestKey & 255 };
}

// 把原始圖片裁到「實際可視範圍」——先看 alpha 透明度，整張圖都不透明
// （素材本身沒去背，是純色背景畫布）才退回用背景色估計來裁。回傳裁切
// 後的 canvas；裁不到（整張都是背景/透明）就回傳 null，呼叫端維持用
// 原圖，不強制裁出一個空範圍。
function trimToVisibleCanvas(image, w, h) {
  const srcCanvas = createCanvas(w, h);
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(image, 0, 0, w, h);
  const data = srcCtx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  let hasRealTransparency = false;
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[rowBase + x * 4 + 3] <= TRIM_ALPHA_THRESHOLD) {
        hasRealTransparency = true;
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null; // 整張都透明，極端情況，交給呼叫端退回原圖

  // 整張圖從頭到尾沒有一個像素真正透明（hasRealTransparency 是 false，
  // 代表上面那輪找到的範圍必然等於整張圖）——退回用背景色估計再裁一次。
  if (!hasRealTransparency) {
    const bg = estimateEdgeBackgroundColor(data, w, h);
    if (bg) {
      let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
      for (let y = 0; y < h; y++) {
        const rowBase = y * w * 4;
        for (let x = 0; x < w; x++) {
          const idx = rowBase + x * 4;
          const dr = data[idx] - bg.r, dg = data[idx + 1] - bg.g, db = data[idx + 2] - bg.b;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist <= TRIM_BG_COLOR_THRESHOLD) continue; // 判定為背景的一部分
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
      if (bx1 >= bx0 && by1 >= by0) {
        minX = bx0; minY = by0; maxX = bx1; maxY = by1;
      }
    }
  }

  // 裁切範圍等於整張圖，代表本來就沒有留白可裁，直接回傳 null，呼叫端
  // 維持用原圖即可，不需要多包一層 canvas。
  if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return null;

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const outCanvas = createCanvas(cropW, cropH);
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(srcCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  return outCanvas;
}

function buildAlphaMask(source, naturalW, naturalH) {
  const fullScale = Math.min(1, PF_ALPHA_MASK_FULL_CAP_DIM / Math.max(naturalW, naturalH));
  const fullW = Math.max(1, Math.round(naturalW * fullScale));
  const fullH = Math.max(1, Math.round(naturalH * fullScale));
  const fullCanvas = createCanvas(fullW, fullH);
  const fullCtx = fullCanvas.getContext('2d');
  fullCtx.drawImage(source, 0, 0, fullW, fullH);
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
      // 先裁掉四周留白，遮罩座標系統才會跟前端「裁切後的圖」一致（完整
      // 理由見檔案開頭的說明）；裁不到（整張圖本來就沒有留白）就直接用
      // 原圖，行為等同前端 trimLoadedImage() 的對應分支。
      const trimmed = trimToVisibleCanvas(image, image.width, image.height);
      const source = trimmed || image;
      const w = trimmed ? trimmed.width : image.width;
      const h = trimmed ? trimmed.height : image.height;
      masks[entry.id] = buildAlphaMask(source, w, h);
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
