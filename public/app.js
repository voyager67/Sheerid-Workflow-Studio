const state = {
  csrf: '',
  config: null,
  jobs: [],
  selectedId: null,
  organizationResults: [],
  organizationBusy: false,
  resubmitDraftJobId: null,
  refreshBusy: false
};
const $ = (id) => document.getElementById(id);
const terminal = new Set(['approved', 'rejected', 'failed', 'cancelled']);
const labels = {
  queued:'Queued', running:'Running', waiting:'Pending review', approved:'Approved',
  rejected:'Rejected', failed:'Failed', needs_document:'Document required',
  action_required:'Action required', input_required:'Input required',
  uploading:'Uploading', unknown:'Outcome unknown', stopped:'Tracking stopped',
  cancelled:'Cancelled'
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (state.csrf && options.method && options.method !== 'GET') headers.set('x-csrf-token', state.csrf);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status === 401 && state.csrf && path !== '/api/login') {
    state.csrf = '';
    location.reload();
    throw new Error('Your local session expired. Sign in again.');
  }
  if (!response.ok) throw new Error(data?.error?.message || `Request failed (${response.status}).`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function statusClass(status) {
  return /^[a-z_]+$/.test(status || '') ? status : 'unknown';
}
function showNotice(message, error = false) {
  const node = $('app-notice');
  if (!node) return;
  node.textContent = message;
  node.className = error ? 'notice error' : 'notice';
  node.hidden = !message;
}
function demoSubject() {
  return JSON.stringify({
    firstName: 'Alex',
    lastName: 'Morgan',
    birthDate: '2002-04-16',
    email: 'alex.morgan@example.test',
    organization: { id: 0, name: 'Example Technical Institute (fictional demo)' }
  }, null, 2);
}
function emptySubject() {
  return JSON.stringify({
    firstName: '',
    lastName: '',
    birthDate: 'YYYY-MM-DD',
    email: '',
    organization: { id: 0, name: '' }
  }, null, 2);
}

async function login(password) {
  const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
  state.csrf = data.csrfToken;
  await initialize();
}
async function initialize() {
  state.config = await api('/api/config');
  const demo = state.config.mode === 'demo';
  $('mode-pill').textContent = demo ? 'LOCAL DEMO' : 'LIVE API';
  $('mode-pill').className = `pill ${demo ? 'demo' : 'live'}`;
  $('program-label').textContent = state.config.programLabel;
  $('demo-options').hidden = !demo;
  $('subject-json').value = demo ? demoSubject() : emptySubject();
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  await loadJobs();
}
async function loadJobs() {
  const data = await api('/api/jobs');
  state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  renderJobs();
  if (state.selectedId) {
    const selected = state.jobs.find(job => job.id === state.selectedId);
    if (selected) renderDetails(selected);
    else closeDetails();
  }
}
function renderJobs() {
  const list = $('job-list');
  $('empty-state').hidden = state.jobs.length > 0;
  $('queue-count').textContent = `${state.jobs.length} jobs`;
  $('metric-total').textContent = state.jobs.length;
  $('metric-active').textContent = state.jobs.filter(job => ['queued','running','waiting','uploading','unknown'].includes(job.status)).length;
  $('metric-approved').textContent = state.jobs.filter(job => job.status === 'approved').length;
  $('metric-action').textContent = state.jobs.filter(job => ['needs_document','action_required','input_required'].includes(job.status)).length;
  list.innerHTML = state.jobs.map(job => `
    <button class="job-row" data-job="${escapeHtml(job.id)}" type="button">
      <span class="job-icon ${statusClass(job.status)}">${job.status === 'approved' ? '✓' : job.status === 'rejected' ? '×' : job.status === 'stopped' ? 'Ⅱ' : '◷'}</span>
      <span class="job-copy">
        <strong>${escapeHtml(job.verificationId ? job.verificationId.slice(0, 8) + '…' : 'New verification')}</strong>
        <small>${escapeHtml(job.message)}</small>
        <small class="timestamp">${escapeHtml(formatTime(job.updatedAt))}</small>
      </span>
      <span class="status ${statusClass(job.status)}">${escapeHtml(labels[job.status] || job.status)}</span>
      <span class="chevron">›</span>
    </button>`).join('');
  list.querySelectorAll('[data-job]').forEach(button => {
    button.addEventListener('click', () => selectJob(button.dataset.job).catch(error => showNotice(error.message, true)));
  });
}
async function selectJob(id) {
  state.selectedId = id;
  state.resubmitDraftJobId = null;
  const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
  renderDetails(data.job);
}
function renderDetails(job) {
  $('detail-panel').hidden = false;
  $('detail-title').textContent = job.verificationId
    ? `Verification ${job.verificationId.slice(0, 8)}…` : 'Verification details';

  $('detail-refresh').hidden = !job.canRefresh;
  $('detail-stop').hidden = !job.canCancel;
  $('detail-stop').textContent = job.status === 'queued' ? 'Cancel queued job' : 'Stop local tracking';
  $('detail-clear').hidden = !job.canClear;

  $('detail-summary').innerHTML = `
    <div><span>Status</span><strong class="status ${statusClass(job.status)}">${escapeHtml(labels[job.status] || job.status)}</strong></div>
    <div><span>Provider step</span><strong>${escapeHtml(job.currentStep || '—')}</strong></div>
    <div><span>Updated</span><strong>${escapeHtml(formatTime(job.updatedAt))}</strong></div>
    <div><span>Document rounds</span><strong>${escapeHtml(job.documentAttempts || 0)}</strong></div>`;

  $('resubmit-action').hidden = !job.canResubmit;
  $('document-action').hidden = !job.canUploadDocument;
  $('document-error').textContent = '';
  $('resubmit-error').textContent = '';
  if (job.canResubmit && state.resubmitDraftJobId !== job.id) {
    $('resubmit-json').value = $('subject-json').value || emptySubject();
    $('resubmit-consent').checked = false;
    state.resubmitDraftJobId = job.id;
  }
  $('timeline').innerHTML = (job.events || []).slice().reverse().map(event => `
    <div class="timeline-item">
      <span class="timeline-dot"></span>
      <div>
        <strong>${escapeHtml(String(event.type || '').replaceAll('_', ' '))}</strong>
        <p>${escapeHtml(event.message)}</p>
        <time>${escapeHtml(formatTime(event.at))}</time>
      </div>
    </div>`).join('');
  if (job.errorIds?.length) {
    $('timeline').insertAdjacentHTML('afterbegin',
      `<p class="error-codes">Provider error codes: ${escapeHtml(job.errorIds.join(', '))}</p>`);
  }
  if (job.rewardData && typeof job.rewardData === 'object') {
    const reward = Object.entries(job.rewardData)
      .filter(([key, value]) => typeof key === 'string' && typeof value === 'string' && value.length < 300)
      .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(' · ');
    if (reward) $('timeline').insertAdjacentHTML('afterbegin', `<p class="reward-result">${reward}</p>`);
  }
}
function closeDetails() {
  state.selectedId = null;
  state.resubmitDraftJobId = null;
  $('detail-panel').hidden = true;
}
function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy && label) {
    button.dataset.originalLabel ||= button.textContent;
    button.textContent = label;
  } else if (!busy && button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-error').textContent = '';
  const button = event.submitter;
  setBusy(button, true, 'Unlocking…');
  try {
    await login($('password').value);
    $('password').value = '';
  } catch (error) {
    $('login-error').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

$('organization-search-button').addEventListener('click', async () => {
  if (state.organizationBusy) return;
  const query = $('organization-query').value.trim();
  const container = $('organization-results');
  if (query.length < 2) {
    container.textContent = 'Enter at least two characters.';
    return;
  }
  state.organizationBusy = true;
  setBusy($('organization-search-button'), true, 'Searching…');
  container.textContent = '';
  try {
    const result = await api(`/api/organizations?q=${encodeURIComponent(query)}`);
    state.organizationResults = Array.isArray(result.organizations) ? result.organizations : [];
    if (!state.organizationResults.length) {
      container.textContent = 'No organizations matched. Try a more specific name.';
    } else {
      container.innerHTML = state.organizationResults.map((organization, index) => `
        <button class="org-result" type="button" data-org-index="${index}">
          <strong>${escapeHtml(organization.name)}</strong>
          <small>ID ${escapeHtml(organization.id)} · ${escapeHtml(organization.country || 'Country not provided')}</small>
        </button>`).join('');
      container.querySelectorAll('[data-org-index]').forEach(button => {
        button.addEventListener('click', () => {
          const organization = state.organizationResults[Number(button.dataset.orgIndex)];
          if (!organization) return;
          let payload;
          try { payload = JSON.parse($('subject-json').value || '{}'); }
          catch { payload = {}; }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
          payload.organization = { id: organization.id, name: organization.name };
          $('subject-json').value = JSON.stringify(payload, null, 2);
          container.querySelectorAll('.org-result').forEach(node => node.classList.remove('selected'));
          button.classList.add('selected');
        });
      });
    }
  } catch (error) {
    container.textContent = error.message;
  } finally {
    state.organizationBusy = false;
    setBusy($('organization-search-button'), false);
  }
});

$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('create-error').textContent = '';
  let subjectData;
  try { subjectData = JSON.parse($('subject-json').value); }
  catch { $('create-error').textContent = 'Subject payload must be valid JSON.'; return; }
  if (!subjectData || Array.isArray(subjectData) || typeof subjectData !== 'object') {
    $('create-error').textContent = 'Subject payload must be a JSON object.';
    return;
  }
  const button = event.submitter;
  setBusy(button, true, 'Creating…');
  try {
    const body = {
      subjectData,
      consent: $('consent').checked,
      clientRequestId: crypto.randomUUID()
    };
    if (state.config.mode === 'demo') body.demoScenario = $('demo-scenario').value;
    const result = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    state.selectedId = result.job.id;
    await loadJobs();
    await selectJob(result.job.id);
    showNotice('Verification job created.');
  } catch (error) {
    $('create-error').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

$('refresh-all').addEventListener('click', async () => {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  const button = $('refresh-all');
  setBusy(button, true, 'Refreshing…');
  const targets = state.jobs.filter(job => job.canRefresh);
  let refreshed = 0;
  let failed = 0;
  try {
    // Keep provider reads sequential to avoid bursts against program API limits.
    for (const job of targets) {
      try {
        await api(`/api/jobs/${encodeURIComponent(job.id)}/refresh`, { method: 'POST', body: '{}' });
        refreshed += 1;
      } catch {
        failed += 1;
      }
    }
    await loadJobs();
    showNotice(`Refreshed ${refreshed} provider status${refreshed === 1 ? '' : 'es'}${failed ? `; ${failed} failed` : ''}.`, failed > 0);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    state.refreshBusy = false;
    setBusy(button, false);
  }
});

$('detail-refresh').addEventListener('click', async () => {
  if (!state.selectedId) return;
  const button = $('detail-refresh');
  setBusy(button, true, 'Refreshing…');
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedId)}/refresh`, { method: 'POST', body: '{}' });
    await loadJobs();
    showNotice('Provider status refreshed.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

$('detail-stop').addEventListener('click', async () => {
  if (!state.selectedId) return;
  const button = $('detail-stop');
  setBusy(button, true, 'Stopping…');
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(state.selectedId)}/cancel`, { method: 'POST', body: '{}' });
    await loadJobs();
    showNotice(data.job?.status === 'stopped'
      ? 'Local tracking stopped. The provider verification is still active.'
      : 'Queued job cancelled locally.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

$('detail-clear').addEventListener('click', async () => {
  if (!state.selectedId) return;
  const button = $('detail-clear');
  setBusy(button, true, 'Removing…');
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedId)}`, { method: 'DELETE' });
    closeDetails();
    await loadJobs();
    showNotice('Local job history removed. The provider verification record is unchanged.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

$('resubmit-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('resubmit-error').textContent = '';
  if (!state.selectedId) return;
  let subjectData;
  try { subjectData = JSON.parse($('resubmit-json').value); }
  catch { $('resubmit-error').textContent = 'Corrected payload must be valid JSON.'; return; }
  if (!subjectData || Array.isArray(subjectData) || typeof subjectData !== 'object') {
    $('resubmit-error').textContent = 'Corrected payload must be a JSON object.';
    return;
  }
  const button = event.submitter;
  setBusy(button, true, 'Submitting…');
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedId)}/resubmit`, {
      method: 'POST',
      body: JSON.stringify({ subjectData, consent: $('resubmit-consent').checked })
    });
    await loadJobs();
    showNotice('Corrected information submitted to the existing verification.');
  } catch (error) {
    $('resubmit-error').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

$('close-detail').addEventListener('click', closeDetails);
$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  location.reload();
});
$('document-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('document-error').textContent = '';
  const files = $('document-files').files;
  if (!files.length || files.length > 5) {
    $('document-error').textContent = 'Select between one and five files.';
    return;
  }
  const form = new FormData();
  [...files].forEach(file => form.append('documents', file, file.name));
  const button = event.submitter;
  setBusy(button, true, 'Uploading…');
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedId)}/documents`, { method: 'POST', body: form });
    $('document-files').value = '';
    await loadJobs();
    showNotice('Document upload workflow completed. Check the provider status.');
  } catch (error) {
    $('document-error').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

setInterval(() => {
  if (!$('app-view').hidden) loadJobs().catch(() => {});
}, 5000);
