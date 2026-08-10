const CACHE_NAME = 'story-studio-audio-artifacts-v1';
const ARTIFACT_ORIGIN = 'https://story-studio-audio.invalid';

export function artifactDescriptor(id, mime = 'audio/mpeg') {
  const value = String(id);
  return { id: value, key: `${ARTIFACT_ORIGIN}/artifacts/${encodeURIComponent(value)}`, mime };
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64FromBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function putAudioArtifact(cacheStorage, descriptor, { base64, mime }) {
  const cache = await cacheStorage.open(CACHE_NAME);
  const contentType = mime || descriptor.mime || 'audio/mpeg';
  await cache.put(descriptor.key, new Response(new Blob([bytesFromBase64(base64)], { type: contentType })));
  return { ...descriptor, mime: contentType };
}

export async function getAudioArtifact(cacheStorage, descriptor) {
  if (!descriptor?.key) return null;
  const response = await (await cacheStorage.open(CACHE_NAME)).match(descriptor.key);
  if (!response) return null;
  return {
    base64: base64FromBytes(new Uint8Array(await response.arrayBuffer())),
    mime: response.headers.get('content-type') || descriptor.mime || 'audio/mpeg',
  };
}

export async function deleteAudioArtifact(cacheStorage, descriptor) {
  if (!descriptor?.key) return false;
  return (await cacheStorage.open(CACHE_NAME)).delete(descriptor.key);
}

export async function deleteAudioArtifacts(cacheStorage, descriptors) {
  await Promise.allSettled((descriptors || []).map((descriptor) => deleteAudioArtifact(cacheStorage, descriptor)));
}

export function artifactsForDiscardedItems(before, after) {
  const retained = new Set((after || []).map((item) => item.id));
  return (before || []).filter((item) => !retained.has(item.id)).map((item) => item.artifact).filter(Boolean);
}

export async function sweepOrphanedAudioArtifacts(cacheStorage, queue) {
  const cache = await cacheStorage.open(CACHE_NAME);
  const retained = new Set((queue || []).map((item) => item.artifact?.key).filter(Boolean));
  const keys = await cache.keys();
  const orphans = keys.filter((request) => request.url.startsWith(`${ARTIFACT_ORIGIN}/artifacts/`) && !retained.has(request.url));
  await Promise.allSettled(orphans.map((request) => cache.delete(request)));
}
