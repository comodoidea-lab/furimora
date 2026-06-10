const APP_URL = 'https://furimora.vercel.app';
const LEGACY_APP_URL = 'https://furimora-assist.vercel.app';

function normalizeAppUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return APP_URL;
  if (value.startsWith(LEGACY_APP_URL)) return value.replace(LEGACY_APP_URL, APP_URL);
  return value;
}

function withAppUrl(fn) {
  chrome.storage.local.get(['furimora_app_url'], ({ furimora_app_url }) => {
    const appUrl = normalizeAppUrl(furimora_app_url);
    if (furimora_app_url !== appUrl) chrome.storage.local.set({ furimora_app_url: appUrl });
    fn(appUrl);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const url = tab?.url || '';
  const statusEl = document.getElementById('page-status');
  const statusText = document.getElementById('page-status-text');
  const cloneBtn = document.getElementById('btn-clone');

  const isItemPage = url.includes('jp.mercari.com/item/');

  if (isItemPage) {
    statusEl.classList.add('mercari');
    statusText.textContent = 'メルカリ商品ページを検出しました';
    cloneBtn.disabled = false;
  } else if (url.includes('jp.mercari.com')) {
    statusEl.classList.add('mercari');
    statusText.textContent = 'メルカリを開いています';
    cloneBtn.disabled = true;
    cloneBtn.style.opacity = '0.5';
  } else {
    statusText.textContent = 'メルカリのページを開くと追加機能が使えます';
    cloneBtn.disabled = true;
    cloneBtn.style.opacity = '0.5';
  }

  // クローンボタン — content scriptにデータ抽出を依頼
  cloneBtn.addEventListener('click', () => {
    if (!isItemPage) return;

    cloneBtn.textContent = '取得中...';
    cloneBtn.disabled = true;
    withAppUrl((appUrl) => {
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ITEM_DATA' }, (data) => {
        let cloneUrl;
        if (data && data.title) {
          try {
            const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
            cloneUrl = `${appUrl}?clone_data=${encodeURIComponent(encoded)}`;
          } catch {
            cloneUrl = `${appUrl}?page=clone&url=${encodeURIComponent(url)}`;
          }
        } else {
          // content scriptから応答なし → URLだけ渡してサーバーAPIにフォールバック
          cloneUrl = `${appUrl}?page=clone&url=${encodeURIComponent(url)}`;
        }
        chrome.tabs.create({ url: cloneUrl });
        window.close();
      });
    });
  });
});

// 統計
chrome.storage.local.get(['furimora_stats'], ({ furimora_stats }) => {
  const stats = furimora_stats || { total: 0, relist: 0, discount: 0 };
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-relist').textContent = stats.relist;
  document.getElementById('stat-discount').textContent = stats.discount;
});

document.getElementById('btn-open-app').addEventListener('click', () => {
  withAppUrl((appUrl) => {
    chrome.tabs.create({ url: appUrl });
    window.close();
  });
});

document.getElementById('btn-relist').addEventListener('click', () => {
  withAppUrl((appUrl) => {
    chrome.tabs.create({ url: `${appUrl}?page=relist` });
    window.close();
  });
});
