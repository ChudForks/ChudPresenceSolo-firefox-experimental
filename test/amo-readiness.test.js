import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('declares every category of data transmitted for presence sharing', async () => {
  const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root), 'utf8'));
  const required = manifest.browser_specific_settings.gecko.data_collection_permissions.required;

  assert.deepEqual(required, [
    'authenticationInfo',
    'browsingActivity',
    'websiteActivity',
    'websiteContent',
  ]);
});

test('documents data destinations and lets users stop the TMDB lookup', async () => {
  const [privacy, listing, movies] = await Promise.all([
    readFile(new URL('PRIVACY.md', root), 'utf8'),
    readFile(new URL('AMO_LISTING.md', root), 'utf8'),
    readFile(new URL('extension/movies67.js', root), 'utf8'),
  ]);

  assert.match(privacy, /Discord/);
  assert.match(privacy, /TMDB/);
  assert.match(listing, /Disconnect/);
  assert.match(movies, /if \(!sharingEnabled\) return/);
  assert.match(movies, /changes\.sourceMovies67/);
});
