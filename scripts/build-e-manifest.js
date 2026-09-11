#!/usr/bin/env node
'use strict';

/**
 * build-e-manifest.js
 * ------------------------------------------------------------------
 * 離線把「飄動物件 e」圖片庫（Google Drive 資料夾 EDEN_E_FOLDER_ID）
 * 整批下載下來，存成靜態檔案 + manifest.json，取代網站進站當下才打
 * Drive API 現查的做法。
 *
 * 產出（相對於 repo 根目錄）：
 *   - e-images/<driveFileId>.<ext>   每張圖片本體
 *   - e-manifest.json                {generatedAt, folderId, images:[{id,file,contentType}]}
 *
 * id 刻意沿用原始 Google Drive file id 當 key——這樣 masks.json
 * （build-masks.js 離線算好、放在同一個 Drive 資料夾的碰撞遮罩）完全
 * 不用重新產生，前端 requestAlphaMask() 現有的「file id 查表」邏輯
 * 原封不動就能繼續吃到離線預算好的遮罩資料。
 *
 * 用法：
 *   GOOGLE_API_KEY=xxxx node scripts/build-e-manifest.js
 *
 * 可選環境變數：
 *   EDEN_E_FOLDER_ID   （預設沿用網站現在用的那個資料夾 id）
 *   OUTPUT_DIR         （預設是目前工作目錄，也就是 repo 根目錄）
 *   IMAGE_SIZE         （縮圖尺寸，預設 1000，對應網站目前實際顯示需求，見 index.html fetchDvdEImages() 內的完整說明）
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const EDEN_E_FOLDER_ID = process.env.EDEN_E_FOLDER_ID || '1QXgbx5t6KC5q07gyhGL6tXqo_YUKzpKH';
const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();
const IMAGE_SIZE = process.env.IMAGE_SIZE || '1000';

const IMAGES_DIR = path.join(OUTPUT_DIR, 'e-images');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'e-manifest.json');

if (!GOOGLE_API_KEY) {
  console.error('缺少 GOOGLE_API_KEY 環境變數，中止。');
  process.exit(1);
}

async function listDriveFiles() {
  const q = encodeURIComponent(
    `'${EDEN_E_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`
  );
  // 跟 index.html 的 fetchDvdEImages() 要同一組欄位：id 用來當 manifest 的
  // key（也是 masks.json 查表用的 key），thumbnailLink 用來組出圖片下載網址。
  const fields = encodeURIComponent('files(id,thumbnailLink)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=name&key=${GOOGLE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive files.list 失敗：${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.files || [];
}

function extFromContentType(contentType) {
  if (!contentType) return 'jpg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg'; // Drive 的 thumbnailLink 預設多半回 jpeg
}

async function downloadOne(file) {
  if (!file.thumbnailLink) {
    console.warn(`  ⚠ ${file.id} 沒有 thumbnailLink，略過（跟現行網站的備援行為不同，需要人工確認這個檔案）`);
    return null;
  }
  const thumbBase = file.thumbnailLink.replace(/=s\d+$/, '');
  const downloadUrl = `${thumbBase}=s${IMAGE_SIZE}`;

  const res = await fetch(downloadUrl);
  if (!res.ok) {
    console.warn(`  ⚠ 下載失敗 ${file.id}：${res.status} ${res.statusText}`);
    return null;
  }
  const contentType = res.headers.get('content-type') || '';
  const ext = extFromContentType(contentType);
  const buf = Buffer.from(await res.arrayBuffer());

  const fileName = `${file.id}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, fileName), buf);

  return { id: file.id, file: `e-images/${fileName}`, contentType: contentType || null };
}

async function main() {
  console.log(`列出 Drive 資料夾 ${EDEN_E_FOLDER_ID} 內的圖片...`);
  const files = await listDriveFiles();
  console.log(`找到 ${files.length} 個檔案。`);

  if (files.length === 0) {
    console.warn('資料夾是空的或查不到，不動 e-manifest.json / e-images/，中止。');
    return;
  }

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const images = [];
  const currentIds = new Set();
  for (const file of files) {
    console.log(`下載 ${file.id} ...`);
    const entry = await downloadOne(file);
    if (entry) {
      images.push(entry);
      currentIds.add(entry.id);
    }
  }

  // 清掉 Drive 資料夾裡已經刪除、但上次還留在 e-images/ 裡的舊檔案，
  // 避免 repo 裡越積越多用不到的圖。只清「檔名看起來像 <driveId>.<ext>
  // 且 id 已經不在這次清單裡」的檔案，不動其他非本腳本產生的檔案。
  const existing = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : [];
  for (const name of existing) {
    const id = name.replace(/\.[a-z0-9]+$/i, '');
    if (!currentIds.has(id)) {
      console.log(`清除已下架的圖片：${name}`);
      fs.unlinkSync(path.join(IMAGES_DIR, name));
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    folderId: EDEN_E_FOLDER_ID,
    images,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`完成：${images.length} 張圖片，manifest 寫入 ${MANIFEST_PATH}`);
}

main().catch(err => {
  console.error('build-e-manifest.js 失敗：', err);
  process.exit(1);
});
