import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPages } from '../scripts/build-pages.mjs';

test('Pages build emits a root index, 404 page, stylesheet and only required static media', async t => {
  const output = await mkdtemp(join(tmpdir(), 'sheerflow-pages-'));
  t.after(() => rm(output, { recursive:true, force:true }));
  await buildPages(output);

  const expected = [
    'index.html', '404.html', 'styles.css', '.nojekyll',
    'assets/sheerflow-banner.svg', 'assets/workbench.svg', 'demo/sheerflow-demo.mp4'
  ];
  for (const path of expected) {
    const info = await stat(resolve(output, path));
    assert.ok(info.isFile(), path + ' must exist in the deployed site');
    assert.ok(info.size > 0 || path === '.nojekyll', path + ' must not be empty');
  }
  const html = await readFile(resolve(output, 'index.html'), 'utf8');
  for (const path of ['./styles.css','./assets/sheerflow-banner.svg','./assets/workbench.svg','./demo/sheerflow-demo.mp4']) {
    assert.ok(html.includes(path), 'HTML must reference ' + path);
    assert.ok(await stat(resolve(output, path.slice(2))), 'Referenced page asset must be included: ' + path);
  }
  assert.match(html, /github\.com\/voyager67\/Sheerid-Workflow-Studio/);
  assert.match(html, /GitHub Pages cannot host that backend/);
  assert.doesNotMatch(html, /href="\/(?:styles\.css|app\.js)|src="\/(?:styles\.css|app\.js)/);
  assert.doesNotMatch(html, /fetch\(['"`]\/api\//);
  const entries = await readdir(output);
  assert.ok(entries.includes('index.html'));
});

test('Pages 404 page uses a relative stylesheet and relative home link', async t => {
  const output = await mkdtemp(join(tmpdir(), 'sheerflow-pages-'));
  t.after(() => rm(output, { recursive:true, force:true }));
  await buildPages(output);
  const html = await readFile(resolve(output, '404.html'), 'utf8');
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /href="\.\/"/);
});
