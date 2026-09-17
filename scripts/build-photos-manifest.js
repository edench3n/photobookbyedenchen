#!/usr/bin/env node
'use strict';

/**
 * build-photos-manifest.js
 * ------------------------------------------------------------------
 * 離線把「首頁照片牆」用的 Google Drive 資料夾（PHOTOBOOK_FOLDER_ID）
 * 整批下載下來，存成靜態檔案 + manifest，取代網站進站當下才打 Drive
 * API 現查（fetchDriveImages()）的做法。跟 build-e-manifest.js 同一套
 * 慣例，差別是：飄動物件只需要一種尺寸，這裡照片牆一張照片要同時支援
 * 網格縮圖、hover 大圖、detail 大圖（含手機版）、preview 跳轉頁（含
 * 手機/桌機版）、備援圖，共 8 種尺寸，所以一張來源照片會產生 8 個檔案。
 *
 * 產出（相對於 repo 根目錄）：
 *   - photos/<driveFileId>-<size>.<ext>   每張照片、每種尺寸各一份
 *   - photos-manifest.json                {generatedAt, folderId, photos:[...]}
 *
 * manifest 裡每個 photos[] 項目的 files 欄位對應到 index.html
 * fetchDriveImages() 原本回傳物件的哪個尺寸：
 *   grid           -> gridUrl        (380px 首頁網格縮圖)
 *   tiny           -> tinyUrl        (450px preview 跳轉最後備援)
 *   thumb          -> thumbUrl       (750px hover 大圖預覽)
 *   previewMobile  -> previewUrl     (850px，手機版 preview 跳轉頁)
 *   previewDesktop -> previewUrl     (1500px，桌機/平板版 preview 跳轉頁)
 *   detailMobile   -> detailUrlMobile(1200px，手機版大圖詳細頁)
 *   detail         -> detailUrl / url(2000px，桌機大圖詳細頁，也當作
 *                                      畫質最高的可用版本，不再另外抓
 *                                      Drive 原始檔——原始檔案常常是
 *                                      好幾 MB 的相機直出，塞進 repo
 *                                      只會拖慢 clone/部署，2000px CDN
 *                                      版本肉眼已經看不出差異)
 *   fallback       -> fallbackUrl    (1600px，縮圖/原圖都失敗時備援)
 *
 * 順序：跟 index.html 現有的 fetchDriveImages() 用同一組固定隨機排序
 * （RANDOM_ORDER_SALT + FNV-1a 雜湊），直接把排序結果寫進 manifest
 * 陣列順序——前端拿到 manifest 後不用再自己排一次序，直接依陣列順序
 * 顯示就是正確的「固定隨機」順序。
 *
 * 用法：
 *   GOOGLE_API_KEY=xxxx node scripts/build-photos-manifest.js
 *
 * 可選環境變數：
 *   PHOTOBOOK_FOLDER_ID   （預設沿用網站現在用的那個資料夾 id）
 *   OUTPUT_DIR            （預設是目前工作目錄，也就是 repo 根目錄）
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PHOTOBOOK_FOLDER_ID = process.env.PHOTOBOOK_FOLDER_ID || '1wQI2MMoORB78XoC8E5GnxKkLLUEZsxPn';
const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();

const IMAGES_DIR = path.join(OUTPUT_DIR, 'photos');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'photos-manifest.json');

// 跟 index.html 的 RANDOM_ORDER_SALT 完全一樣的字串——排序結果要能對得上
// 前端原本「固定隨機」的順序，種子字串一定要一致。
const RANDOM_ORDER_SALT = 'edenchen-photobook-order-v1';

// 跟 index.html 的 fetchDriveImages() 需要的每個尺寸一一對應，見檔頭說明。
const SIZES = {
  // grid：首頁縮圖來源尺寸。原本 380px 是抓「一般大小」的縮圖夠用，
  // 但首頁縮圖大小其實不是固定的——每張照片會乘上一個隨機面積係數
  // （見 index.html 的 gridItemSizeVarianceFactor()／GRID_IMG_VARIANCE_MAX），
  // 每隔幾張還會額外「加碼放大」成重點照片（GRID_IMG_FEATURE_BOOST_MAX
  // 最高到 2.7 倍面積，換算邊長約 2 倍），在寬螢幕桌機（5 欄）上，這些
  // 被放大的重點照片實際顯示寬度可以到 600~700px 以上，再加上 retina
  // 螢幕通常要 2 倍像素密度才會清晰——380px 源檔被硬撐到這麼大，糊掉就是
  // 這樣來的。調到 640px：一般大小縮圖在 retina 上更接近清晰，加碼放大
  // 的重點照片也不再被過度放大。沒有一路拉到 1280px（正好對應最大放大
  // 情況的 2 倍 retina）是刻意的——那樣檔案大小會直接跳到接近 detail
  // 尺寸的量級，而網格縮圖是進站當下就要一次載入一整批（雖然大部分用
  // loading="lazy"，還是遠比大圖頁一次只看一張的量體大），640px 這個
  // 數字是「肉眼可感覺到的畫質提升」跟「檔案變大、可能拖慢首次進站」
  // 之間刻意抓的中間值，之後如果還是覺得不夠銳利，可以再往上調、但建議
  // 一次只調一段、部署後實際感受一下載入速度再決定要不要繼續加。
  grid: 640,
  tiny: 450,
  thumb: 750,
  previewMobile: 850,
  previewDesktop: 1500,
  detailMobile: 1200,
  detail: 2000,
  fallback: 1600,
};

if (!GOOGLE_API_KEY) {
  console.error('缺少 GOOGLE_API_KEY 環境變數，中止。');
  process.exit(1);
}

// FNV-1a 32-bit 雜湊，跟 index.html 的 hashStringToInt() 逐行對應——同一個
// file.id + 同一個種子字串，這裡跟前端永遠算出同一個數字。
function hashStringToInt(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

async function listDriveFiles() {
  const q = encodeURIComponent(
    `'${PHOTOBOOK_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`
  );
  // 跟 index.html 的 fetchDriveImages() 要同一組欄位：imageMediaMetadata
  // 用來算長寬比（給照片物理堆疊模式用），thumbnailLink 用來組出各種尺寸
  // 的下載網址。
  const fields = encodeURIComponent('files(id,name,thumbnailLink,imageMediaMetadata(width,height))');
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

async function downloadOneSize(thumbBase, id, sizeKey, sizePx) {
  const downloadUrl = `${thumbBase}=s${sizePx}`;
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    console.warn(`  ⚠ ${id} 的 ${sizeKey}(${sizePx}px) 下載失敗：${res.status} ${res.statusText}`);
    return null;
  }
  const contentType = res.headers.get('content-type') || '';
  const ext = extFromContentType(contentType);
  const buf = Buffer.from(await res.arrayBuffer());

  const fileName = `${id}-${sizeKey}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, fileName), buf);
  return `photos/${fileName}`;
}

async function downloadOnePhoto(file) {
  if (!file.thumbnailLink) {
    console.warn(`  ⚠ ${file.id} 沒有 thumbnailLink，略過（需要人工確認這個檔案）`);
    return null;
  }
  const thumbBase = file.thumbnailLink.replace(/=s\d+$/, '');
  const meta = file.imageMediaMetadata;
  const aspect = (meta && meta.width && meta.height) ? (meta.width / meta.height) : 1;

  const files = {};
  for (const [sizeKey, sizePx] of Object.entries(SIZES)) {
    const relPath = await downloadOneSize(thumbBase, file.id, sizeKey, sizePx);
    if (relPath) files[sizeKey] = relPath;
  }

  // 8 種尺寸裡只要有任何一種下載成功，這張照片就算數（跟 build-e-manifest.js
  // 一樣，單一次請求失敗不代表整個檔案要放棄；前端各欄位本來就有好幾層
  // fallback，缺一兩種尺寸也不會整個壞掉）。全部都失敗才整張跳過。
  if (Object.keys(files).length === 0) return null;

  return {
    id: file.id,
    title: file.name.replace(/\.[^/.]+$/, ''),
    aspect,
    files,
  };
}

async function main() {
  console.log(`列出 Drive 資料夾 ${PHOTOBOOK_FOLDER_ID} 內的照片...`);
  const rawFiles = await listDriveFiles();
  console.log(`找到 ${rawFiles.length} 個檔案。`);

  if (rawFiles.length === 0) {
    console.warn('資料夾是空的或查不到，不動 photos-manifest.json / photos/，中止。');
    return;
  }

  // 跟前端 fetchDriveImages() 同一套固定隨機排序，直接把結果寫進 manifest
  // 陣列順序，前端不用再自己排一次。
  rawFiles.sort((a, b) => hashStringToInt(a.id + RANDOM_ORDER_SALT) - hashStringToInt(b.id + RANDOM_ORDER_SALT));

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const photos = [];
  const currentIds = new Set();
  for (const file of rawFiles) {
    console.log(`下載 ${file.name} (${file.id}) ...`);
    const entry = await downloadOnePhoto(file);
    if (entry) {
      photos.push(entry);
      currentIds.add(entry.id);
    }
  }

  // 清掉 Drive 資料夾裡已經刪除、但上次還留在 photos/ 裡的舊檔案，
  // 避免 repo 越積越多用不到的圖。檔名格式是 <driveId>-<size>.<ext>，
  // 只清「前綴 id 已經不在這次清單裡」的檔案。
  const existing = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : [];
  for (const name of existing) {
    const id = name.replace(/-[a-zA-Z]+\.[a-z0-9]+$/i, '');
    if (!currentIds.has(id)) {
      console.log(`清除已下架的照片：${name}`);
      fs.unlinkSync(path.join(IMAGES_DIR, name));
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    folderId: PHOTOBOOK_FOLDER_ID,
    photos,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`完成：${photos.length} 張照片，manifest 寫入 ${MANIFEST_PATH}`);
}

main().catch(err => {
  console.error('build-photos-manifest.js 失敗：', err);
  process.exit(1);
});
