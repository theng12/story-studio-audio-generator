// Shared light/dark/system theme handling for the popup and options page.
//
// The theme preference ('light' | 'dark' | 'system') lives in settings
// (chrome.storage.sync). We resolve 'system' to the OS preference via
// matchMedia and write the concrete value onto <html data-theme="…"> so the
// CSS only ever has to reason about 'light' vs 'dark'. When the preference is
// 'system' we also keep listening so the UI flips live if the OS toggles.

import { getSettings, saveSettings } from './config.js';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function resolve(pref) {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return media().matches ? 'dark' : 'light'; // 'system'
}

function apply(pref) {
  document.documentElement.setAttribute('data-theme', resolve(pref));
}

let mq = null;
let mqHandler = null;

// Apply the given preference now and (re)wire the system-change listener.
export function setTheme(pref) {
  apply(pref);
  if (mq && mqHandler) mq.removeEventListener('change', mqHandler);
  mq = null;
  mqHandler = null;
  if (pref === 'system') {
    mq = media();
    mqHandler = () => apply('system');
    mq.addEventListener('change', mqHandler);
  }
}

// Read the stored preference and apply it. Call once on page load.
export async function initTheme() {
  const s = await getSettings();
  setTheme(s.theme || 'system');
  return s.theme || 'system';
}

// Persist a new preference and apply it immediately.
export async function saveTheme(pref) {
  await saveSettings({ theme: pref });
  setTheme(pref);
}
