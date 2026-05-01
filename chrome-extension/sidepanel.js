const APP_URL = 'https://furimora.vercel.app';
const LEGACY_APP_URL = 'https://furimora-assist.vercel.app';

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

chrome.storage.local.get(['furimora_app_url'], ({ furimora_app_url }) => {
  const appUrl = normalizeAppUrl(furimora_app_url);
  if (furimora_app_url !== appUrl) {
    chrome.storage.local.set({ furimora_app_url: appUrl });
  }

  const frame = document.getElementById('app-frame');
  frame.addEventListener('error', showError);
  frame.src = appUrl;
});
