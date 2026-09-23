import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const activities = path.join(root, 'ChudPresence-Activities');
const schemaRoot = path.join(root, 'schemas');
const apiContract = JSON.parse(await fs.readFile(path.join(schemaRoot, 'activity-api-v1.json'), 'utf8'));
const generatedMetadataSchema = JSON.parse(await fs.readFile(path.join(schemaRoot, 'activity.schema.json'), 'utf8'));
const generatedReportSchema = JSON.parse(await fs.readFile(path.join(schemaRoot, 'activity-report.schema.json'), 'utf8'));
assert.deepEqual(generatedMetadataSchema, apiContract.metadataSchema, 'metadata schema output is stale');
assert.deepEqual(generatedReportSchema, apiContract.reportSchema, 'report schema output is stale');
const runtimeContract = await import(pathToFileURL(path.join(extension, 'core', 'activity-contract.generated.js')));
const report = apiContract.reportSchema;
const metadata = apiContract.metadataSchema;
assert.equal(runtimeContract.ACTIVITY_API_VERSION, apiContract.apiVersion);
assert.deepEqual(runtimeContract.SUPPORTED_ACTIVITY_API_VERSIONS, apiContract.supportedApiVersions);
assert.deepEqual(runtimeContract.ACTIVITY_METADATA_FIELDS, Object.keys(metadata.properties));
assert.deepEqual(runtimeContract.ACTIVITY_KIND_VALUES, report.properties.kind.enum);
assert.deepEqual(runtimeContract.PRESENCE_KIND_VALUES, metadata.properties.presence.properties.kind.enum);
assert.deepEqual(runtimeContract.REPORT_MEDIA_FIELDS, Object.keys(report.properties.media.properties));
assert.deepEqual(runtimeContract.REPORT_PLAYBACK_FIELDS, Object.keys(report.properties.playback.properties));
assert.deepEqual(runtimeContract.REPORT_DISPLAY_FIELDS, Object.keys(report.properties.display.properties));
assert.deepEqual(runtimeContract.REPORT_ARTWORK_FIELDS, Object.keys(report.properties.artwork.properties));
assert.deepEqual(runtimeContract.REPORT_VISIBILITY_VALUES, report.properties.visibility.enum);
assert.deepEqual(runtimeContract.REPORT_PLAYBACK_STATE_VALUES, report.properties.playback.properties.state.enum);
assert.deepEqual(runtimeContract.REPORT_STATUS_DISPLAY_VALUES, report.properties.display.properties.statusDisplay.enum);
assert.equal(runtimeContract.MAX_ACTIVITY_METADATA_BYTES, apiContract.limits.metadataBytes);
assert.equal(runtimeContract.MAX_ACTIVITY_REPORT_BYTES, apiContract.limits.reportBytes);
assert.equal(runtimeContract.MAX_ACTIVITY_SOURCE_BYTES, apiContract.limits.sourceBytes);
assert.equal(runtimeContract.MAX_ACTIVITY_ICON_BYTES, apiContract.limits.iconBytes);

let activitiesContractAvailable = true;
try {
  await fs.access(path.join(activities, 'tools', 'generate-api-contract.mjs'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  activitiesContractAvailable = false;
}
if (activitiesContractAvailable) {
  execFileSync(process.execPath, ['tools/generate-api-contract.mjs', '--check'], { cwd: activities, stdio: 'inherit' });
  const [repositoryCanonical, repositoryContract, extensionContract] = await Promise.all([
    fs.readFile(path.join(activities, 'schemas', 'activity-api-v1.json'), 'utf8'),
    fs.readFile(path.join(activities, 'schemas', 'activity-contract.generated.js'), 'utf8'),
    fs.readFile(path.join(extension, 'core', 'activity-contract.generated.js'), 'utf8'),
  ]);
  assert.deepEqual(JSON.parse(repositoryCanonical), apiContract, 'extension and Activities canonical contract copies differ');
  if (repositoryContract !== extensionContract) {
    throw new Error('The extension runtime contract is out of sync with the Activities canonical contract.');
  }
}
console.log('Manifest, extension JavaScript, and shared Activity API contract are valid.');
