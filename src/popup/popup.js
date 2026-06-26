import { getSettings, saveSettings } from '../lib/config.js';
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
  $('loadVoices').addEventListener('click', loadVoices);
  await initVoices();

  // Save-target selector. Project-folder saving needs companion identifiers,
  // so in paste mode we force Downloads.
  const saveSel = $('saveTarget');
  saveSel.value = settings.saveTarget || 'project';
  saveSel.addEventListener('change', updatePreview);
  if (settings.mode !== 'companion') {
    saveSel.value = 'download';
    $('saveTargetLabel').hidden = true;
  }

  if (settings.mode === 'companion') {
    $('companionPane').hidden = false;
    $('generateAll').hidden = false;
    $('generateAll').addEventListener('click', onGenerateAll);
    chrome.runtime.onMessage.addListener(onBatchProgress);
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
  const raw = await client.listEpisodes(slug);
  const episodes = Array.isArray(raw) ? raw : raw.episodes || [];
  const sel = $('episode');
  sel.innerHTML = '';
  for (const ep of episodes) {
    const opt = document.createElement('option');
    // Episode identity = episode_code (e.g. "EP0001"); the title is needed
    // to resolve the on-disk folder "CODE - Title".
    const code = ep.episode_code || ep.code || '';
    opt.value = code;
    opt.dataset.code = code;
    opt.dataset.title = ep.title || '';
    opt.textContent = `${code} ${ep.title || ''}`.trim();
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
    const rows = await client.chapterList(slug, episodeId, ctx.episodeTitle);
    const list = Array.isArray(rows) ? rows : rows.chapters || [];
    for (const ch of list) {
      const opt = document.createElement('option');
      const num = ch.number ?? ch.chapterNumber;
      opt.value = num;
      // Pad the number for a tidy filename token ("03 A Future Frozen…").
      opt.dataset.num = String(num).padStart(2, '0');
      opt.dataset.label = ch.title || ch.label || `Chapter ${num}`;
      opt.dataset.chars = ch.character_count ?? '';
      opt.textContent = `${opt.dataset.num} ${opt.dataset.label}`;
      sel.appendChild(opt);
    }
    sel.onchange = updatePreview;
  } catch {
    status('Could not load chapters for this episode.');
  }
  updatePreview();
}

// ── Batch: generate all chapters ────────────────────────────────────────────
function onBatchProgress(msg) {
  if (msg?.type !== 'batchProgress') return;
  const n = msg.index + 1;
  if (msg.state === 'running') status(`(${n}/${msg.total}) generating ${msg.label}…`);
  else if (msg.state === 'failed') status(`(${n}/${msg.total}) ${msg.label} failed: ${msg.error}`);
}

async function onGenerateAll() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const target = $('saveTarget').value;
  const slug = $('project').value;
  const opts = [...$('chapter').options];
  if (!opts.length) return status('No chapters to generate.');

  setBusy(true);
  status('Loading chapter text…');
  try {
    // Pre-fetch each chapter's text (fast); the slow generate loop runs in the
    // worker so it survives the popup closing.
    const chapters = [];
    for (const opt of opts) {
      const num = opt.value;
      const res = await client.chapterContent(slug, ctx.episodeCode, num, ctx.episodeTitle);
      const text = res.content || res.text || '';
      if (!text.trim()) continue; // skip empty/unexpanded chapters
      const tokens = {
        project: ctx.project || '',
        episodeCode: ctx.episodeCode || '',
        episodeTitle: ctx.episodeTitle || '',
        chapterNum: opt.dataset.num || num,
        chapterLabel: opt.dataset.label || '',
      };
      chapters.push({
        chapterNumber: num,
        label: opt.dataset.label || `Chapter ${num}`,
        text,
        downloadPath: buildDownloadPath(settings, tokens),
      });
    }
    if (!chapters.length) return status('No chapters with script text found.');

    if (target !== settings.saveTarget) settings = await saveSettings({ saveTarget: target });
    status(`Generating ${chapters.length} chapters…`);
    const result = await chrome.runtime.sendMessage({
      type: 'runBatch',
      batch: { slug, episodeCode: ctx.episodeCode, target, voice, chapters },
    });
    if (result?.ok) {
      const tail = result.failed ? ` (${result.failed} failed)` : '';
      status(`Done: ${result.succeeded}/${result.total} chapters saved${tail}.`);
    } else {
      status(`Batch failed: ${result?.error || 'unknown error'}`);
    }
  } catch (e) {
    status(`Batch error: ${e.message || e}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  $('generate').disabled = b;
  $('generateAll').disabled = b;
}

// ── Voices ─────────────────────────────────────────────────────────────────
function renderVoices(voices) {
  const sel = $('voice');
  sel.innerHTML = '';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.title || v.id;
    sel.appendChild(opt);
  }
  if (settings.fishVoice) sel.value = settings.fishVoice;
}

async function initVoices() {
  const { voices } = await chrome.storage.local.get('voices');
  if (Array.isArray(voices) && voices.length) renderVoices(voices);
  else await loadVoices();
}

async function loadVoices() {
  status('Loading voices from fish.audio…');
  const res = await chrome.runtime.sendMessage({ type: 'listVoices' });
  if (!res?.ok) return status(`Couldn't load voices: ${res?.error || 'open fish.audio and log in'}`);
  await chrome.storage.local.set({ voices: res.voices });
  renderVoices(res.voices);
  status('');
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
    chapterNum: chOpt?.dataset.num || $('chapter').value || '',
    chapterLabel: chOpt?.dataset.label || '',
  };
}

function updatePreview() {
  const tokens = currentTokens();
  if ($('saveTarget').value === 'project') {
    const slug = $('project').value || '';
    const file = `${tokens.episodeCode}_Chapter_${tokens.chapterNum || '??'}.mp3`;
    $('filenamePreview').textContent = `↳ ${slug} episode audio folder / ${file}`;
  } else {
    $('filenamePreview').textContent = `↳ Downloads/${buildDownloadPath(settings, tokens)}`;
  }
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
    const res = await client.chapterContent(slug, episodeId, chapter, ctx.episodeTitle);
    text = res.content || res.text || '';
  }
  if (!text) return status('No script text to generate.');

  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const target = $('saveTarget').value;
  // Remember the chosen voice + target as defaults.
  const patch = {};
  if (voice !== settings.fishVoice) patch.fishVoice = voice;
  if (target !== settings.saveTarget) patch.saveTarget = target;
  if (Object.keys(patch).length) settings = await saveSettings(patch);

  const job = { text, voice, target };
  if (target === 'project') {
    job.slug = $('project').value;
    job.episodeCode = tokens.episodeCode;
    job.chapterNumber = $('chapter').value; // numeric chapter from chapter-list
  } else {
    job.downloadPath = buildDownloadPath(settings, tokens);
  }

  status(target === 'project' ? 'Generating + saving to project…' : 'Generating on fish.audio…');
  const result = await chrome.runtime.sendMessage({ type: 'runJob', job });
  if (result?.ok) {
    status(target === 'project' ? `Saved to project: ${result.savedAs}` : `Saved: ${result.savedAs}`);
  } else {
    status(`Failed: ${result?.error || 'unknown error'}`);
  }
}
