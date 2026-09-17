import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
const folderName = `ChudPresence-Solo-Firefox-Experimental-${manifest.version}`;
const staged = path.join(dist, folderName);
const zipArchive = path.join(dist, `${folderName}.zip`);
const archive = path.join(dist, `${folderName}.xpi`);

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
await fs.cp(source, staged, { recursive: true });
// Firefox requires manifest.json at the root of an XPI, not inside a staging folder.
const archiveEntries = await fs.readdir(staged);
execFileSync('tar', ['-a', '-cf', zipArchive, '-C', staged, ...archiveEntries], { stdio: 'inherit' });
await fs.rename(zipArchive, archive);
console.log(`Built ${archive}`);
