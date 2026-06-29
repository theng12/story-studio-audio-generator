import {
  getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
  getApiKeys,
  saveApiKeys,
  DEFAULTS,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['mode', 'studioBaseUrl', 'saveTarget', 'downloadSubdir', 'filenameTemplate', 'fishVoice'];

const COLOR = { ok: '#0a7a0a', warn: '#b56b00', err: '#b00', muted: 'var(--muted)' };

function toggleCompanion() {
  $('companionOpts').style.display = $('mode').value === 'companion' ? '' : 'none';
}

async function load() {
  const s = await getSettings();
  for (const f of FIELDS) $(f).value = s[f] ?? DEFAULTS[f] ?? '';
  const cred = await getCredentials();
  $('studioUsername').value = cred.username || '';
  $('studioPassword').value = cred.password || '';
  const keys = await getApiKeys();
  $('elevenLabsKey').value = keys.elevenLabsKey || '';
  $('openaiKey').value = keys.openaiKey || '';
  toggleCompanion();
  $('mode').addEventListener('change', toggleCompanion);
  $('save').addEventListener('click', save);
  $('grantAccess').addEventListener('click', grantAccess);
  $('testConnection').addEventListener('click', testConnection);
  $('studioBaseUrl').addEventListener('input', refreshGrantStatus);
  refreshGrantStatus();

  // Auto-save every field as you edit — no "did it save?" doubt. The explicit
  // Save button stays as a belt-and-suspenders.
  const allFields = [...FIELDS, 'studioUsername', 'studioPassword', 'elevenLabsKey', 'openaiKey'];
  for (const id of allFields) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', autoSave);
  }
}

let autoTimer = null;
function autoSave() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(save, 400);
}

async function save() {
  const patch = {};
  for (const f of FIELDS) patch[f] = $(f).value.trim();
  await saveSettings(patch);
  await saveCredentials({
    username: $('studioUsername').value.trim(),
    password: $('studioPassword').value, // not trimmed — passwords may have spaces
  });
  await saveApiKeys({
    elevenLabsKey: $('elevenLabsKey').value.trim(),
    openaiKey: $('openaiKey').value.trim(),
  });
  $('status').textContent = 'Saved.';
  setTimeout(() => ($('status').textContent = ''), 1500);
}

// ── Host-permission self-grant (so a remote/Tailscale server works without a
// hardcoded whitelist — the user authorizes their own server URL at runtime). ──
function originPattern(url) {
  try {
    const u = new URL(url);
    // Match patterns are host-level (no port) — this covers any port on the host.
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
function isLocalUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

async function refreshGrantStatus() {
  const el = $('grantStatus');
  const btn = $('grantAccess');
  const url = $('studioBaseUrl').value.trim();
  const pat = originPattern(url);
  if (!pat) {
    el.textContent = '';
    return;
  }
  if (isLocalUrl(url)) {
    el.textContent = 'Local — no grant needed.';
    el.style.color = COLOR.muted;
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const granted = await chrome.permissions.contains({ origins: [pat] }).catch(() => false);
  el.textContent = granted ? '✓ Access granted' : 'Not granted — click to grant.';
  el.style.color = granted ? COLOR.ok : COLOR.warn;
}

async function grantAccess() {
  const url = $('studioBaseUrl').value.trim();
  const pat = originPattern(url);
  const el = $('grantStatus');
  if (!pat) {
    el.textContent = 'Enter a valid Server URL first.';
    el.style.color = COLOR.err;
    return;
  }
  if (isLocalUrl(url)) return refreshGrantStatus();
  try {
    const granted = await chrome.permissions.request({ origins: [pat] });
    if (!granted) {
      el.textContent = 'Permission declined.';
      el.style.color = COLOR.err;
      return;
    }
    // Quick reachability test so the user knows the URL/permission combo works.
    el.textContent = '✓ Granted — testing…';
    el.style.color = COLOR.ok;
    try {
      await new StudioClient(url).listProjects();
      el.textContent = '✓ Access granted, server reachable.';
    } catch (e) {
      el.textContent = `✓ Granted, but server not reachable yet (${e.message}). Check it's running + you're logged in.`;
      el.style.color = COLOR.warn;
    }
  } catch (e) {
    el.textContent = `Grant failed: ${e.message}`;
    el.style.color = COLOR.err;
  }
}

// Explicit "does it work?" test against the current URL.
async function testConnection() {
  const url = $('studioBaseUrl').value.trim();
  const el = $('testStatus');
  el.style.color = COLOR.muted;
  el.textContent = 'Testing…';
  if (!url) {
    el.textContent = 'Enter a Server URL first.';
    el.style.color = COLOR.err;
    return;
  }
  if (!isLocalUrl(url)) {
    const pat = originPattern(url);
    const granted = pat && (await chrome.permissions.contains({ origins: [pat] }).catch(() => false));
    if (!granted) {
      el.textContent = 'Grant access first (button above), then test.';
      el.style.color = COLOR.warn;
      return;
    }
  }
  try {
    const projects = await new StudioClient(url).listProjects();
    el.textContent = `✓ Connected — ${projects.length} project(s) found.`;
    el.style.color = COLOR.ok;
  } catch (e) {
    const tail = isLocalUrl(url) ? 'Is Story Studio running?' : 'Running, granted, and logged in?';
    el.textContent = `✗ Not reachable: ${e.message}. ${tail}`;
    el.style.color = COLOR.err;
  }
}

document.addEventListener('DOMContentLoaded', load);
