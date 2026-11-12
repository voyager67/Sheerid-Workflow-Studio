import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { SheerFlowError } from './auth.js';
import { inspectDocument } from './documents.js';

const TERMINAL = new Set(['approved', 'rejected', 'failed', 'cancelled']);
const STEP_COLLECT = /^collect[A-Za-z0-9]+PersonalInfo$/;
const TRANSIENT_SUBJECT_ERRORS = new Set(['sourcesUnavailable', 'dataProviderError', 'dataNotAvailable']);

function validateSubject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SheerFlowError('SUBJECT_REQUIRED', 'Subject data must be a JSON object.');
  const serialized = JSON.stringify(value);
  if (serialized.length > 24_000) throw new SheerFlowError('SUBJECT_TOO_LARGE', 'Subject data exceeds the 24 KB limit.');
  if (serialized.includes('"__proto__"') || serialized.includes('"constructor"') || serialized.includes('"prototype"')) {
    throw new SheerFlowError('SUBJECT_INVALID', 'Subject data contains a forbidden property.');
  }
  return JSON.parse(serialized);
}

function delayWithAbort(milliseconds, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason || new Error('Aborted')); };
    signal?.addEventListener('abort', onAbort, { once:true });
  });
}

function publicJob(job) {
  return {
    id: job.id,
    verificationId: job.verificationId,
    status: job.status,
    currentStep: job.currentStep,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    message: job.message,
    events: job.events.map(event => ({ ...event })),
    documentAttempts: job.documentAttempts,
    errorIds: [...(job.errorIds || [])],
    rewardData: job.rewardData || null,
    canResubmit: job.status === 'input_required',
    canUploadDocument: job.status === 'needs_document' && Boolean(job.submissionUrl),
    canRefresh: Boolean(job.verificationId) && ['waiting', 'action_required', 'unknown', 'needs_document', 'stopped'].includes(job.status),
    canCancel: !TERMINAL.has(job.status) && job.status !== 'stopped'
      && !(['unknown', 'stopped'].includes(job.status) && !job.verificationId),
    canClear: TERMINAL.has(job.status),
  };
}

export class JobManager {
  #fingerprintKey = randomBytes(32);
  #jobs = new Map();
  #requestIds = new Map();
  #queue = [];
  #active = 0;
  #timers = new Map();

  constructor({ client, programId, concurrency = 2, pollIntervalMs = 5000, maxDocumentBytes, clock = () => new Date() }) {
    this.client = client;
    this.programId = programId;
    this.concurrency = Math.max(1, Math.min(8, concurrency));
    this.pollIntervalMs = Math.max(3000, Math.min(300_000, pollIntervalMs));
    this.maxDocumentBytes = maxDocumentBytes;
    this.clock = clock;
  }

