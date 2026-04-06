/**
 * フリモーラ - Background Service Worker (Manifest V3)
 */

const APP_URL = 'https://furimora.vercel.app';
const LEGACY_APP_URL = 'https://furimora-assist.vercel.app';

function normalizeAppUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return APP_URL;
  if (value.startsWith(LEGACY_APP_URL)) return value.replace(LEGACY_APP_URL, APP_URL);
  return value;
}

async function migrateStoredAppUrl() {
  const { furimora_app_url } = await chrome.storage.local.get(['furimora_app_url']);
  const normalized = normalizeAppUrl(furimora_app_url);
  if (furimora_app_url !== normalized) {
    await chrome.storage.local.set({ furimora_app_url: normalized });
  }
}

// メッセージハンドラ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'OPEN_TAB':
      chrome.tabs.create({ url: message.url });
      sendResponse({ ok: true });
      break;

    case 'SAVE_DISCOUNT':
      saveDiscountRecord(message);
      sendResponse({ ok: true });
      break;

    case 'DOWNLOAD_IMAGES':
      downloadImages(message.images, message.itemId);
      sendResponse({ ok: true });
      break;

    case 'GET_STATS':
      chrome.storage.local.get(['furimora_stats'], ({ furimora_stats }) => {
        sendResponse({ stats: furimora_stats || { total: 0, relist: 0, discount: 0 } });
      });
      return true; // async response

    default:
      break;
  }
});

// 値下げ記録を保存して統計を更新
async function saveDiscountRecord({ itemId, originalPrice, newPrice }) {
  const now = new Date().toISOString();

  const result = await chrome.storage.local.get(['furimora_discounts', 'furimora_stats']);
  const discounts = result.furimora_discounts || [];
  const stats = result.furimora_stats || { total: 0, relist: 0, discount: 0 };

  // 重複チェック（同日同アイテム）
  const today = now.slice(0, 10);
  const alreadyDiscounted = discounts.some(
    (d) => d.itemId === itemId && d.date.startsWith(today)
  );

  if (!alreadyDiscounted) {
    discounts.push({ itemId, originalPrice, newPrice, date: now });
    stats.discount = (stats.discount || 0) + 1;

    await chrome.storage.local.set({
      furimora_discounts: discounts.slice(-500), // 最大500件保持
      furimora_stats: stats,
    });
  }
}

// 画像を一括ダウンロード
function downloadImages(images, itemId) {
  if (!images || !images.length) return;
  const folder = `furimora/${itemId || 'item'}`;
  images.forEach((url, i) => {
    const ext = (url.split('.').pop().split('?')[0] || 'jpg').substring(0, 4);
    chrome.downloads.download({
      url,
      filename: `${folder}/${String(i + 1).padStart(2, '0')}.${ext}`,
      conflictAction: 'overwrite',
    });
  });
}

// インストール時の初期化
chrome.runtime.onInstalled.addListener(({ reason }) => {
  migrateStoredAppUrl();
  if (reason === 'install') {
    chrome.storage.local.set({
      furimora_stats: { total: 0, relist: 0, discount: 0, profit: 0 },
      furimora_app_url: APP_URL,
    });

    // ウェルカムページを開く
    chrome.tabs.create({ url: `${APP_URL}?welcome=1` });
  }
});

chrome.runtime.onStartup.addListener(() => {
  migrateStoredAppUrl();
});

// アラームを使った定期処理（再出品リマインダー）
chrome.alarms.create('furimora-relist-check', { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'furimora-relist-check') return;

  const { furimora_stats } = await chrome.storage.local.get(['furimora_stats']);
  const relist = furimora_stats?.relist || 0;

  if (relist > 0) {
    chrome.notifications.create('furimora-relist', {
      type: 'basic',
      iconUrl: '../icons/icon-48.png',
      title: 'フリモーラ',
      message: `再出品待ちの商品が ${relist} 件あります`,
      buttons: [{ title: '管理画面を開く' }],
    });
  }
});

// 通知ボタンのクリック
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId === 'furimora-relist' && buttonIndex === 0) {
    chrome.tabs.create({ url: `${APP_URL}?page=relist` });
  }
  chrome.notifications.clear(notificationId);
});
