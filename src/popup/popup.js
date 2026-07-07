import { getSettings, saveSettings, getCredentials } from '../lib/config.js';
import { initTheme } from '../lib/theme.js';
import { StudioClient } from '../lib/story-studio.js';
import { buildDownloadPath } from '../lib/naming.js';

const $ = (id) => document.getElementById(id);
const status = (msg) => ($('status').textContent = msg || '');
const pad = (n) => String(n).padStart(2, '0');
const currentProvider = () => $('provider')?.value || settings.provider || 'fish';

// Build a settings patch that remembers the chosen voice for the active provider.
function rememberVoice(voice) {
  const p = currentProvider();
  const patch = { voiceByProvider: { ...(settings.voiceByProvider || {}), [p]: voice } };
  if (p === 'fish') patch.fishVoice = voice; // keep legacy key in sync
  return patch;
}

let settings;
let client; // StudioClient (companion mode)
let ctx = {}; // { project, projectSlug, episodeCode, episodeTitle }
let episodesByProject = {}; // slug -> [episode objects with .status]
let currentSections = []; // [{ slug, kind, num, label, present }] for the section list

// An episode is worth showing when its script is done and (audio is missing, or
// the user asked to also see already-done episodes for re-voicing).
const isEligible = (ep) =>
  !!(ep.status && ep.status.script && (settings?.showDoneEpisodes || !ep.status.audio));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await initTheme();
  const manifest = chrome.runtime.getManifest();
  $('extensionVersion').textContent = `v${manifest.version}`;
  $('extensionVersion').title = `${manifest.name} v${manifest.version}`;
  initWhatsNew(manifest.version);
  settings = await getSettings();
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openProviderPage').addEventListener('click', onOpenProviderPage);
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

  // Provider selector. Switching provider reloads its voices and shows the
  // auto-tag option only for fish.audio (it's a fish-specific feature).
  $('provider').value = settings.provider || 'fish';
  applyProviderUI();
  $('provider').addEventListener('change', async () => {
    await persist({ provider: currentProvider() });
    applyProviderUI();
    await initVoices();
  });

  // Auto-tag toggle.
  $('autoTag').checked = !!settings.autoTag;
  $('autoTag').addEventListener('change', () => persist({ autoTag: $('autoTag').checked }));

  // Show the last status (a generation that's still running, or its result),
  // and keep it live — so closing/reopening the popup doesn't lose progress.
  const { lastStatus } = await chrome.storage.local.get('lastStatus');
  if (lastStatus && Date.now() - lastStatus.ts < 30 * 60 * 1000) status(lastStatus.text);
  const { queue } = await chrome.storage.local.get('queue');
  renderQueueBar(queue || []);
  renderQueueList(queue || []);
  $('clearQueue').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
  });
  // Remove a single pending item (event-delegated).
  $('queueList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.qremove');
    if (btn) await chrome.runtime.sendMessage({ type: 'removeItem', id: btn.dataset.id });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lastStatus) status(changes.lastStatus.newValue?.text || '');
    if (changes.queue) onQueueChanged(changes.queue.oldValue || [], changes.queue.newValue || []);
  });

  if (settings.mode === 'companion') {
    $('companionPane').hidden = false;
    $('generate').hidden = true; // companion uses the multi-select "Queue selected"
    $('queueSelected').hidden = false;
    $('queueProject').hidden = false;
    $('queueSelected').addEventListener('click', onQueueSelected);
    $('queueProject').addEventListener('click', onQueueProject);
    $('testConn').addEventListener('click', testConnection);
    $('selectAll').addEventListener('change', (e) => {
      $('sectionList')
        .querySelectorAll('input[type=checkbox]')
        .forEach((c) => {
          if (!c.disabled) c.checked = e.target.checked;
        });
      updateSelectionSummary();
    });
    // Regeneration toggles.
    $('showDoneEpisodes').checked = !!settings.showDoneEpisodes;
    $('includeExisting').checked = !!settings.includeExisting;
    updateCompanionHints();
    $('showDoneEpisodes').addEventListener('change', async () => {
      await persist({ showDoneEpisodes: $('showDoneEpisodes').checked });
      updateCompanionHints();
      await loadEpisodes();
    });
    $('includeExisting').addEventListener('change', async () => {
      await persist({ includeExisting: $('includeExisting').checked });
      updateCompanionHints();
      renderSections(); // re-render (enables/disables already-voiced rows) — no refetch
    });
    await initCompanion();
  } else {
    $('pastePane').hidden = false;
    $('queueSelected').hidden = true;
    $('queueProject').hidden = true;
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

function updateCompanionHints() {
  const eh = $('episodeHint');
  if (eh) eh.textContent = settings.showDoneEpisodes ? '(all episodes with a script)' : '(script done, audio missing)';
}

// Show provider-specific UI bits (auto-tag is a fish.audio-only feature) and a
// cost note so the paid provider can't be confused for a free one.
const PROVIDER_NOTE = {
  fish: 'Uses your fish.audio web plan (free). Keep a logged-in fish.audio tab.',
  elevenlabs_web: 'Drives your logged-in elevenlabs.io session — no key. Free tier = 10k chars/month. Keep an elevenlabs.io tab open.',
  elevenlabs: 'Uses your ElevenLabs quota — free tier gives 10k chars/month. Needs your API key in Settings.',
  openai: '💲 Paid — OpenAI TTS bills your OpenAI account per use (no free tier).',
};
// Which providers drive a logged-in web tab (vs. calling an API with a key).
const WEB_PROVIDER = { fish: 'fish.audio', elevenlabs_web: 'elevenlabs.io' };
function applyProviderUI() {
  const p = currentProvider();
  $('autoTagLabel').hidden = p !== 'fish';
  $('providerNote').textContent = PROVIDER_NOTE[p] || '';
  // Web-session providers need their page open; offer a manual "open" shortcut
  // rather than the extension popping the page open when you switch providers.
  const site = WEB_PROVIDER[p];
  const openBtn = $('openProviderPage');
  openBtn.hidden = !site;
  if (site) openBtn.textContent = `↗ Open ${site}`;
}

// Open (or focus) the current provider's page — the only place the extension
// opens a provider tab in response to the user, not as a side effect.
async function onOpenProviderPage() {
  const r = await chrome.runtime.sendMessage({ type: 'openProviderPage', provider: currentProvider() });
  if (!r?.ok) status(r?.error || NORESP);
}

// ── What's new (changelog) ──────────────────────────────────────────────────
// Renders CHANGELOG.md (packaged with the extension) in the modal, and shows a
// red dot on the button until the current version's notes have been opened.
function renderChangelog(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  return md
    .split('\n')
    .map((line) => {
      if (/^#\s/.test(line)) return ''; // top-level title — modal already titled
      if (/^##\s/.test(line)) return `<h3 class="cl-ver">${inline(line.replace(/^##\s+/, ''))}</h3>`;
      if (/^\s*-\s/.test(line)) return `<div class="cl-item">• ${inline(line.replace(/^\s*-\s+/, ''))}</div>`;
      if (/^\s*$/.test(line)) return '';
      return `<p>${inline(line)}</p>`;
    })
    .join('');
}

async function openWhatsNew(version) {
  const body = $('whatsNewBody');
  if (!body.dataset.loaded) {
    try {
      const md = await (await fetch(chrome.runtime.getURL('CHANGELOG.md'))).text();
      body.innerHTML = renderChangelog(md);
      body.dataset.loaded = '1';
    } catch {
      body.textContent = "Couldn't load the changelog.";
    }
  }
  $('whatsNewModal').hidden = false;
  $('whatsNewDot').hidden = true;
  chrome.storage.local.set({ whatsNewSeen: version });
}

async function initWhatsNew(version) {
  const { whatsNewSeen } = await chrome.storage.local.get('whatsNewSeen');
  $('whatsNewDot').hidden = whatsNewSeen === version;
  $('whatsNew').onclick = () => openWhatsNew(version);
  $('whatsNewClose').onclick = () => ($('whatsNewModal').hidden = true);
  $('whatsNewModal').onclick = (e) => {
    if (e.target === $('whatsNewModal')) $('whatsNewModal').hidden = true;
  };
}

// How this provider charges — used in the queue confirmation dialogs.
function costPhrase() {
  const p = currentProvider();
  if (p === 'openai') return '💲 bills your paid OpenAI account (per use)';
  if (p === 'elevenlabs' || p === 'elevenlabs_web') return 'uses your ElevenLabs quota';
  return 'uses your fish.audio web plan';
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
      const url = settings.studioBaseUrl || '';
      const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
      const hint = local ? 'is it running?' : 'is it running, did you Grant access + log in (Settings)?';
      status(`Can't reach Story Studio at ${url} — ${hint} (${e.message})`);
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
    fetchEpisodeAudioCounts(slug, eps); // lazily annotate each option with done/total
    await loadSections();
  } else {
    currentSections = [];
    renderSections();
    status('No episodes in this project need audio. 🎉');
  }
}

// Lazily append each episode's audio progress (`· done/total ✓`) to its dropdown
// label, so you can see which episodes are fully voiced without opening each.
// Throttled + abortable — a new project/episode reload bumps the run token.
let epCountRun = 0;
async function fetchEpisodeAudioCounts(slug, eps) {
  const run = ++epCountRun;
  const sel = $('episode');
  for (const ep of eps) {
    if (run !== epCountRun) return;
    const code = ep.episode_code || ep.code || '';
    const opt = [...sel.options].find((o) => o.value === code);
    if (!opt) continue;
    try {
      const a = await client.audioStatus(slug, code);
      const total = a.total ?? (a.present ?? 0) + (a.missing ?? (a.missing_files || []).length);
      const done = a.present ?? Math.max(0, total - (a.missing ?? (a.missing_files || []).length));
      if (total) {
        const base = `${code} ${opt.dataset.title || ''}`.trim();
        opt.textContent = `${base} · ${done}/${total}${done >= total ? ' ✓' : ''}`;
      }
    } catch {
      /* episode without an audio manifest yet — leave the plain label */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

// Load the episode's sections into the multi-select list. Missing-audio
// sections come from audio-status (authoritative); chapter titles + the full
// list come from chapter-list. Already-voiced sections are shown with a badge
// (selectable only in "include existing / re-voice" mode).
async function loadSections() {
  const slug = ctx.projectSlug;
  const epOpt = $('episode').selectedOptions[0];
  ctx.episodeCode = epOpt?.value || '';
  ctx.episodeTitle = epOpt?.dataset.title || '';
  const hasIntro = epOpt?.dataset.hasIntro === '1';
  status('Loading chapters…');
  try {
    const [audio, chapterRows] = await Promise.all([
      client.audioStatus(slug, ctx.episodeCode),
      client.chapterList(slug, ctx.episodeCode, ctx.episodeTitle).catch(() => ({ chapters: [] })),
    ]);

    const missing = new Set();
    for (const f of audio.missing_files || []) {
      if (/_Introduction\.(mp3|wav)$/i.test(f)) missing.add('Introduction');
      else {
        const m = f.match(/_Chapter_(\d+)\.(?:mp3|wav)$/i);
        if (m) missing.add(`Chapter_${pad(parseInt(m[1], 10))}`);
      }
    }

    const titles = {};
    const chapNums = new Set();
    for (const c of chapterRows.chapters || chapterRows || []) {
      const n = c.number ?? c.chapterNumber;
      if (n == null || c.present === false) continue;
      titles[n] = c.title || c.label;
      chapNums.add(n);
    }
    for (const s of missing) {
      const m = s.match(/^Chapter_(\d+)$/);
      if (m) chapNums.add(parseInt(m[1], 10));
    }

    const cand = [];
    if (hasIntro) cand.push({ slug: 'Introduction', kind: 'intro', num: null, label: 'Introduction' });
    for (const num of [...chapNums].sort((a, b) => a - b)) {
      cand.push({ slug: `Chapter_${pad(num)}`, kind: 'chapter', num, label: `${pad(num)} ${titles[num] || `Chapter ${num}`}` });
    }
    for (const s of cand) s.present = !missing.has(s.slug);
    currentSections = cand;
    renderSections();
    status('');
  } catch (e) {
    currentSections = [];
    renderSections();
    status(`Could not load chapters: ${e.message || e}`);
  }
}

// Render the section checkboxes. Missing-audio rows are pre-checked; already
// voiced rows show a ✓ badge and are only selectable when re-voice is on.
function renderSections() {
  const wrap = $('sectionList');
  wrap.innerHTML = '';
  if (!currentSections.length) {
    wrap.innerHTML = '<div class="empty">No chapters with a script found.</div>';
    updateSelectionSummary();
    return;
  }
  const includeExisting = !!settings.includeExisting;
  for (const s of currentSections) {
    const row = document.createElement('div');
    row.className = 'sec' + (s.present ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.slug = s.slug;
    cb.checked = !s.present;
    cb.disabled = s.present && !includeExisting;
    cb.onchange = updateSelectionSummary;
    const lab = document.createElement('span');
    lab.className = 'seclabel';
    lab.textContent = s.label;
    row.append(cb, lab);
    if (s.present) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '✓ audio';
      row.appendChild(b);
    }
    wrap.appendChild(row);
  }
  updateSelectionSummary();
}

function selectedSections() {
  const slugs = new Set(
    [...$('sectionList').querySelectorAll('input[type=checkbox]')]
      .filter((c) => c.checked && !c.disabled)
      .map((c) => c.dataset.slug)
  );
  return currentSections.filter((s) => slugs.has(s.slug));
}

function updateSelectionSummary() {
  const done = currentSections.filter((s) => s.present).length;
  $('sectionsSummary').textContent = currentSections.length
    ? `Chapters / Intro — ${done}/${currentSections.length} have audio`
    : 'Chapters / Intro';
  const n = selectedSections().length;
  const btn = $('queueSelected');
  btn.disabled = n === 0;
  btn.textContent = n ? `Queue selected (${n})` : 'Queue selected';
}

// ── Queue ───────────────────────────────────────────────────────────────────
//
// All generation goes through the worker's persistent queue (one item at a
// time, human-paced, survives the panel closing). The panel just builds items
// — identifiers only; the worker fetches each section's text when it gets to it.
function itemFromSection(s) {
  return {
    kind: s.kind,
    slug: ctx.projectSlug,
    episodeCode: ctx.episodeCode,
    episodeTitle: ctx.episodeTitle,
    sectionSlug: s.slug,
    chapterNumber: s.num ?? null,
    target: $('saveTarget').value,
    provider: currentProvider(),
    voice: $('voice').value,
    autoTag: $('autoTag').checked,
    project: ctx.project || '',
    chapterNum: s.num != null ? pad(s.num) : '',
    chapterLabel: s.label,
    label: `${ctx.episodeCode} ${s.label}`,
  };
}

const NORESP = 'no response from the background — reload the extension at chrome://extensions';
const skipNote = (r) => (r.skipped ? ` (skipped ${r.skipped} already queued)` : '');

// Queue the ticked sections (confirmed first).
async function onQueueSelected() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const sel = selectedSections();
  if (!sel.length) return status('Tick at least one chapter.');
  const ok = await confirmDialog(
    `Queue ${sel.length} chapter${sel.length > 1 ? 's' : ''} from ${ctx.episodeCode}?`,
    `Generates with ${currentProvider()} — ${costPhrase()}.`,
    'Queue'
  );
  if (!ok) return;
  persist({ saveTarget: $('saveTarget').value, ...rememberVoice(voice) });
  const items = sel.map(itemFromSection);
  const r = await chrome.runtime.sendMessage({ type: 'enqueue', items });
  status(r?.ok ? `Queued ${r.added} from ${ctx.episodeCode}${skipNote(r)}.` : `Queue failed: ${r?.error || NORESP}`);
}

// Queue every missing section of EVERY eligible episode in the project. The
// worker expands the project (it'd be too many calls to do here).
async function onQueueProject() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  if (!ctx.projectSlug) return;
  const ok = await confirmDialog(
    `Queue ALL missing audio across "${ctx.project}"?`,
    `This can be a lot of chapters — generates with ${currentProvider()}, ${costPhrase()}.`,
    'Queue all'
  );
  if (!ok) return;
  persist({ saveTarget: $('saveTarget').value, ...rememberVoice(voice) });
  status(`Building a queue for all of ${ctx.project}…`);
  const r = await chrome.runtime.sendMessage({
    type: 'enqueueProject',
    payload: {
      slug: ctx.projectSlug,
      target: $('saveTarget').value,
      provider: currentProvider(),
      voice,
      autoTag: $('autoTag').checked,
    },
  });
  status(
    r?.ok
      ? `Queued ${r.added} section(s) across ${r.episodes} episode(s)${skipNote(r)}.`
      : `Queue failed: ${r?.error || NORESP}`
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

const Q_GLYPH = { pending: '•', running: '⟳', done: '✓', failed: '✗' };

function renderQueueList(queue) {
  const ul = $('queueList');
  ul.innerHTML = '';
  if (!queue.length) {
    ul.hidden = true;
    return;
  }
  ul.hidden = false;
  for (const it of queue) {
    const li = document.createElement('li');
    li.className = `qrow q-${it.status}`;
    const label = document.createElement('span');
    label.className = 'qlabel';
    label.textContent = `${Q_GLYPH[it.status] || '•'} ${it.label}`;
    if (it.status === 'failed' && it.error) label.title = it.error;
    li.appendChild(label);
    if (it.status === 'pending') {
      const x = document.createElement('button');
      x.className = 'qremove';
      x.textContent = '✕';
      x.title = 'Remove from queue';
      x.dataset.id = it.id;
      li.appendChild(x);
    }
    ul.appendChild(li);
  }
}

// When the whole queue finishes, refresh the current episode's section list so
// the ones we just made drop off.
async function onQueueChanged(oldQ, newQ) {
  renderQueueBar(newQ);
  renderQueueList(newQ);
  const active = newQ.some((i) => i.status === 'pending' || i.status === 'running');
  const wasActive = oldQ.some((i) => i.status === 'pending' || i.status === 'running');
  if (wasActive && !active && settings.mode === 'companion' && ctx.episodeCode) {
    await invalidateEpisodes(ctx.projectSlug);
    await loadSections();
  }
}

// ── Voices (per provider) ────────────────────────────────────────────────────
function renderVoices(voices) {
  const sel = $('voice');
  sel.innerHTML = '';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.title || v.id;
    sel.appendChild(opt);
  }
  const remembered =
    settings.voiceByProvider?.[currentProvider()] || (currentProvider() === 'fish' ? settings.fishVoice : '');
  if (remembered) sel.value = remembered;
}

async function getVoiceCache() {
  return (await chrome.storage.local.get('voicesCache')).voicesCache || {};
}

async function initVoices() {
  const cache = await getVoiceCache();
  const v = cache[currentProvider()];
  if (Array.isArray(v) && v.length) renderVoices(v);
  else await loadVoices();
}

async function loadVoices() {
  const p = currentProvider();
  status(`Loading ${p} voices…`);
  const res = await chrome.runtime.sendMessage({ type: 'listVoices', provider: p });
  if (!res?.ok) {
    $('voice').innerHTML = '';
    return status(`Couldn't load ${p} voices: ${res?.error || NORESP}`);
  }
  const cache = await getVoiceCache();
  cache[p] = res.voices;
  await chrome.storage.local.set({ voicesCache: cache });
  renderVoices(res.voices);
  status('');
}

// ── Shared ─────────────────────────────────────────────────────────────────
function pasteTokens() {
  const code = $('pasteCode').value.trim() || 'audio';
  const label = $('pasteLabel').value.trim();
  return { project: '', episodeCode: code, episodeTitle: '', chapterNum: '', chapterLabel: label };
}

function updatePreview() {
  // Only the paste flow has a single deterministic filename to preview;
  // companion mode shows its target via the section list + Save-to selector.
  if (settings.mode === 'paste') {
    $('filenamePreview').textContent = `↳ Downloads/${buildDownloadPath(settings, pasteTokens())}`;
  } else {
    $('filenamePreview').textContent = '';
  }
}

// Styled confirmation overlay → resolves true (OK) / false (Cancel).
function confirmDialog(title, body, okText = 'Queue') {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    $('confirmOk').textContent = okText;
    const dlg = $('confirm');
    dlg.hidden = false;
    const close = (val) => {
      dlg.hidden = true;
      $('confirmOk').onclick = null;
      $('confirmCancel').onclick = null;
      resolve(val);
    };
    $('confirmOk').onclick = () => close(true);
    $('confirmCancel').onclick = () => close(false);
  });
}

// Panel connection test — verifies the whole chain from where you work.
async function testConnection() {
  const out = $('connStatus');
  const set = (t, c) => {
    out.textContent = t;
    out.style.color = c;
  };
  $('testConn').disabled = true;
  set('Testing…', 'var(--muted)');
  try {
    const url = settings.studioBaseUrl || '';
    const local = /localhost|127\.0\.0\.1/.test(url);
    if (!local) {
      let pat = null;
      try {
        const u = new URL(url);
        pat = `${u.protocol}//${u.hostname}/*`;
      } catch {
        /* invalid url */
      }
      const granted = pat ? await chrome.permissions.contains({ origins: [pat] }).catch(() => false) : false;
      if (!granted) {
        set('✗ No host access — Settings → Grant access.', '#b00');
        return;
      }
    }
    const projects = await client.listProjects();
    const n = Array.isArray(projects) ? projects.length : (projects.projects || []).length;
    set(`✓ ${n} project${n !== 1 ? 's' : ''}`, '#0a7a0a');
    await loadCompanionData(); // refresh dropdowns now that we're reachable
  } catch (e) {
    const local = /localhost|127\.0\.0\.1/.test(settings.studioBaseUrl || '');
    set(`✗ ${e.message}. ${local ? 'Running?' : 'Running, granted, logged in?'}`, '#b00');
  } finally {
    $('testConn').disabled = false;
  }
}

// Paste mode: queue the pasted text as a single Download item.
async function onGenerate() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const text = $('pasteText').value.trim();
  if (!text) return status('Paste some script text first.');
  persist({ ...rememberVoice(voice), saveTarget: $('saveTarget').value });
  const code = $('pasteCode').value.trim() || 'audio';
  const label = $('pasteLabel').value.trim() || code;
  const item = {
    kind: 'paste',
    text,
    target: 'download',
    provider: currentProvider(),
    voice,
    autoTag: $('autoTag').checked,
    label,
    episodeCode: code,
    episodeTitle: '',
    project: '',
    chapterNum: '',
    chapterLabel: $('pasteLabel').value.trim() || '',
  };
  const r = await chrome.runtime.sendMessage({ type: 'enqueue', items: [item] });
  if (!r?.ok) return status(`Queue failed: ${r?.error || NORESP}`);
  status(r.added ? `Queued ${item.label}.` : 'Already in the queue.');
}
