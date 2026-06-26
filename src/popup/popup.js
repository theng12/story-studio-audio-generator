import { getSettings, saveSettings, getCredentials } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { buildDownloadPath } from '../lib/naming.js';

const $ = (id) => document.getElementById(id);
const status = (msg) => ($('status').textContent = msg || '');
const pad = (n) => String(n).padStart(2, '0');

let settings;
let client; // StudioClient (companion mode)
let ctx = {}; // { project, projectSlug, episodeCode, episodeTitle }
let episodesByProject = {}; // slug -> [episode objects with .status]
let scriptCache = {}; // episodeCode -> script-content response (for intro text)

// An episode is worth showing when its script is done but audio isn't.
const isEligible = (ep) => !!(ep.status && ep.status.script && !ep.status.audio);

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
  saveSel.addEventListener('change', () => {
    persist({ saveTarget: saveSel.value });
    updatePreview();
  });
  if (settings.mode !== 'companion') {
    saveSel.value = 'download';
    $('saveTargetLabel').hidden = true;
  }

  // Auto-tag toggle (both modes).
  $('autoTag').checked = !!settings.autoTag;
  $('autoTag').addEventListener('change', () => persist({ autoTag: $('autoTag').checked }));

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

// Persist a settings patch and keep our local copy in sync.
async function persist(patch) {
  settings = await saveSettings(patch);
}

// ── Companion mode ─────────────────────────────────────────────────────────
//
// We do NOT pre-check /auth/me. On localhost the Story Studio server bypasses
// auth for loopback requests, so no login is needed at all — and /auth/me
// (a public endpoint that always checks the cookie) would wrongly 401 and
// force a needless login prompt. Instead we just load the data; only a real
// 401 from a data call (a remote/tailnet server) shows the login form.
async function initCompanion() {
  client = new StudioClient(settings.studioBaseUrl);
  try {
    await loadCompanionData();
  } catch (e) {
    if (e.status !== 401) {
      status(`Can't reach Story Studio at ${settings.studioBaseUrl}. Is it running?`);
      return;
    }
    // A real 401 means a remote server that needs a login. Use the credentials
    // saved in Settings (localhost never reaches here — it bypasses auth).
    const cred = await getCredentials();
    if (!cred.username || !cred.password) {
      status('This server needs a login — add it in Settings (⚙).');
      return;
    }
    try {
      status('Signing in…');
      await client.login(cred.username, cred.password);
      await loadCompanionData();
      status('');
    } catch {
      status('Saved login was rejected — update it in Settings (⚙).');
    }
  }
}

// Load every project's episodes once, then show only projects that have at
// least one episode needing audio.
async function loadCompanionData() {
  status('Scanning projects…');
  const projects = await client.listProjects();
  await Promise.all(
    projects.map(async (p) => {
      try {
        const raw = await client.listEpisodes(p.slug);
        episodesByProject[p.slug] = Array.isArray(raw) ? raw : raw.episodes || [];
      } catch {
        episodesByProject[p.slug] = [];
      }
    })
  );

  const eligible = projects.filter((p) => (episodesByProject[p.slug] || []).some(isEligible));
  const sel = $('project');
  sel.innerHTML = '';
  for (const p of eligible) {
    const opt = document.createElement('option');
    opt.value = p.slug;
    opt.textContent = p.name || p.slug;
    sel.appendChild(opt);
  }
  if (!eligible.length) {
    status('No episodes need audio — every script already has its audio. 🎉');
    return;
  }
  // Restore last-used project if it's still eligible.
  if (settings.lastProject && eligible.some((p) => p.slug === settings.lastProject)) {
    sel.value = settings.lastProject;
  }
  sel.onchange = () => {
    persist({ lastProject: sel.value });
    loadEpisodes();
  };
  status('');
  await loadEpisodes();
}

async function loadEpisodes() {
  const slug = $('project').value;
  ctx.projectSlug = slug;
  ctx.project = $('project').selectedOptions[0]?.textContent || slug;
  const eps = (episodesByProject[slug] || []).filter(isEligible);
  const sel = $('episode');
  sel.innerHTML = '';
  for (const ep of eps) {
    const code = ep.episode_code || ep.code || '';
    const opt = document.createElement('option');
    opt.value = code;
    opt.dataset.title = ep.title || '';
    opt.dataset.hasIntro = ep.status?.introduction ? '1' : '';
    opt.textContent = `${code} ${ep.title || ''}`.trim();
    sel.appendChild(opt);
  }
  if (settings.lastEpisode && [...sel.options].some((o) => o.value === settings.lastEpisode)) {
    sel.value = settings.lastEpisode;
  }
  sel.onchange = () => {
    persist({ lastEpisode: sel.value });
    loadSections();
  };
  if (eps.length) await loadSections();
}

