import {
  getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
  getApiKeys,
  saveApiKeys,
  DEFAULTS,
} from '../lib/config.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['mode', 'studioBaseUrl', 'saveTarget', 'downloadSubdir', 'filenameTemplate', 'fishVoice'];

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

document.addEventListener('DOMContentLoaded', load);
