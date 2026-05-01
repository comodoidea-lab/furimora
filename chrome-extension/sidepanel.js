const APP_URL = 'https://furimora.vercel.app';
const LEGACY_APP_URL = 'https://furimora-assist.vercel.app';
let currentAppUrl = APP_URL;

function normalizeAppUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return APP_URL;
  if (value.startsWith(LEGACY_APP_URL)) return value.replace(LEGACY_APP_URL, APP_URL);
  return value;
}

function showError() {
  const frame = document.getElementById('app-frame');
  const error = document.getElementById('error');
  frame.style.display = 'none';
  error.style.display = 'block';
}

function showFrame() {
  const frame = document.getElementById('app-frame');
  const error = document.getElementById('error');
  frame.style.display = 'block';
  error.style.display = 'none';
}

function openAppInTab() {
  chrome.tabs.create({ url: currentAppUrl });
}

function reloadFrame() {
  const frame = document.getElementById('app-frame');
  showFrame();
  frame.src = currentAppUrl;
}

function detectBlockedPage(frame) {
  try {
    const href = frame.contentWindow?.location?.href || '';
    if (href.startsWith('chrome-error://')) {
      showError();
    }
  } catch {
    // Cross-origin pages are expected; keep the frame visible.
  }
}

chrome.storage.local.get(['furimora_app_url'], ({ furimora_app_url }) => {
  currentAppUrl = normalizeAppUrl(furimora_app_url);
  if (furimora_app_url !== currentAppUrl) {
    chrome.storage.local.set({ furimora_app_url: currentAppUrl });
  }

  const frame = document.getElementById('app-frame');
  document.getElementById('btn-open-tab')?.addEventListener('click', openAppInTab);
  document.getElementById('btn-reload')?.addEventListener('click', reloadFrame);

  frame.addEventListener('error', showError);
  frame.addEventListener('load', () => detectBlockedPage(frame));
  frame.src = currentAppUrl;
});
