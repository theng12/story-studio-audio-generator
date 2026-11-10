import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createFishInventory } from '../src/lib/providers.js';
const source = readFileSync(new URL('../src/content/fish-main.js', import.meta.url), 'utf8');
const VOICE = '711cf3ed00ab441a8f54a45058047b7a';
const copy = (value) => JSON.parse(JSON.stringify(value));

// DOM metadata fixture, not a claim that the live SPA currently exposes these attributes.
function boot({ native = true, ids = true, owned = [], detailId = VOICE } = {}) {
  const calls = [], keys = [];
  let handlers, expanded = false;
  const option = (id, label) => ({ value: id, textContent: label, getClientRects: () => [1], getAttribute: () => ids ? id : null });
  const options = [option('drama-3', 'Drama3'), option('s2.1-pro-free', 'S2.1Pro'), option('future-exact-id', 'Future model')];
  const control = {
    tagName: native ? 'SELECT' : 'BUTTON', value: 's2.1-pro-free', options,
    parentElement: { textContent: 'Model' }, getClientRects: () => [1],
    getAttribute(name) { return name === 'aria-label' ? 'Model' : name === 'aria-expanded' ? String(expanded) : null; },
    focus() {}, click() { expanded = true; },
    dispatchEvent(event) { keys.push(event.key); if (event.key === 'Escape') expanded = false; },
  };
  const text = { value: 'Preserved scene narration', getClientRects: () => [1], getAttribute: () => '500' };
  const image = { src: `https://public-platform.r2.fish.audio/cdn-cgi/image/width=128,format=webp/coverimage/${VOICE}`, getClientRects: () => [1] };
  const unrelated = { speed: 1.1, sceneDuration: 8 };
  const context = vm.createContext({
    window: { __STORY_STUDIO_BRIDGE__: { createMainBridge(config) { handlers = config.handlers; } } },
    localStorage: { getItem: () => 'fixture-only' },
    URL, Set, Map,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
    KeyboardEvent: class { constructor(_type, options) { Object.assign(this, options); } },
    document: { querySelectorAll(selector) {
      if (selector === 'select, [role="combobox"]') return [control];
      if (selector === '[role="option"]') return expanded ? options : [];
      if (selector === 'img[src]') return [image, image];
      if (selector === 'textarea[maxlength]') return [text];
      throw new Error(`Unexpected selector ${selector}`);
    } },
    async fetch(url, init) {
      calls.push({ url, init });
      assert.equal(init.method, undefined, 'Discovery must never submit a task or enhancement.');
      if (url.endsWith('/model?self=true&page_size=50')) return { ok: true, json: async () => ({ items: owned }) };
      if (url.endsWith(`/model/${VOICE}`)) return { ok: true, json: async () => ({ _id: detailId, title: 'Verity' }) };
      throw new Error(`Unexpected network boundary ${url}`);
    },
  });
  vm.runInContext(source, context);
  return { handlers, calls, keys, control, text, unrelated, expanded: () => expanded };
}

test('owned-empty discovery includes an accessible visible voice and exact dynamic model IDs without changing controls', async () => {
  const page = boot();
  const raw = copy(await page.handlers.inventory());
  assert.deepEqual(raw.voices, [{ id: VOICE, title: 'Verity', source: 'visible-detail' }]);
  assert.equal(raw.voicesComplete, false);
  assert.equal(page.calls.length, 2, 'Repeated visible image must not repeat its detail request.');
  assert.deepEqual(raw.fishModelOptions.models.map(({ id }) => id), ['drama-3', 's2.1-pro-free', 'future-exact-id']);
  const inventory = createFishInventory(raw.fishModelOptions, raw.voices, raw);
  assert.equal(inventory.source, 'live');
  assert.equal(inventory.generationAvailable, false);
  assert.equal(inventory.verificationRequired, true);
  assert.equal(inventory.models[1].maxChars, 500);
  assert.equal(inventory.models[0].maxChars, undefined, 'A selected-model limit must not authorize other models.');
  assert.equal(inventory.models[2].generationSupported, false);
  assert.equal(page.control.value, 's2.1-pro-free');
  assert.equal(page.text.value, 'Preserved scene narration');
  assert.deepEqual(page.unrelated, { speed: 1.1, sceneDuration: 8 });
});

test('labels without request IDs remain visible, incomplete and unavailable; the menu closes without selecting', async () => {
  const page = boot({ native: false, ids: false });
  const raw = copy(await page.handlers.inventory());
  const inventory = createFishInventory(raw.fishModelOptions, raw.voices, raw);
  assert.equal(inventory.source, 'discovered');
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.models.map(({ id, label }) => ({ id, label })), [
    { id: '', label: 'Drama3' }, { id: '', label: 'S2.1Pro' }, { id: '', label: 'Future model' },
  ]);
  assert.equal(page.expanded(), false);
  assert(page.keys.includes('Escape'));
  assert.equal(page.keys.includes('ArrowDown'), false);
  assert.equal(page.control.value, 's2.1-pro-free');
});

test('a mismatched detail cannot turn a displayed image into an authorized voice', async () => {
  const page = boot({ detailId: 'other-voice' });
  const raw = await page.handlers.inventory();
  assert.equal(raw.voices.length, 0);
  assert.equal(raw.voicesComplete, false);
});

test('verification refusal happens before any task, enhancement or verification request', async () => {
  const page = boot();
  await assert.rejects(page.handlers.generate({ text: 'Do not submit', model: VOICE, backend: 'drama-3', autoTag: true }), (error) =>
    error.verificationRequired === true && error.ambiguous === false && /No request was submitted/.test(error.message));
  assert.equal(page.calls.length, 0);
});
