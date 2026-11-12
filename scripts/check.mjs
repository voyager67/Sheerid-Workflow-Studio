import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const targets = ['src', 'public', 'tests', 'scripts'];
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    if (entry.isDirectory()) await walk(join(directory,entry.name));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(join(directory,entry.name));
  }
}
for (const target of targets) await walk(target);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`${file}\n${result.stderr}`);
  }
}
if (failed) process.exit(1);
process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
