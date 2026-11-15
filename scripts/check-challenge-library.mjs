import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/challenge-ideas.js'), 'utf8'), context);
const { ideas, scenes, starterCount } = context.window.TORCHHIVE_CHALLENGES;
assert.equal(ideas.length, 100);
assert.equal(Object.keys(scenes).length, 20);
for (const key of ['id', 'title', 'task']) assert.equal(new Set(ideas.map(x => x[key])).size, 100, `Duplicate ${key}`);
assert.equal(starterCount, 20);
assert.equal(new Set(ideas.slice(0, starterCount).map(x => x.scene)).size, 20);
for (const [i, idea] of ideas.entries()) {
  assert.ok(scenes[idea.scene], `Unknown scene: ${idea.scene}`);
  assert.equal(idea.starter, i < starterCount);
  assert.ok(idea.task.length >= 50 && idea.task.length <= 1000, `Invalid task length: ${idea.id}`);
  assert.ok(idea.title.length <= 65, `Title too long: ${idea.title}`);
  assert.notEqual(idea.scene, ideas[(i + 1) % ideas.length].scene, 'Adjacent pictures must differ');
}
let bytes = 0;
for (const [key, scene] of Object.entries(scenes)) {
  assert.equal(ideas.filter(x => x.scene === key).length, 5);
  assert.ok(scene.label && scene.alt && scene.focus);
  for (const url of [scene.src, scene.thumb]) {
    const asset = path.resolve(root, '.' + url);
    assert.ok(asset.startsWith(root + path.sep), 'Asset must stay inside repository');
    const data = fs.readFileSync(asset);
    assert.equal(data.toString('ascii', 0, 4), 'RIFF', `Invalid WebP: ${url}`);
    assert.equal(data.toString('ascii', 8, 12), 'WEBP', `Invalid WebP: ${url}`);
    assert.ok(data.length < (url.includes('-thumb') ? 20000 : 350000), `Oversized asset: ${url}`);
    bytes += data.length;
  }
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(x => !x[1].includes('src=') && !x[1].includes('ld+json'));
inline.forEach((x, i) => new vm.Script(x[2], { filename: `index-inline-${i}.js` }));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML IDs');
assert.ok(html.indexOf('src="/assets/challenge-ideas.js"') < html.indexOf('window.TORCHHIVE_CHALLENGES'));
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'assets/challenges/prompts.json'), 'utf8')).assets.length, 20);
console.log(`PASS: 100 unique ideas, 20 entertaining starters, 20 scenes, 40 valid WebP files (${(bytes / 1048576).toFixed(2)} MiB), inline JavaScript and HTML IDs.`);
