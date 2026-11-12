import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDocument } from '../src/documents.js';

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const jpeg=Buffer.from([0xff,0xd8,0xff,0xdb,0x00,0x43]);
const pdf=Buffer.from('%PDF-1.7\nfictional fixture');

test('PNG, JPEG and PDF signatures map to the expected MIME types', () => {
  assert.equal(inspectDocument(png,'image.png').mimeType,'image/png');
  assert.equal(inspectDocument(jpeg,'image.jpeg').mimeType,'image/jpeg');
  assert.equal(inspectDocument(pdf,'file.pdf').mimeType,'application/pdf');
});

test('a filename extension that disagrees with the file signature is rejected', () => {
  assert.throws(()=>inspectDocument(pdf,'proof.png'),error=>error.code==='DOCUMENT_EXTENSION_MISMATCH');
  assert.throws(()=>inspectDocument(png,'proof.pdf'),error=>error.code==='DOCUMENT_EXTENSION_MISMATCH');
});

test('empty, unsupported and oversized document buffers are rejected', () => {
  assert.throws(()=>inspectDocument(Buffer.alloc(0),'empty.pdf'),error=>error.code==='DOCUMENT_SIZE_INVALID');
  assert.throws(()=>inspectDocument(Buffer.from('MZ executable'),'payload.exe'),error=>error.code==='DOCUMENT_TYPE_INVALID');
  assert.throws(()=>inspectDocument(Buffer.concat([pdf,Buffer.alloc(128)]),'large.pdf',32),error=>error.code==='DOCUMENT_SIZE_INVALID');
});

test('file names are reduced to a safe display name without path separators', () => {
  const result=inspectDocument(pdf,'../../private folder/identity proof.pdf');
  assert.equal(result.fileName.includes('/'),false);
  assert.equal(result.fileName.includes('\\'),false);
  assert.match(result.fileName,/identity_proof\.pdf$/);
});

test('a document signature check does not mutate the original file bytes', () => {
  const input=Buffer.from(pdf);
  const original=Buffer.from(input);
  inspectDocument(input,'sample.pdf');
  assert.deepEqual(input,original);
});
