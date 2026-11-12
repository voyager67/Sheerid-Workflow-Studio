const state = { csrf: '', config: null, jobs: [], selectedId: null, busy: false };
const $ = (id) => document.getElementById(id);
const terminal = new Set(['approved','rejected','failed','cancelled']);
const labels = {
  queued:'Queued', running:'Running', waiting:'Pending review', approved:'Approved',
  rejected:'Rejected', failed:'Failed', needs_document:'Document required',
  action_required:'Action required', input_required:'Input required',
  uploading:'Uploading', unknown:'Outcome unknown', cancelled:'Cancelled'
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type','application/json');
  if (state.csrf && options.method && options.method !== 'GET') headers.set('x-csrf-token',state.csrf);
  const response = await fetch(path,{...options,headers,credentials:'same-origin'});
  const data = response.status === 204 ? {} : await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data?.error?.message || `Request failed (${response.status})`);
  return data;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function formatTime(value) {
  try { return new Date(value).toLocaleString(); } catch { return value || ''; }
}
function statusClass(status) { return String(status || 'unknown').replace(/[^a-z_]/g,''); }

async function login(password) {
  const data = await api('/api/login',{method:'POST',body:JSON.stringify({password})});
  state.csrf = data.csrfToken;
  await initialize();
}
async function initialize() {
  state.config = await api('/api/config');
  $('mode-pill').textContent = state.config.mode === 'live' ? 'LIVE API' : 'LOCAL DEMO';
  $('mode-pill').className = `pill ${state.config.mode === 'live' ? 'live' : 'demo'}`;
  $('program-label').textContent = state.config.programLabel;
  $('demo-options').hidden = state.config.mode !== 'demo';
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  await loadJobs();
}
async function loadJobs() {
  const data = await api('/api/jobs');
  state.jobs = data.jobs || [];
  renderJobs();
  if (state.selectedId) {
    const selected = state.jobs.find(job => job.id === state.selectedId);
    if (selected) renderDetails(selected); else closeDetails();
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
      <span class="job-icon ${statusClass(job.status)}">${job.status === 'approved' ? '✓' : job.status === 'rejected' ? '×' : '◷'}</span>
      <span class="job-copy"><strong>${escapeHtml(job.verificationId ? job.verificationId.slice(0,8)+'…' : 'New verification')}</strong><small>${escapeHtml(job.message)}</small><small class="timestamp">${escapeHtml(formatTime(job.updatedAt))}</small></span>
      <span class="status ${statusClass(job.status)}">${escapeHtml(labels[job.status] || job.status)}</span>
      <span class="chevron">›</span>
    </button>`).join('');
  list.querySelectorAll('[data-job]').forEach(button => button.addEventListener('click',() => selectJob(button.dataset.job)));
}
async function selectJob(id) {
  state.selectedId = id;
  const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
  renderDetails(data.job);
}
function renderDetails(job) {
  $('detail-panel').hidden = false;
  $('detail-title').textContent = job.verificationId ? `Verification ${job.verificationId.slice(0,8)}…` : 'Verification details';
  $('detail-summary').innerHTML = `
    <div><span>Status</span><strong class="status ${statusClass(job.status)}">${escapeHtml(labels[job.status] || job.status)}</strong></div>
    <div><span>Provider step</span><strong>${escapeHtml(job.currentStep || '—')}</strong></div>
    <div><span>Updated</span><strong>${escapeHtml(formatTime(job.updatedAt))}</strong></div>
    <div><span>Documents</span><strong>${escapeHtml(job.documentAttempts || 0)} upload rounds</strong></div>`;
  $('document-action').hidden = !job.canUploadDocument;
  $('document-error').textContent = '';
  $('timeline').innerHTML = (job.events || []).slice().reverse().map(event => `
    <div class="timeline-item"><span class="timeline-dot"></span><div><strong>${escapeHtml(event.type.replaceAll('_',' '))}</strong><p>${escapeHtml(event.message)}</p><time>${escapeHtml(formatTime(event.at))}</time></div></div>`).join('');
  if (job.errorIds?.length) $('timeline').insertAdjacentHTML('afterbegin',`<p class="error-codes">Provider error codes: ${escapeHtml(job.errorIds.join(', '))}</p>`);
}
function closeDetails() { state.selectedId = null; $('detail-panel').hidden = true; }

$('login-form').addEventListener('submit',async event => {
  event.preventDefault(); $('login-error').textContent = '';
  try { await login($('password').value); $('password').value = ''; }
  catch(error) { $('login-error').textContent = error.message; }
});
$('create-form').addEventListener('submit',async event => {
  event.preventDefault(); $('create-error').textContent = '';
  let subjectData;
  try { subjectData = JSON.parse($('subject-json').value); }
  catch { $('create-error').textContent = 'Subject payload must be valid JSON.'; return; }
  if (!subjectData || Array.isArray(subjectData) || typeof subjectData !== 'object') { $('create-error').textContent = 'Subject payload must be a JSON object.'; return; }
  try {
    const body = { subjectData, consent:$('consent').checked, clientRequestId:crypto.randomUUID() };
    if (state.config.mode === 'demo') body.demoScenario = $('demo-scenario').value;
    const result = await api('/api/jobs',{method:'POST',body:JSON.stringify(body)});
    await loadJobs(); await selectJob(result.job.id);
  } catch(error) { $('create-error').textContent = error.message; }
});
$('refresh-all').addEventListener('click',() => loadJobs().catch(error => alert(error.message)));
$('close-detail').addEventListener('click',closeDetails);
$('logout').addEventListener('click',async () => {
  try { await api('/api/logout',{method:'POST',body:'{}'}); } catch {}
  location.reload();
});
$('document-form').addEventListener('submit',async event => {
  event.preventDefault(); $('document-error').textContent = '';
  const files = $('document-files').files;
  if (!files.length || files.length > 5) { $('document-error').textContent = 'Select between one and five files.'; return; }
  const form = new FormData(); [...files].forEach(file => form.append('documents',file,file.name));
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedId)}/documents`,{method:'POST',body:form});
    $('document-files').value = ''; await loadJobs();
  } catch(error) { $('document-error').textContent = error.message; }
});
setInterval(() => { if (!$('app-view').hidden) loadJobs().catch(()=>{}); },5000);
