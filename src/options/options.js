import {
  getSettings,
  saveSettings,
  getCredentials,
  getFleetPairingSecret,
  saveCredentials,
  saveFleetPairingSecret,
  DEFAULTS,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
// Fields that have an input on THIS page. (The voice lives in the side panel,
// not here — don't list fishVoice or $(f) is null and load() aborts before the
// buttons are wired.)
const FIELDS = ['theme', 'studioBaseUrl', 'fleetHubUrl', 'fleetAgentName'];
const CHECKBOX_FIELDS = ['fleetAgentEnabled', 'fleetTelemetryDetails', 'fleetQueueControlEnabled'];

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
  $('fleetPairingSecret').value = await getFleetPairingSecret();
  const { fleetStatus } = await chrome.storage.local.get('fleetStatus');
  if (fleetStatus?.at) showFleetHealth(fleetStatus);
  $('save').addEventListener('click', save);
  $('login').addEventListener('click', login);
  $('grantAccess').addEventListener('click', grantAccess);
  $('testConnection').addEventListener('click', testConnection);
  $('grantFleet').addEventListener('click', grantFleet);
  $('testFleet').addEventListener('click', testFleet);
  $('studioBaseUrl').addEventListener('input', refreshGrantStatus);
  $('fleetHubUrl').addEventListener('input', refreshFleetGrantStatus);
  refreshGrantStatus();
  refreshFleetGrantStatus();

  // Auto-save every field as you edit — no "did it save?" doubt. The explicit
  // Save button stays as a belt-and-suspenders.
  const allFields = [...FIELDS, ...CHECKBOX_FIELDS, 'studioUsername', 'studioPassword', 'fleetPairingSecret'];
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

async function save({ refreshFleet = true } = {}) {
  try {
    const patch = {};
    for (const f of FIELDS) if ($(f)) patch[f] = $(f).value.trim();
    for (const f of CHECKBOX_FIELDS) if ($(f)) patch[f] = $(f).checked;
    await saveSettings(patch);
    await saveFleetPairingSecret($('fleetPairingSecret').value);
    await saveCredentials({
      username: $('studioUsername').value.trim(),
      password: $('studioPassword').value, // not trimmed — passwords may have spaces
    });
    // Keep the background alarm in sync with the opt-in toggle. This only
    // reports telemetry; it never opens a provider tab or starts queue work.
    if (refreshFleet) chrome.runtime.sendMessage({ type: 'refreshFleetAgent' }).catch(() => {});
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

async function refreshFleetGrantStatus() {
  const el = $('fleetGrantStatus');
  const btn = $('grantFleet');
  const url = $('fleetHubUrl').value.trim();
  const pat = originPattern(url);
  if (!pat) {
    el.textContent = '';
    btn.disabled = false;
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

async function grantFleet() {
  const url = $('fleetHubUrl').value.trim();
  const pat = originPattern(url);
  const el = $('fleetGrantStatus');
  if (!pat) {
    el.textContent = 'Enter a valid Hub URL first.';
    el.style.color = COLOR.err;
    return;
  }
  if (isLocalUrl(url)) return refreshFleetGrantStatus();
  try {
    const granted = await chrome.permissions.request({ origins: [pat] });
    if (!granted) {
      el.textContent = 'Permission declined.';
      el.style.color = COLOR.err;
      return;
    }
    el.textContent = '✓ Access granted.';
    el.style.color = COLOR.ok;
  } catch (error) {
    el.textContent = `Grant failed: ${error.message || error}`;
    el.style.color = COLOR.err;
  }
}

async function testFleet() {
  const status = $('fleetTestStatus');
  const url = $('fleetHubUrl').value.trim();
  status.textContent = 'Testing…';
  status.style.color = COLOR.muted;
  if (!url) {
    status.textContent = 'Enter a Hub URL first.';
    status.style.color = COLOR.err;
    return;
  }
  if (!isLocalUrl(url)) {
    const pat = originPattern(url);
    if (!pat || !(await chrome.permissions.contains({ origins: [pat] }).catch(() => false))) {
      status.textContent = 'Grant Hub access first.';
      status.style.color = COLOR.warn;
      return;
    }
  }
  if (!$('fleetPairingSecret').value) {
    status.textContent = 'Enter the local pairing secret first.';
    status.style.color = COLOR.warn;
    return;
  }
  try {
    // The worker owns signing and verifies the response. Save first so the
    // test uses exactly the displayed URL/secret without exposing either.
    await save({ refreshFleet: false });
    const result = await chrome.runtime.sendMessage({ type: 'testFleetConnection' });
    if (!result?.ok) throw new Error(result?.error || 'No response from Fleet Hub.');
    showFleetHealth({ ok: true, at: Date.now() });
  } catch (error) {
    showFleetHealth({ ok: false, at: Date.now(), error: error.message || error });
  }
}

function showFleetHealth({ ok, at, error = '' }) {
  const status = $('fleetTestStatus');
  const when = Number.isFinite(Number(at)) ? new Date(Number(at)).toLocaleString() : 'just now';
  status.textContent = ok ? `✓ Authenticated Fleet Hub connection (${when}).` : `✗ Fleet Hub unavailable (${when}): ${error}`;
  status.style.color = ok ? COLOR.ok : COLOR.err;
}

document.addEventListener('DOMContentLoaded', load);
