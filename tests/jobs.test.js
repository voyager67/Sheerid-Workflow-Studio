import test from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from '../src/jobs.js';

const verificationId = '0123456789abcdef01234567';
const programId = 'fedcba9876543210fedcba98';
const collectUrl = `https://services.sheerid.com/rest/v2/verification/${verificationId}/step/collectStudentPersonalInfo`;
const docUrl = `https://services.sheerid.com/rest/v2/verification/${verificationId}/step/docUpload`;
const completeUrl = `https://services.sheerid.com/rest/v2/verification/${verificationId}/step/completeDocUpload`;
const subject = { firstName:'Fictional', lastName:'Person', email:'fictional@example.test' };
const uuid = (n = '1') => `00000000-0000-4000-8000-00000000000${n}`;

async function waitFor(manager, id, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = manager.get(id);
    if (predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`Job did not reach the expected state: ${manager.get(id).status}`);
}
function manager(client, options = {}) {
  return new JobManager({ client, programId, concurrency:1, pollIntervalMs:300_000, maxDocumentBytes:1024 * 1024, ...options });
}

test('approved verification runs once and returns a redacted public job', async t => {
  let creates = 0;
  const fake = {
    async createVerification() {
      creates += 1;
      return { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] };
    },
    async submitSubject(id, url, payload) {
      assert.equal(id, verificationId);
      assert.equal(url, collectUrl);
      assert.deepEqual(payload, subject);
      return { verificationId, currentStep:'success', rewardData:{ rewardCode:'DEMO-ONLY-CODE' }, errorIds:[] };
    }
  };
  const jobs = manager(fake);
  t.after(() => jobs.close());
  const created = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid() });
  const done = await waitFor(jobs, created.id, job => job.status === 'approved');
  assert.equal(creates, 1);
  assert.equal(done.verificationId, verificationId);
  assert.equal(done.rewardData.rewardCode, 'DEMO-ONLY-CODE');
  assert.equal('subjectData' in done, false);
  assert.equal(JSON.stringify(done.events).includes('fictional@example.test'), false);
});

test('idempotency returns the existing job and rejects reuse with changed subject data', async t => {
  let creates = 0;
  const fake = {
    async createVerification() {
      creates += 1;
      return { verificationId, currentStep:'success', errorIds:[] };
    }
  };
  const jobs = manager(fake);
  t.after(() => jobs.close());
  const first = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid('2') });
  const duplicate = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid('2') });
  assert.equal(duplicate.id, first.id);
  assert.throws(() => jobs.create({
    subjectData:{ firstName:'Different' }, consent:true, clientRequestId:uuid('2')
  }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  await waitFor(jobs, first.id, job => job.status === 'approved');
  assert.equal(creates, 1);
});

test('recoverable input errors are corrected on the same verification ID', async t => {
  let creates = 0;
  const submitted = [];
  const fake = {
    async createVerification() {
      creates += 1;
      return { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] };
    },
    async submitSubject(id, url, payload) {
      submitted.push({ id, url, payload });
      return submitted.length === 1
        ? { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:['invalidEmail'] }
        : { verificationId, currentStep:'success', errorIds:[] };
    }
  };
  const jobs = manager(fake);
  t.after(() => jobs.close());
  const created = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid('3') });
  const needsInput = await waitFor(jobs, created.id, job => job.status === 'input_required');
  assert.equal(needsInput.canResubmit, true);
  await assert.rejects(jobs.resubmitSubject(created.id, { subjectData:subject, consent:false }), error => error.code === 'CONSENT_REQUIRED');
  const fixed = await jobs.resubmitSubject(created.id, {
    subjectData:{ ...subject, email:'corrected@example.test' }, consent:true
  });
  assert.equal(fixed.status, 'approved');
  assert.equal(creates, 1);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].id, submitted[1].id);
});