  list() { return [...this.#jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob); }

  get(id) {
    const job = this.#jobs.get(id);
    if (!job) throw new SheerFlowError('JOB_NOT_FOUND', 'Job not found.');
    return publicJob(job);
  }

  create({ subjectData, consent, clientRequestId, demoScenario = 'approved' }) {
    if (consent !== true) throw new SheerFlowError('CONSENT_REQUIRED', 'Confirm that you are authorized to use this program and that the submitted data is accurate.');
    if (typeof clientRequestId !== 'string' || !/^[a-f\d-]{36}$/i.test(clientRequestId)) {
      throw new SheerFlowError('REQUEST_ID_REQUIRED', 'A valid client request ID is required to prevent duplicate job creation.');
    }
    const normalizedSubject = validateSubject(subjectData);
    const fingerprint = createHmac('sha256', this.#fingerprintKey).update(JSON.stringify({ subjectData:normalizedSubject, demoScenario })).digest('hex');
    if (this.#requestIds.has(clientRequestId)) {
      const existing = this.#jobs.get(this.#requestIds.get(clientRequestId));
      if (existing.subjectFingerprint !== fingerprint) throw new SheerFlowError('IDEMPOTENCY_CONFLICT', 'This request ID was already used with different subject data. Reconcile the existing job before starting another verification.');
      return publicJob(existing);
    }
    if (this.#jobs.size >= 200) throw new SheerFlowError('JOB_HISTORY_FULL', 'The in-memory job history reached 200 records. Restart the process after exporting the operational metadata you need.');
    if (this.#queue.length + this.#active >= 50) throw new SheerFlowError('QUEUE_FULL', 'The job queue is full. Try again after a job finishes.');
    const id = randomUUID();
    const now = this.clock().toISOString();
    const job = {
      id, clientRequestId, verificationId: null, status: 'queued', currentStep: 'queued', createdAt: now, updatedAt: now,
      message: 'Waiting for an available worker.', events: [], documentAttempts: 0, errorIds: [],
      submissionUrl: null, statusUrl: null, rewardData: null, subjectData: normalizedSubject, subjectFingerprint: fingerprint, demoScenario, controller: null, active: false,
    };
    this.#jobs.set(id, job);
    this.#requestIds.set(clientRequestId, id);
    this.#event(job, 'queued', 'Verification queued.');
    this.#queue.push(id);
    this.#drain();
    return publicJob(job);
  }

  cancel(id) {
    const job = this.#mustGet(id);
    if (TERMINAL.has(job.status)) return publicJob(job);
    if (['unknown', 'stopped'].includes(job.status) && !job.verificationId) {
      throw new SheerFlowError('JOB_OUTCOME_UNKNOWN', 'The provider may have created a verification, but no ID was received. Reconcile the request before cancelling or retrying it.');
    }
    this.#clearTimer(id);
    if (job.status === 'queued') {
      this.#queue = this.#queue.filter(item => item !== id);
      job.subjectData = null;
      this.#set(job, 'cancelled', 'Queued job cancelled. Submitted subject data was cleared from memory.');
    } else if (job.controller) {
      job.controller.abort();
      job.message = 'Cancellation requested. A remote operation may still be completing.';
      this.#touch(job);
      this.#event(job, 'cancel_requested', job.message);
    } else if (job.verificationId) {
      this.#set(job, 'stopped', 'Local polling stopped. The provider verification remains active; use Refresh to check its current state.');
    } else if (job.status === 'unknown') {
      this.#set(job, 'stopped', 'Local tracking stopped. The provider may have received the start request; reconcile before retrying.');
    } else {
      this.#set(job, 'cancelled', 'Job cancelled before a provider verification was created.');
    }
    return publicJob(job);
  }

  delete(id) {
    const job = this.#mustGet(id);
    const clearable = TERMINAL.has(job.status);
    if (!clearable || job.controller || job.active) {
      throw new SheerFlowError('JOB_NOT_CLEARABLE', 'Only completed or locally cancelled jobs can be removed from history.');
    }
    this.#clearTimer(id);
    this.#jobs.delete(id);
    this.#requestIds.delete(job.clientRequestId);
    return { id, deleted:true };
  }

  async uploadDocument(id, bytes, fileName) {
    return this.uploadDocuments(id, [{ bytes, fileName }]);
  }

  async uploadDocuments(id, files) {
    const job = this.#mustGet(id);
    if (job.status !== 'needs_document') throw new SheerFlowError('JOB_NOT_READY_FOR_DOCUMENT', 'This job is not waiting for a document.');
    if (!job.submissionUrl) throw new SheerFlowError('MISSING_UPLOAD_STEP_URL', 'The provider has not returned a valid document-upload step URL. Refresh status before uploading.');
    if (!Array.isArray(files) || files.length < 1 || files.length > 5) throw new SheerFlowError('INVALID_DOCUMENT_COUNT', 'Select between 1 and 5 documents.');
    const documents = [];
    try {
      for (const item of files) documents.push(inspectDocument(item.bytes, item.fileName, this.maxDocumentBytes));
    } catch (error) {
      for (const item of files) if (Buffer.isBuffer(item.bytes)) item.bytes.fill(0);
      throw error;
    }
    const totalBytes = documents.reduce((sum, item) => sum + item.fileSize, 0);
    if (totalBytes > this.maxDocumentBytes) {
      for (const document of documents) document.bytes.fill(0);
      throw new SheerFlowError('DOCUMENT_BATCH_TOO_LARGE', 'The combined document size exceeds the configured upload limit.');
    }
    job.status = 'uploading'; job.currentStep = 'docUpload'; job.message = 'Initiating secure document upload.';
    job.controller = new AbortController(); this.#touch(job);
    this.#event(job, 'document_upload_started', `Uploading ${documents.length} document${documents.length === 1 ? '' : 's'}.`);
    try {
      const initiated = await this.client.initiateDocumentUpload(job.verificationId, job.submissionUrl, documents.map(document => ({
        fileName: document.fileName, mimeType: document.mimeType, fileSize: document.fileSize,
      })), job.controller.signal);
      if (initiated?.errorIds?.length || initiated?.currentStep !== 'docUpload') throw new SheerFlowError('DOCUMENT_INITIATION_REJECTED', 'SheerID did not accept the document upload request.');
      if (!Array.isArray(initiated?.documents) || initiated.documents.length !== documents.length) {
        throw new SheerFlowError('UPLOAD_RESPONSE_INVALID', 'SheerID did not return one upload URL per document.');
      }
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        const remote = initiated.documents[index];
        if (remote?.errors?.length || typeof remote?.uploadUrl !== 'string'
          || (remote.mimeType && remote.mimeType !== document.mimeType)
          || (remote.fileSize && remote.fileSize !== document.fileSize)) {
          throw new SheerFlowError('UPLOAD_METADATA_MISMATCH', 'SheerID returned document metadata that did not match the selected file.');
        }
        await this.client.uploadToSignedUrl(remote.uploadUrl, document.bytes, document.mimeType, job.controller.signal);
      }
      const finished = await this.client.completeDocumentUpload(job.verificationId, initiated.submissionUrl, job.controller.signal);
      job.documentAttempts += 1;
      this.#applyRemoteState(job, finished, 'Document upload complete.');
      if (job.status === 'waiting') this.#schedulePoll(job);
      return publicJob(job);
    } catch (error) {
      if (job.controller.signal.aborted) {
        this.#set(job, error.uncertain ? 'unknown' : 'cancelled', error.uncertain
          ? 'Upload outcome is unknown. Refresh the verification status before continuing.' : 'Document upload cancelled.');
      } else if (error.uncertain) {
        this.#set(job, 'unknown', error.message || 'Document upload outcome is unknown. Refresh status before continuing.');
      } else {
        this.#set(job, 'needs_document', error.message || 'Document upload failed. Correct the file or retry after checking provider status.');
      }
      throw error;
    } finally {
      for (const document of documents) document.bytes.fill(0);
      job.controller = null;
    }
  }

  async resubmitSubject(id, { subjectData, consent }) {
    const job = this.#mustGet(id);
    if (job.status !== 'input_required' || !job.verificationId || !job.submissionUrl) throw new SheerFlowError('JOB_NOT_RESUBMITTABLE', 'This job is not waiting for corrected subject information.');
    if (consent !== true) throw new SheerFlowError('CONSENT_REQUIRED', 'Confirm that the corrected information is accurate and authorized.');
    const payload = validateSubject(subjectData);
    const controller = new AbortController();
    job.controller = controller;
    this.#set(job, 'running', 'Submitting corrected information to the same verification step.');
    try {
      const response = await this.#submitSubjectWithRetries(job, job.submissionUrl, payload, controller.signal);
      this.#applyRemoteState(job, response, 'Corrected information submitted.');
      if (job.status === 'waiting') this.#schedulePoll(job);
      return publicJob(job);
    } catch (error) {
      if (controller.signal.aborted) this.#set(job, error.uncertain ? 'unknown' : 'cancelled', error.message);
      else if (error.uncertain) this.#set(job, 'unknown', error.message);
      else this.#set(job, 'failed', error.message || 'Corrected information could not be submitted.');
      throw error;
    } finally {
      job.controller = null;
      // The submitted subject object is not retained by the job manager.
    }
  }

  async refresh(id) {
    const job = this.#mustGet(id);
    if (!job.verificationId) throw new SheerFlowError('VERIFICATION_ID_UNAVAILABLE', 'The start request did not return a verification ID; do not create a duplicate automatically. Reconcile this request with your SheerID account administrator.');
    if (!['waiting', 'action_required', 'unknown', 'needs_document', 'stopped'].includes(job.status)) return publicJob(job);
    this.#clearTimer(id);
    try {
      const current = await this.client.getStatus(job.verificationId, job.statusUrl);
      job.pollFailures = 0;
      this.#applyRemoteState(job, current, 'Status refreshed.');
      if (job.status === 'waiting') this.#schedulePoll(job);
      return publicJob(job);
    } catch (error) {
      this.#event(job, 'refresh_failed', 'Status refresh failed. Sensitive response data was not retained.');
      throw error;
    }
  }

  #mustGet(id) {
    const job = this.#jobs.get(id);
    if (!job) throw new SheerFlowError('JOB_NOT_FOUND', 'Job not found.');
    return job;
  }

  #touch(job) { job.updatedAt = this.clock().toISOString(); }
  #event(job, type, message) {
    job.events.push({ at: this.clock().toISOString(), type, message });
    if (job.events.length > 100) job.events.shift();
    this.#touch(job);
  }
  #set(job, status, message) {
    job.status = status; job.message = message; this.#touch(job); this.#event(job, status, message);
  }
  async #submitSubjectWithRetries(job, submissionUrl, payload, signal, demoScenario) {
    let response = await this.client.submitSubject(job.verificationId, submissionUrl, payload, signal, demoScenario);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const errors = Array.isArray(response?.errorIds) ? response.errorIds : [];
      if (response?.currentStep === 'error' || errors.length === 0 || !errors.every(code => TRANSIENT_SUBJECT_ERRORS.has(code))) break;
      await delayWithAbort(500 * (2 ** attempt), signal);
      response = await this.client.submitSubject(job.verificationId, submissionUrl, payload, signal, demoScenario);
    }
    return response;
  }

  #applyRemoteState(job, response, prefix = '') {
    const step = response?.currentStep;
    if (typeof response?.verificationId === 'string' && response.verificationId !== job.verificationId) {
      throw new SheerFlowError('VERIFICATION_ID_MISMATCH', 'The API response did not match the active verification.');
    }
    job.currentStep = typeof step === 'string' ? step : 'unknown';
    job.errorIds = Array.isArray(response?.errorIds) ? response.errorIds : [];
    if (typeof response?.submissionUrl === 'string') job.submissionUrl = response.submissionUrl;
    else if (step === 'docUpload') job.submissionUrl = null;
    if (typeof response?.statusUrl === 'string') job.statusUrl = response.statusUrl;
    if (step === 'success') {
      job.rewardData = response.rewardData && typeof response.rewardData === 'object'
        ? response.rewardData : response.rewardCode ? { rewardCode: response.rewardCode } : null;
      this.#set(job, 'approved', 'SheerID reported a successful verification.');
    } else if (step === 'error') {
      this.#set(job, 'rejected', `SheerID returned a terminal error${job.errorIds.length ? ` (${job.errorIds.join(', ')})` : ''}.`);
    } else if (step === 'docUpload') {
      this.#set(job, 'needs_document', prefix || 'An authentic supporting document is required.');
    } else if (step === 'pending') {
      this.#set(job, 'waiting', prefix || 'Verification is pending review.');
    } else if (step === 'emailLoop' || step === 'sso') {
      this.#set(job, 'action_required', step === 'emailLoop'
        ? 'The user must complete the email verification step.' : 'The user must complete the organization sign-in step.');
    } else if (typeof step === 'string' && STEP_COLLECT.test(step)) {
      const sourceUnavailable = job.errorIds.length > 0 && job.errorIds.every(code => TRANSIENT_SUBJECT_ERRORS.has(code));
      this.#set(job, 'input_required', sourceUnavailable
        ? `The provider's verification source is temporarily unavailable (${job.errorIds.join(', ')}). Retry this same verification step later; do not create a new verification.`
        : job.errorIds.length
          ? `The provider returned recoverable field errors (${job.errorIds.join(', ')}). Correct the payload and resubmit this same verification.`
          : 'The provider still requires information for this step.');
    } else if (job.errorIds.length) {
      this.#set(job, 'action_required', `Provider returned recoverable errors (${job.errorIds.join(', ')}).`);
    } else {
      this.#set(job, 'action_required', `Provider returned workflow step: ${String(step || 'unknown')}.`);
    }
  }

  #drain() {
    while (this.#active < this.concurrency && this.#queue.length) {
      const id = this.#queue.shift();
      const job = this.#jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.#active += 1;
      job.active = true;
      job.controller = new AbortController();
      void this.#run(job).finally(() => {
        job.active = false; job.controller = null; this.#active -= 1; this.#drain();
      });
    }
  }

  async #run(job) {
    this.#set(job, 'running', 'Creating an authorized verification with SheerID.');
    try {
      const created = await this.client.createVerification(this.programId, job.controller.signal);
      job.verificationId = created.verificationId;
      job.currentStep = created.currentStep;
      job.submissionUrl = created.submissionUrl || null;
      job.statusUrl = created.statusUrl || null;
      this.#event(job, 'verification_created', 'SheerID created a verification record.');
      if (created.currentStep === 'error') {
        job.subjectData = null;
        this.#applyRemoteState(job, created);
      } else if (created.currentStep === 'success') {
        job.subjectData = null;
        this.#applyRemoteState(job, created, 'Verification completed immediately.');
      } else if (STEP_COLLECT.test(created.currentStep) && !(created.errorIds?.length)) {
        const subject = job.subjectData;
        if (!subject) throw new SheerFlowError('SUBJECT_MISSING', 'Subject data is no longer available.');
        const submitted = await this.#submitSubjectWithRetries(job, created.submissionUrl, subject, job.controller.signal, job.demoScenario);
        job.subjectData = null;
        this.#applyRemoteState(job, submitted, 'Subject details submitted.');
        if (job.status === 'waiting') this.#schedulePoll(job);
      } else {
        job.subjectData = null;
        this.#applyRemoteState(job, created);
        if (job.status === 'waiting') this.#schedulePoll(job);
      }
      if (job.status === 'running') this.#set(job, 'action_required', `Workflow step ${created.currentStep} requires user action.`);
    } catch (error) {
      job.subjectData = null;
      if (job.controller?.signal.aborted) this.#set(job, error.uncertain ? 'unknown' : 'cancelled', error.uncertain
        ? 'The provider may have received the request. Do not automatically submit it again.' : 'Job cancelled.');
      else if (error.uncertain) this.#set(job, 'unknown', error.message);
      else this.#set(job, 'failed', error.message || 'Verification workflow failed.');
    }
  }

  #schedulePoll(job, delayMs = this.pollIntervalMs) {
    this.#clearTimer(job.id);
    if (job.status !== 'waiting') return;
    const timer = setTimeout(async () => {
      this.#timers.delete(job.id);
      try {
        const response = await this.client.getStatus(job.verificationId, job.statusUrl);
        job.pollFailures = 0;
        this.#applyRemoteState(job, response);
        if (job.status === 'waiting') this.#schedulePoll(job);
      } catch {
        job.pollFailures += 1;
        this.#event(job, 'poll_failed', 'Status polling failed. SheerFlow will retry a limited number of times.');
        if (job.pollFailures < 3 && job.status === 'waiting') this.#schedulePoll(job, Math.min(60_000, this.pollIntervalMs * (2 ** job.pollFailures)));
        else this.#event(job, 'poll_paused', 'Automatic polling paused after repeated errors. Use Refresh to check again.');
      }
    }, delayMs);
    timer.unref?.();
    this.#timers.set(job.id, timer);
  }

  #clearTimer(id) {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
  }

  close() {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const job of this.#jobs.values()) {
      if (job.controller) job.controller.abort();
      if (!TERMINAL.has(job.status)) this.#set(job, (job.verificationId || job.status === 'unknown') ? 'stopped' : 'cancelled', (job.verificationId || job.status === 'unknown')
        ? 'Application stopped; the provider verification may still be active. Refresh its status after restarting.'
        : 'Application stopped before a provider verification was created.');
      job.subjectData = null;
    }
  }
}
