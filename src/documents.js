import { SheerFlowError } from './auth.js';

export const DEFAULT_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export function inspectDocument(bytes, originalName, maxBytes = DEFAULT_MAX_DOCUMENT_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxBytes) {
    throw new SheerFlowError('DOCUMENT_SIZE_INVALID', `Document must be non-empty and no larger than ${Math.floor(maxBytes / 1024 / 1024)} MiB.`);
  }
  const ext = String(originalName || '').toLowerCase().split('.').pop();
  let mimeType;
  let expectedExt;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = 'image/png'; expectedExt = ['png'];
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = 'image/jpeg'; expectedExt = ['jpg', 'jpeg'];
  } else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    mimeType = 'application/pdf'; expectedExt = ['pdf'];
  } else {
    throw new SheerFlowError('DOCUMENT_TYPE_INVALID', 'Only PNG, JPEG and PDF documents are supported.');
  }
  if (!expectedExt.includes(ext)) throw new SheerFlowError('DOCUMENT_EXTENSION_MISMATCH', 'The file extension does not match the document contents.');
  const fileName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  return { bytes, fileName, mimeType, fileSize: bytes.length };
}
