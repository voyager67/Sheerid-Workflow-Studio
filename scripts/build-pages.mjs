import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPages(outputDirectory) {
  const output = resolve(outputDirectory);
  await rm(output, { recursive:true, force:true });
  await mkdir(resolve(output, 'assets'), { recursive:true });
  await mkdir(resolve(output, 'demo'), { recursive:true });

  await cp(resolve(ROOT, 'site/index.html'), resolve(output, 'index.html'));
  await cp(resolve(ROOT, 'site/404.html'), resolve(output, '404.html'));
  await cp(resolve(ROOT, 'site/styles.css'), resolve(output, 'styles.css'));
  await cp(resolve(ROOT, 'assets/brand/sheerflow-banner.svg'), resolve(output, 'assets/sheerflow-banner.svg'));
  await cp(resolve(ROOT, 'assets/demo/workbench.svg'), resolve(output, 'assets/workbench.svg'));
  await cp(resolve(ROOT, 'assets/demo/sheerflow-demo.mp4'), resolve(output, 'demo/sheerflow-demo.mp4'));
  await writeFile(resolve(output, '.nojekyll'), '');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2] || '_site';
  const built = await buildPages(output);
  process.stdout.write('GitHub Pages site built at ' + built + '\n');
}
