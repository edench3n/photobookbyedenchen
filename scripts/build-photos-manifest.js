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
 *   ALLOW_PARTIAL=1       （預設：只要有任何照片/尺寸下載失敗就 exit 1、不動
 *                          manifest，避免把缺檔的結果 commit 上去；設成 1 則
 *                          允許缺檔也照樣寫出 manifest）
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

const ALLOW_PARTIAL = process.env.ALLOW_PARTIAL === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 帶指數退避重試的 fetch：429／5xx／403（Google CDN 限流常回 403）／網路錯誤
// 都會重試；其他 4xx 重試也沒用，直接放棄。成功回傳 Response，失敗回傳 null。
async function fetchWithRetry(url, label, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`${res.status} ${res.statusText}`);
      const retriable = res.status >= 500 || [403, 408, 429].includes(res.status);
      if (!retriable) break;
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts) await sleep(1000 * 2 ** (i - 1));
  }
  console.warn(`  ⚠ ${label} 失敗：${lastErr && lastErr.message}`);
  return null;
}

// 檢查 bytes 真的是圖片（JPEG / PNG / WebP / GIF）。Drive 被限流時常回 200 +
// HTML 錯誤頁，單看 HTTP 狀態碼會被騙，存成 .jpg 就變成永遠載不出來的壞檔。
function looksLikeImage(buf) {
  if (!buf || buf.length < 512) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return true;
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return true;
  if (buf.toString('latin1', 0, 3) === 'GIF') return true;
  return false;
}

async function listDriveFiles() {
  const q = encodeURIComponent(
    `'${PHOTOBOOK_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`
  );
  // nextPageToken + pageSize=1000：Drive 預設一頁只回 100 筆，原本沒做分頁，
  // 資料夾超過 100 張時多出來的照片永遠不會出現。
  const fields = encodeURIComponent('nextPageToken,files(id,name,thumbnailLink,imageMediaMetadata(width,height))');
  const all = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=name&key=${GOOGLE_API_KEY}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetchWithRetry(url, 'Drive files.list');
    if (!res) throw new Error('Drive files.list 失敗（重試後仍失敗）');
    const data = await res.json();
    all.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return all;
}

function extFromContentType(contentType) {
  if (!contentType) return 'jpg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg'; // Drive 的 thumbnailLink 預設多半回 jpeg
}

// 找上一次 run 已經下載好、而且驗證過是真圖片的同尺寸檔案（沒有就回 null）。
function findExisting(id, sizeKey) {
  if (!fs.existsSync(IMAGES_DIR)) return null;
  const prefix = `${id}-${sizeKey}.`;
  for (const name of fs.readdirSync(IMAGES_DIR)) {
    if (!name.startsWith(prefix)) continue;
    try {
      if (looksLikeImage(fs.readFileSync(path.join(IMAGES_DIR, name)))) return `photos/${name}`;
    } catch (e) { /* 讀不到就當作沒有 */ }
  }
  return null;
}

async function downloadOneSize(thumbBase, id, sizeKey, sizePx) {
  if (thumbBase) {
    const res = await fetchWithRetry(`${thumbBase}=s${sizePx}`, `${id} 的 ${sizeKey}(${sizePx}px)`);
    if (res) {
      const contentType = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (contentType.startsWith('image/') && looksLikeImage(buf)) {
        const fileName = `${id}-${sizeKey}.${extFromContentType(contentType)}`;
        fs.writeFileSync(path.join(IMAGES_DIR, fileName), buf);
        // 副檔名可能跟上次不同，清掉同尺寸的舊檔避免殘留
        const prefix = `${id}-${sizeKey}.`;
        for (const n of fs.readdirSync(IMAGES_DIR)) {
          if (n.startsWith(prefix) && n !== fileName) fs.unlinkSync(path.join(IMAGES_DIR, n));
        }
        return `photos/${fileName}`;
      }
      console.warn(`  ⚠ ${id} 的 ${sizeKey} 回傳的不是圖片（content-type=${contentType}，${buf.length} bytes），丟棄`);
    }
  }
  // 這次下載失敗：沿用上次已經驗證過的檔案，不要讓一次暫時性失敗讓照片消失
  const old = findExisting(id, sizeKey);
  if (old) {
    console.warn(`  ↺ ${id} 的 ${sizeKey} 沿用上次的檔案`);
    return old;
  }
  return null;
}

// 回傳 { entry, missing }：missing 是這張照片這次拿不到的尺寸清單。
async function downloadOnePhoto(file) {
  let thumbBase = null;
  if (file.thumbnailLink) {
    thumbBase = file.thumbnailLink.replace(/=s\d+$/, '');
  } else {
    console.warn(`  ⚠ ${file.id}（${file.name}）沒有 thumbnailLink（Drive 可能還沒產生縮圖，或格式不支援）`);
  }
  const meta = file.imageMediaMetadata;
  const aspect = (meta && meta.width && meta.height) ? (meta.width / meta.height) : 1;

  const files = {};
  const missing = [];
  for (const [sizeKey, sizePx] of Object.entries(SIZES)) {
    const relPath = await downloadOneSize(thumbBase, file.id, sizeKey, sizePx);
    if (relPath) files[sizeKey] = relPath;
    else missing.push(sizeKey);
  }
  if (Object.keys(files).length === 0) return { entry: null, missing };

  return {
    entry: { id: file.id, title: file.name.replace(/\.[^/.]+$/, ''), aspect, files },
    missing,
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

  rawFiles.sort((a, b) => hashStringToInt(a.id + RANDOM_ORDER_SALT) - hashStringToInt(b.id + RANDOM_ORDER_SALT));

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const photos = [];
  const currentIds = new Set();
  const problems = [];
  for (const file of rawFiles) {
    console.log(`下載 ${file.name} (${file.id}) ...`);
    const { entry, missing } = await downloadOnePhoto(file);
    if (entry) {
      photos.push(entry);
      currentIds.add(entry.id);
      if (missing.length) problems.push(`${file.name} (${file.id})：缺 ${missing.join(', ')}`);
    } else {
      problems.push(`${file.name} (${file.id})：全部尺寸都失敗，整張照片會消失`);
    }
    await sleep(150); // 稍微放慢，降低被 Google CDN 限流的機率
  }

  // 有任何缺檔就中止，不覆寫 manifest、不清舊檔，workflow 會顯示紅燈、
  // 不會 commit，網站維持上一個完整的版本。
  if (problems.length) {
    console.error(`\n有 ${problems.length} 張照片下載不完整：`);
    problems.forEach(p => console.error('  - ' + p));
    if (!ALLOW_PARTIAL) {
      console.error('中止，不更新 photos-manifest.json（若要允許缺檔照樣輸出，設 ALLOW_PARTIAL=1）。');
      process.exit(1);
    }
    console.warn('ALLOW_PARTIAL=1：照樣輸出缺檔的 manifest。');
  }

  // 清掉 Drive 資料夾裡已經刪除、但還留在 photos/ 裡的舊檔案
  for (const name of fs.readdirSync(IMAGES_DIR)) {
    const id = name.replace(/-[a-zA-Z]+\.[a-z0-9]+$/i, '');
    if (!currentIds.has(id)) {
      console.log(`清除已下架的照片：${name}`);
      fs.unlinkSync(path.join(IMAGES_DIR, name));
    }
  }

  // 最後檢查：manifest 裡每個路徑都真的存在
  for (const p of photos) {
    for (const rel of Object.values(p.files)) {
      if (!fs.existsSync(path.join(OUTPUT_DIR, rel))) {
        console.error(`manifest 指向不存在的檔案：${rel}`);
        process.exit(1);
      }
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
