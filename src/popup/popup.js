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

  // Show the last status (a generation that's still running, or its result),
  // and keep it live — so closing/reopening the popup doesn't lose progress.
  const { lastStatus } = await chrome.storage.local.get('lastStatus');
  if (lastStatus && Date.now() - lastStatus.ts < 30 * 60 * 1000) status(lastStatus.text);
  const { queue } = await chrome.storage.local.get('queue');
  renderQueueBar(queue || []);
  $('clearQueue').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lastStatus) status(changes.lastStatus.newValue?.text || '');
    if (changes.queue) onQueueChanged(changes.queue.oldValue || [], changes.queue.newValue || []);
  });

  if (settings.mode === 'companion') {
    $('companionPane').hidden = false;
    $('generateAll').hidden = false;
    $('queueProject').hidden = false;
    $('generateAll').addEventListener('click', onGenerateAll);
    $('queueProject').addEventListener('click', onQueueProject);
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

// Per-project episode list cache (storage). Avoids re-scanning large projects
// on every popup open. Fresh for EP_TTL; invalidated after we generate audio.
const EP_TTL = 5 * 60 * 1000;

async function fetchEpisodes(slug, force = false) {
  if (!force) {
    const { epCache = {} } = await chrome.storage.local.get('epCache');
    const hit = epCache[slug];
    if (hit && Date.now() - hit.ts < EP_TTL) return hit.episodes;
  }
  const raw = await client.listEpisodes(slug);
  const episodes = Array.isArray(raw) ? raw : raw.episodes || [];
  const { epCache = {} } = await chrome.storage.local.get('epCache');
  epCache[slug] = { ts: Date.now(), episodes };
  await chrome.storage.local.set({ epCache });
  return episodes;
}

async function invalidateEpisodes(slug) {
  const { epCache = {} } = await chrome.storage.local.get('epCache');
  delete epCache[slug];
  await chrome.storage.local.set({ epCache });
}

// Populate the project dropdown (cheap — just a manifest read) and lazily load
// episodes for the selected project only. No more scanning every project.
async function loadCompanionData() {
  const projects = await client.listProjects();
  const sel = $('project');
  sel.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.slug;
    opt.textContent = p.name || p.slug;
    sel.appendChild(opt);
  }
  if (!projects.length) {
    status('No projects found.');
    return;
  }
  if (settings.lastProject && projects.some((p) => p.slug === settings.lastProject)) {
    sel.value = settings.lastProject;
  }
  sel.onchange = () => {
    persist({ lastProject: sel.value });
    loadEpisodes();
  };
  await loadEpisodes();
}

async function loadEpisodes() {
  const slug = $('project').value;
  ctx.projectSlug = slug;
  ctx.project = $('project').selectedOptions[0]?.textContent || slug;
  status('Loading episodes…');
  episodesByProject[slug] = await fetchEpisodes(slug);
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
  if (eps.length) {
    status('');
    await loadSections();
  } else {
    $('chapter').innerHTML = '';
    updatePreview();
    status('No episodes in this project need audio. 🎉');
  }
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

// ── Queue ───────────────────────────────────────────────────────────────────
//
// All generation goes through the worker's persistent queue (one item at a
// time, human-paced, survives the panel closing). The panel just builds items
// — identifiers only; the worker fetches each section's text from Story Studio
// when it gets to it.

// Build a queue item from a companion section <option>.
function itemFromOption(opt) {
  return {
    kind: opt.dataset.kind, // 'intro' | 'chapter'
    slug: ctx.projectSlug,
    episodeCode: ctx.episodeCode,
    episodeTitle: ctx.episodeTitle,
    sectionSlug: opt.value,
    chapterNumber: opt.dataset.num || null,
    target: $('saveTarget').value,
    voice: $('voice').value,
    autoTag: $('autoTag').checked,
    project: ctx.project || '',
    chapterNum: opt.dataset.num || '',
    chapterLabel: opt.dataset.label || '',
    label: `${ctx.episodeCode} ${opt.dataset.label || opt.value}`,
  };
}

// Queue every missing section of the CURRENT episode.
async function onGenerateAll() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const opts = [...$('chapter').options];
  if (!opts.length) return status('Nothing to queue — no missing audio.');
  persist({ saveTarget: $('saveTarget').value, fishVoice: voice });
  const items = opts.map(itemFromOption);
  const r = await chrome.runtime.sendMessage({ type: 'enqueue', items });
  status(r?.ok ? `Queued ${items.length} section(s) from ${ctx.episodeCode}.` : `Queue failed: ${r?.error || 'no response from the background — reload the extension at chrome://extensions'}`);
}

// Queue every missing section of EVERY eligible episode in the project. The
// worker expands the project (it'd be too many calls to do here).
async function onQueueProject() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  if (!ctx.projectSlug) return;
  persist({ saveTarget: $('saveTarget').value, fishVoice: voice });
  status(`Building a queue for all of ${ctx.project}…`);
  const r = await chrome.runtime.sendMessage({
    type: 'enqueueProject',
    payload: {
      slug: ctx.projectSlug,
      target: $('saveTarget').value,
      voice,
      autoTag: $('autoTag').checked,
    },
  });
  status(
    r?.ok
      ? `Queued ${r.added} section(s) across ${r.episodes} episode(s).`
      : `Queue failed: ${r?.error || 'no response from the background — reload the extension at chrome://extensions'}`
  );
}

function renderQueueBar(queue) {
  const active = queue.filter((i) => i.status === 'pending' || i.status === 'running').length;
  const done = queue.filter((i) => i.status === 'done').length;
  const failed = queue.filter((i) => i.status === 'failed').length;
  if (!queue.length) {
    $('queueBar').hidden = true;
    return;
  }
  $('queueBar').hidden = false;
  const parts = [];
  if (active) parts.push(`${active} queued`);
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  $('queueInfo').textContent = `Queue: ${parts.join(' · ') || 'empty'}`;
}

// When the whole queue finishes, refresh the current episode's section list so
// the ones we just made drop off.
async function onQueueChanged(oldQ, newQ) {
  renderQueueBar(newQ);
  const active = newQ.some((i) => i.status === 'pending' || i.status === 'running');
  const wasActive = oldQ.some((i) => i.status === 'pending' || i.status === 'running');
  if (wasActive && !active && settings.mode === 'companion' && ctx.episodeCode) {
    await invalidateEpisodes(ctx.projectSlug);
    await loadSections();
  }
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

// Queue just the selected section (or the pasted text).
async function onGenerate() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const autoTag = $('autoTag').checked;
  persist({ fishVoice: voice, saveTarget: $('saveTarget').value });

  let item;
  if (settings.mode === 'paste') {
    const text = $('pasteText').value.trim();
    if (!text) return status('Paste some script text first.');
    const code = $('pasteCode').value.trim() || 'audio';
    const label = $('pasteLabel').value.trim() || code;
    item = {
      kind: 'paste',
      text, // worker uses this directly (no Story Studio fetch)
      target: 'download',
      voice,
      autoTag,
      label,
      episodeCode: code,
      episodeTitle: '',
      project: '',
      chapterNum: '',
      chapterLabel: $('pasteLabel').value.trim() || '',
    };
  } else {
    const opt = $('chapter').selectedOptions[0];
    if (!opt) return status('Nothing to generate — no missing audio.');
    item = itemFromOption(opt);
  }

  const r = await chrome.runtime.sendMessage({ type: 'enqueue', items: [item] });
  status(r?.ok ? `Queued ${item.label}.` : `Queue failed: ${r?.error || 'no response from the background — reload the extension at chrome://extensions'}`);
}
