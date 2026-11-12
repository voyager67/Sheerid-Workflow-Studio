/** Local-only provider fixture for screenshots, demos and automated tests. Never contacts SheerID. */
export class MockSheerIDClient {
  #records = new Map();
  #next = 1;

  async createVerification(_programId, signal) {
    signal?.throwIfAborted();
    const id = this.#next.toString(16).padStart(24, '0');
    this.#next += 1;
    this.#records.set(id, { scenario: 'approved', polls: 0 });
    return { verificationId: id, currentStep: 'collectStudentPersonalInfo', errorIds: [], submissionUrl: `https://services.sheerid.com/rest/v2/verification/${id}/step/collectStudentPersonalInfo` };
  }

  async submitSubject(id, _url, _subject, signal, scenario = 'approved') {
    signal?.throwIfAborted();
    const record = this.#records.get(id);
    record.scenario = scenario;
    if (scenario === 'needs_document') return { verificationId: id, currentStep: 'docUpload', errorIds: [], submissionUrl: `https://services.sheerid.com/rest/v2/verification/${id}/step/docUpload` };
    if (scenario === 'rejected') return { verificationId: id, currentStep: 'error', errorIds: ['mockRejected'] };
    if (scenario === 'pending') return { verificationId: id, currentStep: 'pending', errorIds: [], statusUrl: `https://services.sheerid.com/rest/v2/verification/${id}` };
    return { verificationId: id, currentStep: 'success', errorIds: [], rewardData: { rewardCode: 'DEMO-REWARD-2026' } };
  }

  async getStatus(id, _url, signal) {
    signal?.throwIfAborted();
    const record = this.#records.get(id);
    record.polls += 1;
    const step = record.scenario === 'pending' && record.polls > 1 ? 'success' : record.scenario === 'pending' ? 'pending' : 'docUpload';
    return { verificationId: id, currentStep: step, errorIds: [], statusUrl:`https://services.sheerid.com/rest/v2/verification/${id}`, ...(step === 'success' ? { rewardData:{ rewardCode:'DEMO-REWARD-2026' } } : {}) };
  }

  async getProgramTheme(_programId) {
    return { config:{ orgSearchUrl:'https://orgsearch.sheerid.net/rest/organization/search?country=US&type=UNIVERSITY&name=' } };
  }

  async searchOrganizations(_programId, query) {
    const term = String(query || '').toLowerCase();
    return [{ id:4597, name:'Example Technical Institute', country:'US', type:'UNIVERSITY' }]
      .filter(organization => organization.name.toLowerCase().includes(term) || term.includes('example'));
  }

  async initiateDocumentUpload(id, _submissionUrl, files, signal) {
    signal?.throwIfAborted();
    return { verificationId: id, currentStep: 'docUpload', errorIds: [], documents: files.map(file => ({ ...file, uploadUrl: 'https://uploads.example.invalid/mock-signed-url', errors: [] })), submissionUrl: `https://services.sheerid.com/rest/v2/verification/${id}/step/completeDocUpload` };
  }

  async uploadToSignedUrl(_url, _bytes, _mimeType, signal) { signal?.throwIfAborted(); }

  async completeDocumentUpload(id, _url, signal) {
    signal?.throwIfAborted();
    this.#records.get(id).scenario = 'pending';
    this.#records.get(id).polls = 0;
    return { verificationId: id, currentStep: 'pending', errorIds: [], statusUrl: `https://services.sheerid.com/rest/v2/verification/${id}` };
  }
}
