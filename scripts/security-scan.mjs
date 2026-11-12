import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const excluded = new Set(['.git', 'node_modules', 'coverage', 'dist', 'playwright-report']);
const textExtensions = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.example', '.toml', '.txt',
  '.html', '.css', '.svg', '.xml', '.sh', '.ps1', '.bat', '.cfg', '.ini', '.lock'
]);
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live secret', /\bsk_live_[0-9A-Za-z]{20,}\b/],
  ['long bearer token', /\bBearer\s+[A-Za-z0-9._~+-]{40,}/i],
  ['live secret assignment', /^(?:SHEERID_CLIENT_SECRET|AWS_SECRET_ACCESS_KEY|CLIENT_SECRET|API_KEY|GITHUB_TOKEN|GH_TOKEN|SLACK_TOKEN|STRIPE_SECRET_KEY|GOOGLE_API_KEY|OPENAI_API_KEY)\s*=\s*(?!["']?(?:replace-with-|your[-_]|example[-_]|placeholder|changeme|dummy(?:[-_]|$)))[^\s#][^\r\n]*/im],
];

const listing = spawnSync('git', ['ls-files', '-z'], { encoding:'utf8' });
const hasGitIndex = listing.status === 0;
const tracked = hasGitIndex ? new Set(listing.stdout.split('\0').filter(Boolean)) : null;
let failed = false;
let scanned = 0;

function report(message) {
  failed = true;
  process.stderr.write('SECURITY CHECK: ' + message + '\n');
}

if (tracked) {
  for (const path of tracked) {
    const name = path.split('/').pop();
    if (/^\.env(?:\..+)?$/i.test(name) && name !== '.env.example') {
      report('private environment file is tracked: ' + path);
    }
    if (/^\.npmrc(?:\..+)?$/i.test(name) && name !== '.npmrc.example') {
      report('npm configuration file may contain registry credentials: ' + path);
    }
    if (/\.(?:pem|key|p12|pfx|crt|jks|keystore|sqlite|sqlite3|db|dump|zip|7z|rar|tar|gz)$/i.test(path)) {
      report('private credential, database, or archive file is tracked: ' + path);
    }
  }
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) await walk(absolute);
      continue;
    }
    if (tracked && !tracked.has(path)) continue;
    const extension = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : '';
    if (!textExtensions.has(extension) && !['.gitignore', '.nvmrc', '.editorconfig'].includes(entry.name)) continue;
    const content = await readFile(absolute, 'utf8');
    scanned += 1;
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(content)) report(label + ' pattern detected in ' + path);
    }
  }
}

await walk(root);
if (failed) process.exit(1);
process.stdout.write('Scanned ' + scanned + ' tracked project text files. No common credential patterns or forbidden private/archive files found.\n');
