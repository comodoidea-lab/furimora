/**
 * フリモーラ - Content Script
 * メルカリの商品ページに補助UIを注入します
 */

(function () {
  'use strict';
  const APP_URL = 'https://furimora.vercel.app';
  const LEGACY_APP_URL = 'https://furimora-assist.vercel.app';

  function normalizeAppUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return APP_URL;
    if (value.startsWith(LEGACY_APP_URL)) return value.replace(LEGACY_APP_URL, APP_URL);
    return value;
  }

  if (document.getElementById('furimora-widget')) return;

  const isItemPage = /\/item\/m\w+/.test(window.location.pathname);
  const isSellPage = /\/sell/.test(window.location.pathname);
  if (!isItemPage && !isSellPage) return;

  // ── 商品情報を抽出（フル版） ──────────────────────────────────────────
  function extractItemData() {
    const url = window.location.href;
    const idMatch = window.location.pathname.match(/\/item\/(m\w+)/);
    const itemId = idMatch ? idMatch[1] : null;

    // 1st: __NEXT_DATA__ から直接取得（最も確実）
    try {
      const ndEl = document.getElementById('__NEXT_DATA__');
      if (ndEl) {
        const nd = JSON.parse(ndEl.textContent);
        const item = nd?.props?.pageProps?.item
          || nd?.props?.pageProps?.itemResponse?.item
          || nd?.props?.pageProps?.data?.item
          || findItemInND(nd?.props);
        if (item && (item.name || item.title)) {
          return normalizeNextData(item, itemId, url);
        }
      }
    } catch (e) {}

    // 2nd: DOMスクレイピングにフォールバック
    return extractFromDOM(itemId, url);
  }

  function findItemInND(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    if (obj.id && (obj.name || obj.title) && obj.price !== undefined) return obj;
    for (const val of Object.values(obj)) {
      const found = findItemInND(val, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function normalizeNextData(item, itemId, url) {
    // 画像
    const images = [];
    if (Array.isArray(item.photos)) {
      for (const p of item.photos) {
        const u = p.imageUrl || p.image_url || p.url || (typeof p === 'string' ? p : null);
        if (u) images.push(u.split('?')[0]);
      }
    }
    if (!images.length && Array.isArray(item.thumbnails)) images.push(...item.thumbnails.filter(Boolean));
    if (!images.length && item.thumbnailUrl) images.push(item.thumbnailUrl);

    // カテゴリ — snake_case / camelCase 両対応
    const cats = item.categories || item.itemCategoryGroupList || item.category_list || [];
    const category = Array.isArray(cats)
      ? cats.map(c => c.name || c.displayName || '').filter(Boolean).join(' > ')
      : (item.category?.name || '');

    // 商品状態 — フィールド名のバリエーション全対応
    const condMap = { 1: '新品・未使用', 2: '未使用に近い', 3: '目立った傷や汚れなし', 4: 'やや傷や汚れあり', 5: '傷や汚れあり', 6: '全体的に状態が悪い' };
    const condObj = item.itemCondition || item.item_condition || {};
    const condId = item.itemConditionId || item.item_condition_id || condObj.id;
    const condition = condObj.name || condObj.displayName || condMap[condId] || '';

    // 配送 — snake_case / camelCase 両対応
    const payerObj = item.shippingPayer || item.shipping_payer || {};
    const payerId = item.shippingPayerId || item.shipping_payer_id || payerObj.id;
    const shippingPayer = payerObj.name
      || (payerId === 1 ? '送料込み（出品者負担）' : payerId === 2 ? '着払い（購入者負担）' : '');

    const methodObj = item.shippingMethod || item.shipping_method || item.shipping || {};
    const shippingMethod = methodObj.name || methodObj.displayName || '';

    const fromObj = item.shippingFromArea || item.shipping_from_area || {};
    const shippingFrom = fromObj.name || fromObj.displayName || '';

    const daysObj = item.shippingDuration || item.shipping_duration || item.shippingDays || item.shipping_days || {};
    const shippingDays = daysObj.name || daysObj.displayName || '';

    // いいね数
    const likesCount = item.num_likes ?? item.num_wish_lists ?? item.likesCount ?? item.likes_count ?? 0;

    const result = {
      itemId: item.id || itemId,
      title: item.name || item.title || '',
      currentPrice: item.price ?? null,
      price: item.price ?? null,
      description: item.description || '',
      category, condition,
      shippingPayer, shippingMethod, shippingFrom, shippingDays,
      images, thumbnailUrl: images[0] || null,
      likesCount,
      status: item.status || '',
      url: url || `https://jp.mercari.com/item/${itemId}`,
      source: 'next-data',
    };

    // __NEXT_DATA__で不足フィールドはDOMで補完
    const missing = !condition || !shippingPayer || !shippingMethod;
    if (missing) {
      const dom = extractFromDOM(itemId, url);
      if (!result.condition) result.condition = dom.condition;
      if (!result.shippingPayer) result.shippingPayer = dom.shippingPayer;
      if (!result.shippingMethod) result.shippingMethod = dom.shippingMethod;
      if (!result.shippingFrom) result.shippingFrom = dom.shippingFrom;
      if (!result.shippingDays) result.shippingDays = dom.shippingDays;
      if (!result.images.length) result.images = dom.images;
    }

    return result;
  }

  function extractFromDOM(itemId, url) {
    const data = { itemId, url, source: 'dom' };

    data.title = document.querySelector('h1[data-testid="name"]')?.textContent?.trim()
      || document.querySelector('[class*="ItemName"]')?.textContent?.trim()
      || document.title.replace(/\s*[-–]\s*メルカリ.*$/, '').trim();

    // 価格 — 数字のみ抽出（最大の数字を価格とみなす）
    const priceTexts = [...document.querySelectorAll('[class*="price" i], [data-testid*="price"]')]
      .map(el => parseInt(el.textContent.replace(/[^\d]/g, '')))
      .filter(n => n > 0);
    data.currentPrice = priceTexts.length ? Math.max(...priceTexts) : null;
    data.price = data.currentPrice;

    data.description = document.querySelector('[data-testid="description"]')?.textContent?.trim()
      || document.querySelector('[class*="ItemDescription"] p')?.textContent?.trim()
      || '';

    // 価格 — querySelectorで最初のヒットを使用（関連商品の価格を避ける）
    const priceSelectors = [
      '[data-testid="price"]',
      '[class*="merPrice"]',
      '[class*="ItemPrice"]',
      'h3[class*="price" i]',
      '[class*="price" i]',
    ];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const n = parseInt(el.textContent.replace(/[^\d]/g, ''));
        if (n > 0) { data.currentPrice = n; data.price = n; break; }
      }
    }

    // 画像 — itemIdを含むURLのみ取得（関連商品の画像を除外）
    const imgUrls = new Set();
    document.querySelectorAll('img, source').forEach(el => {
      const srcs = [el.src, el.currentSrc, el.dataset.src, ...(el.srcset || '').split(',').map(s => s.trim().split(' ')[0])];
      for (const src of srcs) {
        if (!src || !itemId) continue;
        // 商品IDを含むmercdnのURLのみ採用
        if (src.includes('mercdn.net') && src.includes(itemId)) {
          imgUrls.add(src.split('?')[0].replace(/\/thumb\//, '/orig/'));
        }
      }
    });
    data.images = [...imgUrls].slice(0, 12);
    data.thumbnailUrl = data.images[0] || null;

    // カテゴリ — "出品"など不要なパンくずを除外
    const EXCLUDE_CRUMBS = new Set(['ホーム', 'メルカリ', 'トップ', '出品', 'すべてのカテゴリ']);
    const breadcrumbs = [...document.querySelectorAll('nav a, ol li a, [class*="readcrumb"] a, [class*="Breadcrumb"] a')]
      .map(a => a.textContent.trim())
      .filter(t => t && !EXCLUDE_CRUMBS.has(t));
    data.category = breadcrumbs.join(' > ');

    // いいね数
    const likesEl = document.querySelector('[data-testid*="like"], [class*="likeCount"], [class*="like-count"]');
    const likesText = likesEl?.textContent?.replace(/[^\d]/g, '');
    data.likesCount = likesText ? parseInt(likesText) : 0;

    // 商品状態・配送 — ラベルテキストで要素を探して隣接値を取得
    const labelMap = {
      '商品の状態': 'condition',
      '送料の負担': 'shippingPayer', '配送料の負担': 'shippingPayer',
      '配送の方法': 'shippingMethod', '配送方法': 'shippingMethod',
      '発送元の地域': 'shippingFrom', '発送元': 'shippingFrom',
      '発送までの日数': 'shippingDays',
    };

    // 方法1: dl/table 構造
    document.querySelectorAll('dl, table').forEach(el => {
      const labels = [...el.querySelectorAll('dt, th')];
      const values = [...el.querySelectorAll('dd, td')];
      labels.forEach((lEl, i) => {
        const lText = lEl.textContent.trim();
        const vText = values[i]?.textContent?.trim();
        if (!vText) return;
        for (const [key, field] of Object.entries(labelMap)) {
          if (lText.includes(key) && !data[field]) { data[field] = vText; break; }
        }
      });
    });

    // 方法2: ラベルテキストを含む要素から隣接要素の値を取得（div構造対応）
    if (!data.condition || !data.shippingPayer) {
      const allLeafEls = [...document.querySelectorAll('span, p, div, td, dt, th, li')]
        .filter(el => el.children.length === 0);
      for (const el of allLeafEls) {
        const txt = el.textContent.trim();
        for (const [key, field] of Object.entries(labelMap)) {
          if (data[field] || !txt.includes(key)) continue;
          const candidates = [
            el.nextElementSibling,
            el.parentElement?.nextElementSibling,
            el.parentElement?.parentElement?.nextElementSibling,
            el.closest('tr, [class*="row" i], [class*="Row"]')?.querySelector('td:last-child, dd, [class*="value" i], [class*="Value"]'),
          ];
          for (const c of candidates) {
            const val = c?.textContent?.trim();
            if (val && val !== txt && val.length < 100) {
              data[field] = val;
              break;
            }
          }
        }
      }
    }

    // 方法3: innerText 行スキャン（上記で取れなかった場合の最終手段）
    if (!data.condition || !data.shippingMethod) {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
      const textLabelMap = {
        '商品の状態': 'condition',
        '配送の方法': 'shippingMethod',
        '配送料の負担': 'shippingPayer', '送料の負担': 'shippingPayer',
        '発送元の地域': 'shippingFrom',
        '発送までの日数': 'shippingDays',
      };
      // ラベル行の次の非空行を値として取得
      for (let i = 0; i < lines.length - 1; i++) {
        for (const [key, field] of Object.entries(textLabelMap)) {
          if (data[field] || lines[i] !== key) continue;
          // 次の行（状態のサブテキストを除いて最初の意味ある行）
          const val = lines[i + 1];
          if (val && val.length < 80) data[field] = val;
        }
      }
    }

    return data;
  }

  // メッセージリスナー — popup.js からデータ要求を受け取る
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_ITEM_DATA') {
      sendResponse(extractItemData());
    }
    return true;
  });

  // ── フローティングウィジェット ────────────────────────────────────────
  function createWidget() {
    const data = extractItemData();

    const widget = document.createElement('div');
    widget.id = 'furimora-widget';
    widget.innerHTML = `
      <div id="furimora-toggle" title="フリモーラ">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="white" stroke-width="2" stroke-linejoin="round"/>
          <path d="M2 17L12 22L22 17" stroke="white" stroke-width="2" stroke-linejoin="round"/>
          <path d="M2 12L12 17L22 12" stroke="white" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>
      <div id="furimora-panel" class="furimora-hidden">
        <div id="furimora-header">
          <span>フリモーラ</span>
          <button id="furimora-close">✕</button>
        </div>
        <div id="furimora-body">
          <div class="furimora-item-info">
            <p class="furimora-title" title="${data.title || ''}">${(data.title || '商品タイトル').substring(0, 40)}${(data.title || '').length > 40 ? '...' : ''}</p>
            ${data.price ? `<p class="furimora-price">¥${data.price.toLocaleString()}</p>` : ''}
            ${data.images.length ? `<p class="furimora-img-count">📷 ${data.images.length}枚の画像を検出</p>` : ''}
          </div>
          <div class="furimora-actions">
            <button class="furimora-btn furimora-btn-primary" id="furimora-clone-btn">
              <span>📋</span> クローン作成
            </button>
            <button class="furimora-btn furimora-btn-secondary" id="furimora-discount-btn">
              <span>📉</span> 10% 値下げ
            </button>
            <button class="furimora-btn furimora-btn-secondary" id="furimora-save-photos-btn">
              <span>💾</span> 写真を保存
            </button>
            <button class="furimora-btn furimora-btn-secondary" id="furimora-copy-url-btn">
              <span>🔗</span> URLをコピー
            </button>
            <button class="furimora-btn furimora-btn-secondary" id="furimora-copy-title-btn">
              <span>📝</span> タイトルをコピー
            </button>
          </div>
          <div id="furimora-status"></div>
        </div>
      </div>
    `;

    document.body.appendChild(widget);

    const toggle = document.getElementById('furimora-toggle');
    const panel = document.getElementById('furimora-panel');
    const closeBtn = document.getElementById('furimora-close');
    const status = document.getElementById('furimora-status');

    toggle.addEventListener('click', () => panel.classList.toggle('furimora-hidden'));
    closeBtn.addEventListener('click', () => panel.classList.add('furimora-hidden'));

    // クローン作成 — クリック時に再取得してエンコード
    document.getElementById('furimora-clone-btn').addEventListener('click', () => {
      showStatus('⏳ データを取得中...', '');
      // 少し待ってからDOM/NEXT_DATAを再取得（ページが完全に描画されている状態で）
      setTimeout(() => {
        const freshData = extractItemData();
        chrome.storage.local.get('furimora_app_url', ({ furimora_app_url }) => {
          const appUrl = normalizeAppUrl(furimora_app_url);
          if (furimora_app_url !== appUrl) chrome.storage.local.set({ furimora_app_url: appUrl });
          const cloneUrl = buildCloneUrl(appUrl, freshData);
          chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: cloneUrl });
          showStatus('✓ フリモーラでクローン作成画面を開きます', 'success');
        });
      }, 300);
    });

    // 値下げ
    document.getElementById('furimora-discount-btn').addEventListener('click', () => {
      if (data.price) {
        const newPrice = Math.round(data.price * 0.9);
        navigator.clipboard.writeText(newPrice.toString());
        showStatus(`✓ 値下げ価格 ¥${newPrice.toLocaleString()} をコピーしました`, 'success');
        chrome.runtime.sendMessage({ type: 'SAVE_DISCOUNT', itemId: data.itemId, originalPrice: data.price, newPrice });
      } else {
        showStatus('価格を取得できませんでした', 'error');
      }
    });

    // 写真を一括保存
    document.getElementById('furimora-save-photos-btn').addEventListener('click', () => {
      showStatus('⏳ 写真を取得中...', '');
      setTimeout(() => {
        const freshData = extractItemData();
        const imgs = freshData.images || [];
        if (!imgs.length) { showStatus('画像が見つかりませんでした', 'error'); return; }
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_IMAGES',
          images: imgs,
          itemId: freshData.itemId,
        });
        showStatus(`✓ ${imgs.length}枚をダウンロードフォルダに保存します`, 'success');
      }, 300);
    });

    document.getElementById('furimora-copy-url-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(data.url);
      showStatus('✓ URLをコピーしました', 'success');
    });

    document.getElementById('furimora-copy-title-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(data.title || '');
      showStatus('✓ タイトルをコピーしました', 'success');
    });

    function showStatus(msg, type) {
      status.textContent = msg;
      status.className = `furimora-status-${type}`;
      setTimeout(() => { status.textContent = ''; status.className = ''; }, 3000);
    }
  }

  // ── データをURLエンコード ─────────────────────────────────────────────
  function buildCloneUrl(appUrl, data) {
    try {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
      return `${appUrl}?clone_data=${encodeURIComponent(encoded)}`;
    } catch {
      return `${appUrl}?page=clone&url=${encodeURIComponent(data.url)}`;
    }
  }

  // DOM準備完了後に注入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createWidget);
  } else {
    createWidget();
  }

  // SPA対応
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      const existing = document.getElementById('furimora-widget');
      if (existing) existing.remove();
      setTimeout(createWidget, 1000);
    }
  }).observe(document.body, { subtree: true, childList: true });

})();
