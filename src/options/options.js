import {
  getSettings,
  saveSettings,
  getCredentials,
  getGatewayCredentials,
  saveCredentials,
  saveGatewayCredentials,
  DEFAULTS,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
// Fields that have an input on THIS page. (The voice lives in the side panel,
// not here — don't list fishVoice or $(f) is null and load() aborts before the
// buttons are wired.)
const FIELDS = ['theme', 'studioBaseUrl', 'gatewayBaseUrl'];
const CHECKBOX_FIELDS = ['gatewayModeEnabled'];

const COLOR = { ok: '#0a7a0a', warn: '#b56b00', err: '#b00', muted: 'var(--muted)' };

async function load() {
  await initTheme();
  const s = await getSettings();
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? DEFAULTS[f] ?? '';
  for (const f of CHECKBOX_FIELDS) if ($(f)) $(f).checked = s[f] === true;
  // Apply the theme live as soon as it's changed (before the debounced save).
  $('theme').addEventListener('change', () => setTheme($('theme').value));
  const cred = await getCredentials();
  $('studioUsername').value = cred.username || '';
  $('studioPassword').value = cred.password || '';
  const gwCreds = await getGatewayCredentials();
  $('gatewayWorkerToken').value = gwCreds.token || '';
  $('gatewayWorkerId').value = gwCreds.workerId || '';
  $('save').addEventListener('click', save);
  $('login').addEventListener('click', login);
  $('grantAccess').addEventListener('click', grantAccess);
  $('testConnection').addEventListener('click', testConnection);
  $('grantGateway').addEventListener('click', grantGateway);
  $('testGateway').addEventListener('click', testGateway);
  $('studioBaseUrl').addEventListener('input', refreshGrantStatus);
  $('gatewayBaseUrl').addEventListener('input', refreshGatewayGrantStatus);
  refreshGrantStatus();
  refreshGatewayGrantStatus();

  // Auto-save every field as you edit — no "did it save?" doubt. The explicit
  // Save button stays as a belt-and-suspenders.
  const allFields = [...FIELDS, ...CHECKBOX_FIELDS, 'studioUsername', 'studioPassword'];
  for (const id of allFields) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', autoSave);
  }
}

let autoTimer = null;
function autoSave() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(save, 400);
}

let savedTimer = null;
function showSaved(msg = '✓ Saved') {
  const el = $('status');
  el.textContent = msg;
  el.style.color = 'var(--ok)';
  el.style.fontWeight = '600';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.textContent = ''), 2500);
}

async function save() {
  try {
    const patch = {};
    for (const f of FIELDS) if ($(f)) patch[f] = $(f).value.trim();
    for (const f of CHECKBOX_FIELDS) if ($(f)) patch[f] = $(f).checked;
    await saveSettings(patch);
    await saveGatewayCredentials({
      token: $('gatewayWorkerToken').value,
      workerId: $('gatewayWorkerId').value.trim(),
    });
    await saveCredentials({
      username: $('studioUsername').value.trim(),
      password: $('studioPassword').value, // not trimmed — passwords may have spaces
    });
    chrome.runtime.sendMessage({ type: 'refreshGatewayAgent' }).catch(() => {});
    showSaved();
  } catch (e) {
    // Never fail silently — a storage error must be visible, not look like
    // "nothing saved".
    const el = $('status');
    el.textContent = `Couldn't save: ${e.message || e}`;
    el.style.color = COLOR.err;
    el.style.fontWeight = '600';
  }
}

async function login() {
  const status = $('loginStatus');
  const url = $('studioBaseUrl').value.trim();
  const username = $('studioUsername').value.trim();
  const password = $('studioPassword').value;
  status.textContent = 'Signing in…';
  status.style.color = COLOR.muted;
  if (!url) {
    status.textContent = 'Enter a Server URL first.';
    status.style.color = COLOR.err;
    return;
  }
  try {
    await saveCredentials({ username, password });
    await new StudioClient(url).login(username, password);
    status.textContent = '✓ Signed in — this browser session is ready.';
    status.style.color = COLOR.ok;
  } catch (error) {
    status.textContent = `Sign-in failed: ${error.message}`;
    status.style.color = COLOR.err;
  }
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

// ── Gateway grant + test ────────────────────────────────────────────────────

async function refreshGatewayGrantStatus() {
  const el = $('gatewayGrantStatus');
  const btn = $('grantGateway');
  const url = $('gatewayBaseUrl').value.trim();
  const pat = originPattern(url);
  if (!pat) { el.textContent = ''; btn.disabled = false; return; }
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

async function grantGateway() {
  const url = $('gatewayBaseUrl').value.trim();
  const pat = originPattern(url);
  const el = $('gatewayGrantStatus');
  if (!pat) { el.textContent = 'Enter a valid Gateway URL first.'; el.style.color = COLOR.err; return; }
  if (isLocalUrl(url)) return refreshGatewayGrantStatus();
  try {
    const granted = await chrome.permissions.request({ origins: [pat] });
    if (!granted) { el.textContent = 'Permission declined.'; el.style.color = COLOR.err; return; }
    el.textContent = '✓ Granted.';
    el.style.color = COLOR.ok;
  } catch (error) {
    el.textContent = `Grant failed: ${error.message || error}`;
    el.style.color = COLOR.err;
  }
}

async function testGateway() {
  const status = $('gatewayTestStatus');
  const url = $('gatewayBaseUrl').value.trim();
  status.textContent = 'Testing…';
  status.style.color = COLOR.muted;
  if (!url) { status.textContent = 'Enter a Gateway URL first.'; status.style.color = COLOR.err; return; }
  if (!isLocalUrl(url)) {
    const pat = originPattern(url);
    if (!pat || !(await chrome.permissions.contains({ origins: [pat] }).catch(() => false))) {
      status.textContent = 'Grant Gateway access first.';
      status.style.color = COLOR.warn;
      return;
    }
  }
  if (!$('gatewayWorkerToken').value || !$('gatewayWorkerId').value.trim()) {
    status.textContent = 'Enter worker token and ID first.';
    status.style.color = COLOR.warn;
    return;
  }
  try {
    await save();
    const result = await chrome.runtime.sendMessage({ type: 'testGatewayConnection' });
    if (!result?.ok) throw new Error(result?.error || 'No response from Gateway.');
    showGatewayHealth({ ok: true, at: Date.now() });
  } catch (error) {
    showGatewayHealth({ ok: false, at: Date.now(), error: error.message || error });
  }
}

function showGatewayHealth({ ok, at, error = '' }) {
  const status = $('gatewayTestStatus');
  const when = Number.isFinite(Number(at)) ? new Date(Number(at)).toLocaleString() : 'just now';
  status.textContent = ok ? `✓ Gateway connected (${when}).` : `✗ Gateway unavailable (${when}): ${error}`;
  status.style.color = ok ? COLOR.ok : COLOR.err;
}
