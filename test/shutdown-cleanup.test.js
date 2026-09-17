import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Firefox build does not depend on Chrome offscreen cleanup', async () => {
  const path = new URL('../extension/discord/shutdown-cleanup.js', import.meta.url);
  const source = await readFile(path, 'utf8');
  assert.doesNotMatch(source, /chrome\.offscreen/);

  const cleanup = await import(path.href);
  assert.equal(await cleanup.armShutdownCleanup('access-token', 'session-token'), false);
  await cleanup.disarmShutdownCleanup();
});

test('Firefox close cleanup keeps the authenticated Discord delete request alive', async () => {
  const presencePath = new URL('../extension/discord/presence.js', import.meta.url);
  const backgroundPath = new URL('../extension/background.js', import.meta.url);
  const [presenceSource, backgroundSource] = await Promise.all([
    readFile(presencePath, 'utf8'),
    readFile(backgroundPath, 'utf8'),
  ]);

  assert.match(presenceSource, /keepalive,\s*\n\s*body: JSON\.stringify\(\{ token \}\)/);
  assert.match(backgroundSource, /TAB_CLOSING[\s\S]*?\{ closing: true \}/);
});
