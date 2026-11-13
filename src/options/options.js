import {
  getSettings,
  saveSettings,
  getGatewayCredentials,
  saveGatewayCredentials,
  DEFAULTS,
} from '../lib/config.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
// Fields that have an input on THIS page. (The voice lives in the side panel,
// not here — don't list fishVoice or $(f) is null and load() aborts before the
// buttons are wired.)
const FIELDS = ['theme', 'gatewayBaseUrl'];
const CHECKBOX_FIELDS = ['gatewayModeEnabled'];

const COLOR = { ok: '#0a7a0a', warn: '#b56b00', err: '#b00', muted: 'var(--muted)' };

async function load() {
  await initTheme();
  const s = await getSettings();
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? DEFAULTS[f] ?? '';
  for (const f of CHECKBOX_FIELDS) if ($(f)) $(f).checked = s[f] === true;
  // Apply the theme live as soon as it's changed (before the debounced save).
  $('theme').addEventListener('change', () => setTheme($('theme').value));
  const gwCreds = await getGatewayCredentials();
  $('gatewayWorkerToken').value = gwCreds.token || '';
  $('gatewayWorkerId').value = gwCreds.workerId || '';
  $('save').addEventListener('click', save);
  $('grantGateway').addEventListener('click', grantGateway);
  $('testGateway').addEventListener('click', testGateway);
  $('gatewayBaseUrl').addEventListener('input', refreshGatewayGrantStatus);
  refreshGatewayGrantStatus();

  // Auto-save every field as you edit — no "did it save?" doubt. The explicit
  // Save button stays as a belt-and-suspenders.
  const allFields = [...FIELDS, ...CHECKBOX_FIELDS];
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

// ── Host-permission self-grant (so a Gateway on any host works without a
// hardcoded whitelist — the user authorizes their own URL at runtime). ──
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
