import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asset = (...parts) => resolve(ROOT, ...parts);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function inspectPng(bytes) {
  assert.ok(bytes.length > 64, 'PNG must contain image data');
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, 'PNG signature must be valid');
  let offset = 8;
  let dimensions = null;
  let sawImageData = false;
  let sawEnd = false;
  const chunkTypes = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length, `PNG chunk ${type} must fit inside the file`);
    chunkTypes.push(type);
    if (type === 'IHDR') {
      assert.equal(length, 13);
      dimensions = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) };
    }
    if (type === 'IDAT') sawImageData = true;
    if (type === 'IEND') { sawEnd = true; break; }
    offset = end;
  }
  assert.ok(dimensions, 'PNG must include IHDR');
  assert.ok(sawImageData, 'PNG must include IDAT image data');
  assert.ok(sawEnd, 'PNG must include IEND');
  return { ...dimensions, chunkTypes };
}

function inspectMp4(bytes) {
  const types = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      assert.ok(offset + 16 <= bytes.length, 'Extended MP4 atom header must fit');
      const large = bytes.readBigUInt64BE(offset + 8);
      assert.ok(large <= BigInt(Number.MAX_SAFE_INTEGER), 'MP4 atom size must be safely representable');
      size = Number(large);
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    assert.ok(size >= 8, `MP4 atom ${type} must have a valid size`);
    assert.ok(offset + size <= bytes.length, `MP4 atom ${type} must fit inside the file`);
    types.push(type);
    offset += size;
  }
  assert.equal(offset, bytes.length, 'MP4 atoms must consume the complete file');
  return types;
}

test('SheerFlow banner PNG is valid and has the expected widescreen dimensions', async () => {
  const bytes = await readFile(asset('assets', 'brand', 'sheerflow-banner.png'));
  const png = inspectPng(bytes);
  assert.equal(png.width, 1400);
  assert.equal(png.height, 440);
});

test('dashboard workbench PNG is valid and matches its SVG canvas', async () => {
  const bytes = await readFile(asset('assets', 'demo', 'workbench.png'));
  const png = inspectPng(bytes);
  assert.equal(png.width, 1100);
  assert.equal(png.height, 650);
});

test('sample-support PNG is a small, explicitly fictional demo fixture', async () => {
  const bytes = await readFile(asset('assets', 'demo', 'sample-support.png'));
  const png = inspectPng(bytes);
  assert.equal(png.width, 220);
  assert.equal(png.height, 140);
  const svg = await readFile(asset('assets', 'demo', 'sample-support.svg'), 'utf8');
  assert.match(svg, /SAMPLE RECORD/);
  assert.match(svg, /FICTIONAL/);
  assert.match(svg, /DEMO ONLY/);
});

test('demo MP4 contains a well-formed ISO BMFF video container', async () => {
  const bytes = await readFile(asset('assets', 'demo', 'sheerflow-demo.mp4'));
  const atoms = inspectMp4(bytes);
  assert.equal(atoms[0], 'ftyp');
  assert.ok(atoms.includes('moov'));
  assert.ok(atoms.includes('mdat'));
  assert.ok(bytes.includes(Buffer.from('avc1')), 'Demo video should include an H.264 video track');
});
