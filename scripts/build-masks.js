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
 * ---------- 精細度：離線不受即時運算的效能限制，網格解析度大幅拉高 ----------
 * 前端「即時運算」那組常數（PF_ALPHA_MASK_MAX_DIM=72／FULL_CAP_DIM=560）
 * 是為了「使用者剛進站、瀏覽器主執行緒還在忙其他事」這個情境妥協出來的
 * 數字，網格太粗，遇到弧形、斜角輪廓時，格子邊界跟實際去背邊緣之間會有
 * 明顯落差，畫面上看起來就是「碰撞邊界跟圖案本身之間留了一圈白邊」。
 * 這裡是離線批次跑、沒有使用者在等、GitHub Actions 的執行時間也綽綽有餘，
 * 直接把網格解析度拉高到原本的 3 倍見方（約 9 倍格數），弧形/斜角邊緣的
 * 階梯感會明顯變細，貼合度大幅提升。
 *
 * ---------- 邊緣門檻：同時調高「怎樣算實心」的 alpha 判斷標準 ----------
 * 圖片邊緣做去背時常會留一圈半透明的反鋸齒像素（alpha 介於 0～255 之間，
 * 不是非黑即白）。前端沿用的門檻（alpha>10 就算「有畫到東西」）是給裁切
 * 留白用的，門檻刻意放得很寬鬆，避免把圖案邊緣的反鋸齒淡色像素也一併
 * 裁掉；但拿同一個寬鬆門檻來決定「遮罩要不要把這一格算進碰撞範圍」，
 * 就會把那一整圈肉眼看起來偏白、幾乎透明的反鋸齒像素也算進「實心」
 * 範圍，遮罩因此比視覺上看到的圖案邊緣還要再往外凸出一圈——這正是
 * 「白邊」的另一個成因（不是只有網格太粗）。
 * 這裡把「算不算實心」的門檻大幅拉高（PF_ALPHA_MASK_THRESHOLD），只有
 * 真正視覺上「看起來是圖案本身」的像素才會被算進遮罩，那一圈半透明的
 * 反鋸齒像素會被視為背景，邊界因此收得更貼近肉眼實際看到的輪廓。
 * 注意：這個門檻只影響「遮罩要不要把這一格標記為實心」，不影響下面
 * trimToVisibleCanvas() 用來裁掉四周留白、決定座標系統的那個門檻
 * （TRIM_ALPHA_THRESHOLD）——那個門檻必須跟 index.html 的 trimLoadedImage()
 * 完全一致才不會座標系統對不上，這裡沒有動它。
 *
 * ---------- 檔案體積：mask 欄位改成「位元打包」的 base64 字串 ----------
 * 網格解析度拉高到 9 倍，如果還是「每一格存一個 JSON 數字」，masks.json
 * 體積會跟著等比例膨脹。既然每一格只有 0/1 兩種值，改成 1 個 bit 表示、
 * 8 格塞進 1 個 byte，再整包轉成 base64 字串存進 JSON——同樣格數，檔案
 * 大小大約只剩「數字陣列」寫法的 1/20 左右。對應地，index.html 那邊多了
 * 一個 decodeMaskBits() 把這個字串還原成原本的 0/1 陣列，其餘既有程式碼
 * 完全不用再改。
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

// 跟 index.html 的 trimLoadedImage() 用同一個門檻——這個絕對不能跟前端
// 不一致，否則裁切留白用的座標系統會跟前端對不上（完整理由見上面說明）。
const TRIM_ALPHA_THRESHOLD = 10;
// 跟 index.html 的 estimateEdgeBackgroundColor()／DVD_TRIM_BG_COLOR_THRESHOLD
// 同一組數值：處理「素材本身沒有去背、是純色背景畫布」的備援情況。
const TRIM_BG_COLOR_THRESHOLD = 26;

// ---------- 離線精細度設定（可依需要再調） ----------
// MAX_DIM：遮罩網格最長邊的格數。72 → 220，約 3 倍見方、9 倍格數。
// FULL_CAP_DIM：算遮罩之前，圖片本身先縮放到的最長邊像素數，理論上只要
// 不小於 MAX_DIM 太多就有意義；這裡抓到接近 e-images 實際下載解析度
// （build-e-manifest.js 預設 IMAGE_SIZE=1000）附近，不用再更高、沒有意義
// （來源本身就沒那麼多細節可以榨）。
const PF_ALPHA_MASK_MAX_DIM = 220;
const PF_ALPHA_MASK_FULL_CAP_DIM = 1200;
// 邊緣門檻拉高：只有明顯不透明（>140／255）才算實心，把半透明反鋸齒的
// 描邊像素排除在碰撞範圍外，邊界貼得更緊、白邊更不明顯。可依實測效果
// 微調：數字越高，碰撞範圍收得越裡面（更保守，寧可貼合本體、犧牲一點點
// 最邊緣的細毛/羽化細節）；數字越低，越接近原本寬鬆的判斷。
const PF_ALPHA_MASK_THRESHOLD = 140;
const PF_ALPHA_MASK_CELL_MAJORITY = 0.5;

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

// 把 Uint8Array（每格一個 0/1）打包成「8 格塞 1 byte」的 base64 字串——
// 對應 index.html 的 decodeMaskBits()，位元順序（LSB-first）兩邊要一致。
function packMaskBits(mask) {
  const n = mask.length;
  const bytes = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) {
    if (mask[i]) bytes[i >> 3] |= (1 << (i & 7));
  }
  return Buffer.from(bytes).toString('base64');
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

  return { mask: packMaskBits(mask), w: maskW, h: maskH, boundary: boundaryPts, fullBBox };
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
