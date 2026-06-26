import { getSettings } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { buildDownloadPath } from '../lib/naming.js';

const $ = (id) => document.getElementById(id);
const status = (msg) => ($('status').textContent = msg || '');

let settings;
let client; // StudioClient (companion mode)
let ctx = {}; // { project, episodeCode, episodeTitle, chapterNum, chapterLabel }

document.addEventListener('DOMContentLoaded', init);

async function init() {
  settings = await getSettings();
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('generate').addEventListener('click', onGenerate);

  if (settings.mode === 'companion') {
    $('companionPane').hidden = false;
    await initCompanion();
  } else {
    $('pastePane').hidden = false;
    ['pasteCode', 'pasteLabel', 'pasteText'].forEach((id) =>
      $(id).addEventListener('input', updatePreview)
    );
    updatePreview();
  }
}

// ── Companion mode ─────────────────────────────────────────────────────────
async function initCompanion() {
  client = new StudioClient(settings.studioBaseUrl);
  try {
    await client.whoami(); // throws 401 if server mode + not logged in
    await loadProjects();
  } catch (e) {
    if (e.status === 401) {
      $('loginRow').hidden = false;
      $('loginBtn').addEventListener('click', doLogin);
      status('Server mode: please log in.');
    } else {
      status(`Can't reach Story Studio at ${settings.studioBaseUrl}. Is it running?`);
    }
  }
}

async function doLogin() {
  try {
    status('Logging in…');
    await client.login($('username').value.trim(), $('password').value);
    $('loginRow').hidden = true;
    $('password').value = '';
    await loadProjects();
    status('');
  } catch (e) {
    status(`Login failed: ${e.message}`);
  }
}

async function loadProjects() {
  const projects = await client.listProjects();
  const sel = $('project');
  sel.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.slug;
    opt.textContent = p.name || p.slug;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', loadEpisodes);
  if (projects.length) await loadEpisodes();
}

async function loadEpisodes() {
  const slug = $('project').value;
  ctx.project = $('project').selectedOptions[0]?.textContent || slug;
  const episodes = await client.listEpisodes(slug);
  const sel = $('episode');
  sel.innerHTML = '';
  for (const ep of episodes) {
    const opt = document.createElement('option');
    // Episode identity fields vary; carry both code + title for naming.
    opt.value = ep.id || ep.code || ep.episodeId;
    opt.dataset.code = ep.code || ep.id || '';
    opt.dataset.title = ep.title || '';
    opt.textContent = `${ep.code || ''} ${ep.title || ''}`.trim();
    sel.appendChild(opt);
  }
  sel.onchange = loadChapters;
  if (episodes.length) await loadChapters();
}

async function loadChapters() {
  const slug = $('project').value;
  const epOpt = $('episode').selectedOptions[0];
  ctx.episodeCode = epOpt?.dataset.code || '';
  ctx.episodeTitle = epOpt?.dataset.title || '';
  const episodeId = $('episode').value;
  const sel = $('chapter');
  sel.innerHTML = '';
  try {
    const rows = await client.chapterList(slug, episodeId);
    const list = Array.isArray(rows) ? rows : rows.chapters || [];
    for (const ch of list) {
      const opt = document.createElement('option');
      opt.value = ch.number ?? ch.chapterNumber;
      opt.dataset.label = ch.label || ch.title || `Chapter ${opt.value}`;
      opt.textContent = opt.dataset.label;
      sel.appendChild(opt);
    }
    sel.onchange = updatePreview;
  } catch {
    status('Could not load chapters for this episode.');
  }
  updatePreview();
}

// ── Shared ─────────────────────────────────────────────────────────────────
function currentTokens() {
  if (settings.mode === 'paste') {
    const code = $('pasteCode').value.trim() || 'audio';
    const label = $('pasteLabel').value.trim();
    return { project: '', episodeCode: code, episodeTitle: '', chapterNum: '', chapterLabel: label };
  }
  const chOpt = $('chapter').selectedOptions[0];
  return {
    project: ctx.project || '',
    episodeCode: ctx.episodeCode || '',
    episodeTitle: ctx.episodeTitle || '',
    chapterNum: $('chapter').value || '',
    chapterLabel: chOpt?.dataset.label || '',
  };
}

function updatePreview() {
  const path = buildDownloadPath(settings, currentTokens());
  $('filenamePreview').textContent = `↳ Downloads/${path}`;
}

async function onGenerate() {
  let text;
  const tokens = currentTokens();
  if (settings.mode === 'paste') {
    text = $('pasteText').value.trim();
  } else {
    const slug = $('project').value;
    const episodeId = $('episode').value;
    const chapter = $('chapter').value;
    status('Loading chapter text…');
    const res = await client.chapterContent(slug, episodeId, chapter);
    text = res.content || res.text || '';
  }
  if (!text) return status('No script text to generate.');

  const downloadPath = buildDownloadPath(settings, tokens);
  status('Generating on fish.audio…');
  const result = await chrome.runtime.sendMessage({
    type: 'runJob',
    job: { text, downloadPath, voice: settings.fishVoice },
  });
  status(result?.ok ? `Saved: ${result.savedAs}` : `Failed: ${result?.error || 'unknown error'}`);
}
