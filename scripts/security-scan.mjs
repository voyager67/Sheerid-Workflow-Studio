import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const excluded = new Set(['.git','node_modules','coverage','dist']);
const textExtensions = new Set(['.js','.mjs','.json','.md','.yml','.yaml','.example','.toml','.txt']);
const patterns = [
  ['private key', /-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['long bearer token', /\bBearer\s+[A-Za-z0-9._~+-]{40,}/i],
  ['live secret assignment', /^(?:SHEERID_CLIENT_SECRET|CLIENT_SECRET|API_KEY)=(?!your-|replace|example|placeholder|$)[^\s#]+/im],
];
let failed = false;
let scanned = 0;
async function walk(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) await walk(join(directory,entry.name));
      continue;
    }
    const path = join(directory,entry.name);
    const extension = entry.name.includes('.') ? `.${entry.name.split('.').pop()}` : '';
    if (!textExtensions.has(extension) && entry.name !== '.gitignore' && entry.name !== '.nvmrc') continue;
    const content = await readFile(path,'utf8');
    scanned += 1;
    for (const [label,pattern] of patterns) {
      if (pattern.test(content) && !path.endsWith('.example')) {
        failed = true;
        process.stderr.write(`${label} pattern detected in ${path}\n`);
      }
    }
  }
}
await walk(root);
if (failed) process.exit(1);
process.stdout.write(`Scanned ${scanned} project text files. No common credential patterns found.\n`);