// Build the chapter/intro dropdown from the episode's MISSING audio files.
async function loadSections() {
  const slug = ctx.projectSlug;
  const epOpt = $('episode').selectedOptions[0];
  ctx.episodeCode = epOpt?.value || '';
  ctx.episodeTitle = epOpt?.dataset.title || '';
  const sel = $('chapter');
  sel.innerHTML = '';
  status('Finding missing audio…');
  try {
    const [audio, chapterRows] = await Promise.all([
      client.audioStatus(slug, ctx.episodeCode),
      client.chapterList(slug, ctx.episodeCode, ctx.episodeTitle).catch(() => ({ chapters: [] })),
    ]);
    const titles = {};
    for (const c of chapterRows.chapters || chapterRows || []) {
      titles[c.number ?? c.chapterNumber] = c.title || c.label;
    }
    const sections = [];
    for (const f of audio.missing_files || []) {
      if (/_Introduction\.(mp3|wav)$/i.test(f)) {
        sections.push({ slug: 'Introduction', kind: 'intro', num: null, label: 'Introduction' });
      } else {
        const m = f.match(/_Chapter_(\d+)\.(?:mp3|wav)$/i);
        if (m) {
          const num = parseInt(m[1], 10);
          sections.push({
            slug: `Chapter_${pad(num)}`,
            kind: 'chapter',
            num,
            label: `${pad(num)} ${titles[num] || `Chapter ${num}`}`,
          });
        }
      }
    }
    // Intro first, then chapters in order.
    sections.sort((a, b) =>
      a.kind === b.kind ? (a.num || 0) - (b.num || 0) : a.kind === 'intro' ? -1 : 1
    );
    for (const s of sections) {
      const opt = document.createElement('option');
      opt.value = s.slug;
      opt.dataset.kind = s.kind;
      opt.dataset.num = s.num ?? '';
      opt.dataset.label = s.label;
      opt.textContent = s.label;
      sel.appendChild(opt);
    }
    sel.onchange = updatePreview;
    status(sections.length ? '' : 'This episode already has all its audio.');
  } catch (e) {
    status(`Could not load sections: ${e.message || e}`);
  }
  updatePreview();
}

// Fetch the narration text for one section (chapter or intro).
async function sectionText(kind, num) {
  if (kind === 'intro') {
    if (!scriptCache[ctx.episodeCode]) {
      scriptCache[ctx.episodeCode] = await client.scriptContent(
        ctx.projectSlug,
        ctx.episodeCode,
        ctx.episodeTitle
      );
    }
    return scriptCache[ctx.episodeCode]?.introduction?.content || '';
  }
  const res = await client.chapterContent(ctx.projectSlug, ctx.episodeCode, num, ctx.episodeTitle);
  return res.content || res.text || '';
}

// ── Batch: generate all missing sections ────────────────────────────────────
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
  const slug = ctx.projectSlug;
  const opts = [...$('chapter').options];
  if (!opts.length) return status('Nothing to generate — no missing audio.');

  setBusy(true);
  status('Loading script text…');
  try {
    const chapters = [];
    for (const opt of opts) {
      const text = await sectionText(opt.dataset.kind, opt.dataset.num);
      if (!text.trim()) continue; // skip empty/unexpanded sections
      chapters.push({
        slug: opt.value,
        chapterNumber: opt.dataset.num || null,
        label: opt.dataset.label,
        text,
        downloadPath: buildDownloadPath(settings, sectionTokens(opt)),
      });
    }
    if (!chapters.length) return status('No sections with script text found.');

    persist({ saveTarget: target, fishVoice: voice });
    status(`Generating ${chapters.length} section(s)…`);
    const result = await chrome.runtime.sendMessage({
      type: 'runBatch',
      batch: {
        slug,
        episodeCode: ctx.episodeCode,
        target,
        voice,
        autoTag: $('autoTag').checked,
        chapters,
      },
    });
    if (result?.ok) {
      const tail = result.failed ? ` (${result.failed} failed)` : '';
      status(`Done: ${result.succeeded}/${result.total} saved${tail}.`);
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
function sectionTokens(opt) {
  return {
    project: ctx.project || '',
    episodeCode: ctx.episodeCode || '',
    episodeTitle: ctx.episodeTitle || '',
    chapterNum: opt?.dataset.num || '',
    chapterLabel: opt?.dataset.label || '',
  };
}

function currentTokens() {
  if (settings.mode === 'paste') {
    const code = $('pasteCode').value.trim() || 'audio';
    const label = $('pasteLabel').value.trim();
    return { project: '', episodeCode: code, episodeTitle: '', chapterNum: '', chapterLabel: label };
  }
  return sectionTokens($('chapter').selectedOptions[0]);
}

function updatePreview() {
  const tokens = currentTokens();
  if (settings.mode === 'companion' && $('saveTarget').value === 'project') {
    const slug = $('chapter').value || 'Chapter_??';
    $('filenamePreview').textContent = `↳ ${ctx.episodeCode || '??'} audio folder / ${ctx.episodeCode}_${slug}.mp3`;
  } else {
    $('filenamePreview').textContent = `↳ Downloads/${buildDownloadPath(settings, tokens)}`;
  }
}

async function onGenerate() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const target = $('saveTarget').value;
  const autoTag = $('autoTag').checked;

  let text;
  let sectionSlug = '';
  let chapterNumber = '';
  const tokens = currentTokens();
  if (settings.mode === 'paste') {
    text = $('pasteText').value.trim();
  } else {
    const opt = $('chapter').selectedOptions[0];
    if (!opt) return status('Nothing to generate — no missing audio.');
    sectionSlug = opt.value;
    chapterNumber = opt.dataset.num || '';
    status('Loading script text…');
    text = await sectionText(opt.dataset.kind, opt.dataset.num);
  }
  if (!text) return status('No script text to generate.');

  persist({ fishVoice: voice, saveTarget: target });

  const job = { text, voice, target, autoTag };
  if (target === 'project') {
    job.slug = ctx.projectSlug;
    job.episodeCode = ctx.episodeCode;
    job.sectionSlug = sectionSlug;
    job.chapterNumber = chapterNumber;
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