test('stopping local polling does not imply provider cancellation; refresh can resume it', async t => {
  let statusReads = 0;
  const fake = {
    async createVerification() {
      return { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] };
    },
    async submitSubject() {
      return { verificationId, currentStep:'pending', statusUrl:`https://services.sheerid.com/rest/v2/verification/${verificationId}`, errorIds:[] };
    },
    async getStatus() {
      statusReads += 1;
      return { verificationId, currentStep:'success', errorIds:[] };
    }
  };
  const jobs = manager(fake);
  t.after(() => jobs.close());
  const created = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid('4') });
  await waitFor(jobs, created.id, job => job.status === 'waiting');
  const stopped = jobs.cancel(created.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.canRefresh, true);
  assert.match(stopped.message, /provider verification remains active/i);
  const refreshed = await jobs.refresh(created.id);
  assert.equal(refreshed.status, 'approved');
  assert.equal(statusReads, 1);
});

test('document upload validates signatures, follows provider URLs and clears local bytes', async t => {
  let receivedBytes;
  let receivedUploadUrl;
  let completeStep;
  const fake = {
    async createVerification() {
      return { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] };
    },
    async submitSubject() {
      return { verificationId, currentStep:'docUpload', submissionUrl:docUrl, errorIds:[] };
    },
    async initiateDocumentUpload(id, url, files) {
      assert.equal(id, verificationId);
      assert.equal(url, docUrl);
      assert.deepEqual(files.map(file => file.mimeType), ['application/pdf']);
      return {
        verificationId, currentStep:'docUpload', errorIds:[],
        documents:[{ uploadUrl:'https://bucket.s3.amazonaws.com/signed-file?signature=demo', mimeType:'application/pdf', fileSize:files[0].fileSize, errors:[] }],
        submissionUrl:completeUrl
      };
    },
    async uploadToSignedUrl(url, bytes, mimeType) {
      receivedUploadUrl = url;
      assert.equal(mimeType, 'application/pdf');
      receivedBytes = Buffer.from(bytes);
    },
    async completeDocumentUpload(id, url) {
      completeStep = { id, url };
      return { verificationId, currentStep:'pending', errorIds:[], statusUrl:`https://services.sheerid.com/rest/v2/verification/${verificationId}` };
    }
  };
  const jobs = manager(fake);
  t.after(() => jobs.close());
  const created = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid('5') });
  await waitFor(jobs, created.id, job => job.status === 'needs_document');
  const bytes = Buffer.from('%PDF-1.7 fictional document bytes');
  const original = Buffer.from(bytes);
  const result = await jobs.uploadDocument(created.id, bytes, 'evidence.pdf');
  assert.equal(result.status, 'waiting');
  assert.equal(result.documentAttempts, 1);
  assert.equal(bytes.every(byte => byte === 0), true);
  assert.deepEqual(receivedBytes, original);
  assert.equal(receivedUploadUrl, 'https://bucket.s3.amazonaws.com/signed-file?signature=demo');
  assert.deepEqual(completeStep, { id:verificationId, url:completeUrl });
  assert.equal(JSON.stringify(result.events).includes('evidence.pdf'), false);
});

test('invalid document signatures are rejected and the supplied buffer is cleared', async t => {
  const fake = {
    async createVerification() {
      return { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] };
    },
    async submitSubject() {
      return { verificationId, currentStep:'docUpload', submissionUrl:docUrl, errorIds:[] };
    }
  };
  const jobs = manager(fake);
  t.after(() => jobs.close());
  const created = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid('6') });
  await waitFor(jobs, created.id, job => job.status === 'needs_document');
  const bytes = Buffer.from('not a real PDF');
  await assert.rejects(jobs.uploadDocument(created.id, bytes, 'not-a-pdf.pdf'), error => error.code === 'DOCUMENT_TYPE_INVALID');
  assert.equal(bytes.every(byte => byte === 0), true);
  assert.equal(jobs.get(created.id).status, 'needs_document');
});

test('closing the manager stops local polling without claiming to cancel the provider record', async () => {
  const fake = {
    async createVerification() {
      return { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] };
    },
    async submitSubject() {
      return { verificationId, currentStep:'pending', errorIds:[] };
    }
  };
  const jobs = manager(fake);
  const created = jobs.create({ subjectData:subject, consent:true, clientRequestId:uuid('7') });
  await waitFor(jobs, created.id, job => job.status === 'waiting');
  jobs.close();
  assert.equal(jobs.get(created.id).status, 'stopped');
  assert.equal(jobs.get(created.id).canRefresh, true);
});
