import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const extension = path.join(root, 'extension');

async function javascriptFiles(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await javascriptFiles(target));
    if (entry.isFile() && entry.name.endsWith('.js')) found.push(target);
  }
  return found;
}

JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
for (const file of await javascriptFiles(extension)) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log('Manifest and extension JavaScript are valid.');
