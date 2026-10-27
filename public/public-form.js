let activePortalTab = 'request';
let portalRevision = '';
let portalLastFullRefresh = 0;
const PORTAL_FULL_REFRESH_MS = 10 * 60000;
const PORTAL_REFRESH_MS = 60000;
const form = document.querySelector('#publicTicketForm');
const submitButton = document.querySelector('#publicSubmitButton');
const formMessage = document.querySelector('#publicFormMessage');
const successPanel = document.querySelector('#publicSuccess');
const successCode = document.querySelector('#publicSuccessCode');
const panelCode = document.querySelector('#publicPanelCode');
const areaSelect = form?.querySelector('[name="area"]');
const subareaField = document.querySelector('#publicSubareaField');
const subareaSelect = document.querySelector('#publicSubareaInput');
const typeSelect = form?.querySelector('[name="type"]');
const prioritySelect = form?.querySelector('[name="priority"]');
const attachmentInput = document.querySelector('#publicAttachmentInput');
const attachmentList = document.querySelector('#publicAttachmentList');
const attachmentCount = document.querySelector('#publicAttachmentCount');
const attachmentMessage = document.querySelector('#publicAttachmentMessage');
const uploadArea = document.querySelector('#publicUploadArea');
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set(['app', 'bat', 'cmd', 'com', 'dll', 'dmg', 'exe', 'jar', 'msi', 'ps1', 'scr', 'sh']);
let selectedAttachments = [];
let isSubmitting = false;
const entityToken = new URLSearchParams(window.location.search).get('entidad') || '';
let portalEntity = null;
let portalTickets = [];
let portalLoading = false;
const portalStatuses = { new: 'Recibido', review: 'En revisión', qa: 'En validación', blocked: 'Pendiente de información', done: 'Resuelto' };
let formConfig = window.normalizeMesaFormConfig
  ? window.normalizeMesaFormConfig(window.MESA_FORM_DEFAULTS)
  : { areas: [{ name: 'General', subareas: ['Consulta', 'Soporte', 'Seguimiento'] }], types: ['Solicitud', 'Bug', 'Mejora'], priorities: ['Media', 'Alta', 'Baja'] };

function applyPublicTheme() {
  const theme = formConfig.theme || {};
  const accent = theme.accent || '#f06a3c';
  const hot = theme.hot || accent;
  const ink = theme.ink || accent;
  const workspaceName = portalEntity?.name || theme.workspaceName || 'Mi mesa';
  const initials = theme.initials || workspaceName[0] || 'M';
  const root = document.documentElement;
  root.style.setProperty('--profile-color', accent);
  root.style.setProperty('--profile-hot', hot);
  root.style.setProperty('--profile-ink', ink);
  root.style.setProperty('--orange', accent);
  root.style.setProperty('--orange-hot', hot);
  root.style.setProperty('--orange-ink', ink);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = accent;
  const mark = document.querySelector('#publicBrandMark');
  const note = document.querySelector('#publicHeaderNote');
  const subtitle = document.querySelector('#publicBrandSubtitle');
  const intro = document.querySelector('#publicIntroCopy');
  const successWorkspace = document.querySelector('#publicSuccessWorkspace');
  const title = document.querySelector('title');
  if (mark) mark.textContent = initials.slice(0, 1);
  if (note) note.textContent = `${workspaceName.toUpperCase()} · RECEPCIÓN`;
  if (subtitle) subtitle.textContent = `${workspaceName} · formulario de solicitudes`;
  if (intro) intro.textContent = portalEntity
    ? `Envía una solicitud de ${workspaceName}. Después podrás consultar su estado y sus archivos en Mis tickets.`
    : `Completa este formulario y la solicitud llegará directamente a la mesa de ${workspaceName} con el contexto necesario para darle seguimiento.`;
  if (successWorkspace) successWorkspace.textContent = workspaceName;
  if (panelCode) panelCode.textContent = 'PEN—';
  if (title) title.textContent = `Enviar solicitud · Mesa de ${workspaceName}`;
}

function renderSubareas(areaName) {
  if (!subareaField || !subareaSelect) return;
  const area = formConfig.areas.find((item) => item.name === areaName);
  const subareas = area?.subareas || [];
  subareaField.classList.toggle('is-hidden', subareas.length === 0);
  subareaSelect.innerHTML = `<option value="">Selecciona un detalle</option>${subareas.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderFormOptions() {
  if (!areaSelect || !typeSelect || !prioritySelect) return;
  applyPublicTheme();
  areaSelect.innerHTML = `<option value="">Selecciona una opción</option>${formConfig.areas.map((area) => `<option value="${escapeHtml(area.name)}">${escapeHtml(area.name)}</option>`).join('')}`;
  typeSelect.innerHTML = `<option value="">Selecciona una opción</option>${formConfig.types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}`;
  prioritySelect.innerHTML = formConfig.priorities.map((priority) => `<option>${escapeHtml(priority)}</option>`).join('');
  renderSubareas('');
}

async function loadFormConfig() {
  try {
    const result = await fetch(entityToken ? `/api/portal/${encodeURIComponent(entityToken)}` : '/api/form-config');
    if (entityToken && !result.ok) {
      const error = await result.json().catch(() => ({}));
      throw new Error(error.error || 'Solicita un enlace nuevo a quien administra la mesa.');
    }
    if (result.ok) {
      const data = await result.json();
      if (entityToken) {
        portalRevision = result.headers.get('ETag') || '';
        portalLastFullRefresh = Date.now();
      }
      if (data.config && window.normalizeMesaFormConfig) formConfig = window.normalizeMesaFormConfig(data.config);
      if (entityToken) {
        portalEntity = window.MesaHours.track(data.entity);
        portalTickets = data.tickets || [];
        document.querySelector('#portalNavigation').classList.remove('is-hidden');
        document.querySelector('.public-header .brand').href = window.location.href;
        document.querySelector('#portalEntityCopy').textContent = `Solicitudes de ${portalEntity.name}. El estado se actualiza cada minuto mientras consultas tus tickets o tus horas.`;
        const viewTickets = document.createElement('button');
        viewTickets.type = 'button';
        viewTickets.className = 'button button-primary portal-success-link';
        viewTickets.textContent = 'Ver mis tickets';
        viewTickets.addEventListener('click', () => showPortalTab('tickets'));
        successPanel.append(viewTickets);
        renderPortalTickets();
        renderPortalHours();
      }
    }
  } catch (error) {
    console.error('No se pudo cargar el formulario.', error);
    if (entityToken) {
      document.querySelector('#publicRequestSection').classList.add('is-hidden');
      document.querySelector('#portalInvalid').classList.remove('is-hidden');
      document.querySelector('#portalInvalidMessage').textContent = error.message;
      return;
    }
  }
  renderFormOptions();
}

function showPortalTab(tab) {
  if (tab === 'hours' && portalEntity?.showHours !== true) tab = 'request';
  activePortalTab = tab;
  document.querySelector('#portalHoursPanel').classList.toggle('is-hidden', tab !== 'hours');
  document.querySelector('#publicRequestSection').classList.toggle('is-hidden', tab !== 'request');
  document.querySelector('#portalTicketsSection').classList.toggle('is-hidden', tab !== 'tickets');
  document.querySelectorAll('#portalNavigation [data-portal-tab]').forEach((button) => {
    const selected = button.dataset.portalTab === tab;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (tab === 'tickets' || tab === 'hours') void refreshPortalTickets();
  else if (successPanel.classList.contains('is-visible')) {
    successPanel.classList.remove('is-visible');
    form.classList.remove('is-hidden');
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const INLINE_PORTAL_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt']);

function canViewPortalFileInline(name) {
  return INLINE_PORTAL_EXTENSIONS.has(String(name || '').split('.').pop().toLowerCase());
}

function renderPortalAttachmentRows(ticketId, list) {
  return `<ul class="portal-attachment-list">${list.map((file) => {
    const baseUrl = `/api/portal/${encodeURIComponent(entityToken)}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(file.id)}`;
    const inline = canViewPortalFileInline(file.name);
    return `<li class="attachment-row">
      <svg class="attachment-file-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8l-5-5ZM14 3v6h5M8 13h8M8 17h6" /></svg>
      <span class="attachment-file-copy"><strong>${escapeHtml(file.name)}</strong><small>${fileSize(file.size || 0)}</small></span>
      <span class="attachment-actions">
        ${inline ? `<a class="attachment-action-link" href="${escapeHtml(`${baseUrl}?inline=1`)}" target="_blank" rel="noreferrer">Ver<span class="sr-only"> ${escapeHtml(file.name)}</span></a>` : ''}
        <a class="attachment-action-link" href="${escapeHtml(baseUrl)}" download="${escapeHtml(file.name)}">Descargar<span class="sr-only"> ${escapeHtml(file.name)}</span></a>
      </span>
    </li>`;
  }).join('')}</ul>`;
}

function renderPortalTickets() {
  document.querySelector('#portalTicketCount').textContent = portalTickets.length;
  const filter = document.querySelector('#portalStatusFilter').value;
  const items = portalTickets.filter((ticket) => filter === 'all' || ticket.status === filter);
  const expanded = new Set([...document.querySelectorAll('.portal-ticket[open]')].map((item) => item.dataset.ticketId));
  document.querySelector('#portalTicketsList').innerHTML = items.length ? items.map((ticket) => {
    const updated = new Date(ticket.updatedAt || ticket.createdAt).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
    const files = Array.isArray(ticket.attachments) ? ticket.attachments : [];
    const requestFiles = files.filter((file) => file.source !== 'desk');
    const deskFiles = files.filter((file) => file.source === 'desk');
    const fileSummary = files.length ? ` · ${files.length} archivo${files.length === 1 ? ' adjunto' : 's adjuntos'}` : '';
    return `<details class="portal-ticket" data-ticket-id="${escapeHtml(ticket.id)}" ${expanded.has(ticket.id) ? 'open' : ''}>
      <summary><span class="portal-ticket-summary"><span class="portal-ticket-id">${escapeHtml(ticket.id)}</span><strong>${escapeHtml(ticket.title)}</strong><small>Actualizado: ${escapeHtml(updated)}${escapeHtml(fileSummary)}</small></span><span class="portal-status status-${escapeHtml(ticket.status)}">${escapeHtml(portalStatuses[ticket.status] || 'Recibido')}</span></summary>
      <div class="portal-ticket-detail">
        <h3>Descripción</h3><p>${escapeHtml(ticket.description)}</p>
        <h3>Resultado esperado</h3><p>${escapeHtml(ticket.acceptance)}</p>
        ${requestFiles.length ? `<div class="attachment-group"><h3>Adjuntados en tu solicitud (${requestFiles.length})</h3>${renderPortalAttachmentRows(ticket.id, requestFiles)}</div>` : ''}
        ${deskFiles.length ? `<div class="attachment-group is-returned-group ${requestFiles.length ? 'has-previous-group' : ''}"><h3>Entregables y respuesta de la mesa (${deskFiles.length})</h3>${renderPortalAttachmentRows(ticket.id, deskFiles)}</div>` : ''}
      </div>
    </details>`;
  }).join('') : `<div class="portal-empty"><h2>${portalTickets.length ? 'No hay tickets con ese estado' : 'Todavía no has enviado solicitudes'}</h2><p>${portalTickets.length ? 'Selecciona otro estado para consultar tus solicitudes.' : 'Tu primera solicitud aparecerá aquí junto con su estado y sus evidencias.'}</p></div>`;
}

function renderPortalHours() {
  const section = document.querySelector('#portalHoursSection');
  const summary = document.querySelector('#portalHoursSummary');
  const visible = portalEntity?.showHours === true && Boolean(portalEntity.hours);
  const historySection = document.querySelector('#portalHoursHistorySection');
  const history = document.querySelector('#portalHoursHistory');
  const existingHistory = history.querySelector('.work-history');
  const open = existingHistory ? existingHistory.open : true;
  document.querySelector('#portalHoursTab').classList.toggle('is-hidden', !visible);
  if (!visible && activePortalTab === 'hours') showPortalTab('request');
  document.querySelector('#portalHoursPanel').classList.toggle('is-hidden', !visible || activePortalTab !== 'hours');
  section.classList.toggle('is-hidden', !visible);
  historySection.classList.toggle('is-hidden', !visible);
  summary.innerHTML = visible ? window.MesaHours.render(portalEntity, false, false) : '';
  history.innerHTML = visible ? (window.MesaHours.renderHistory(portalEntity, open) || '<p class="work-period">Todavía no hay horas registradas.</p>') : '';
}

async function refreshPortalTickets({ force = false } = {}) {
  if (!portalEntity || portalLoading) return;
  portalLoading = true;
  const button = document.querySelector('#portalRefreshButton');
  button.disabled = true;
  try {
    const response = await fetch(`/api/portal/${encodeURIComponent(entityToken)}`, {
      cache: 'no-store',
      headers: !force && portalRevision && Date.now() - portalLastFullRefresh < PORTAL_FULL_REFRESH_MS
        ? { 'If-None-Match': portalRevision } : {}
    });
    if (response.status === 304) {
      document.querySelector('#portalTicketsMessage').textContent = '';
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudieron actualizar tus tickets.');
    portalRevision = response.headers.get('ETag') || '';
    portalLastFullRefresh = Date.now();
    portalEntity = window.MesaHours.track(result.entity);
    portalTickets = result.tickets || [];
    renderPortalTickets();
    renderPortalHours();
    document.querySelector('#portalTicketsMessage').textContent = '';
  } catch (error) { document.querySelector('#portalTicketsMessage').textContent = error.message; }
  finally { portalLoading = false; button.disabled = false; }
}

document.querySelectorAll('[data-portal-tab]').forEach((button) => button.addEventListener('click', () => showPortalTab(button.dataset.portalTab)));
document.querySelector('#portalStatusFilter').addEventListener('change', renderPortalTickets);
document.querySelector('#portalRefreshButton').addEventListener('click', () => void refreshPortalTickets({ force: true }));
function refreshVisiblePortal() {
  if (!document.hidden && (activePortalTab === 'tickets' || activePortalTab === 'hours')) void refreshPortalTickets();
}
setInterval(refreshVisiblePortal, PORTAL_REFRESH_MS);
document.addEventListener('visibilitychange', refreshVisiblePortal);
window.addEventListener('online', refreshVisiblePortal);
setInterval(() => { if (portalEntity?.hours) window.MesaHours.tick([portalEntity]); }, 1000);

function showMessage(message, type = 'error') {
  formMessage.textContent = message;
  formMessage.className = `public-form-message is-visible ${type}`;
}

function fileSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toLocaleString('es-MX', { maximumFractionDigits: 1 })} MB`;
}

function renderAttachments() {
  attachmentCount.textContent = `${selectedAttachments.length} / ${MAX_ATTACHMENTS}`;
  attachmentList.innerHTML = selectedAttachments.map((file, index) => `
    <li class="attachment-row">
      <svg class="attachment-file-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8l-5-5ZM14 3v6h5M8 13h8M8 17h6" /></svg>
      <span class="attachment-file-copy"><strong>${escapeHtml(file.name)}</strong><small>${fileSize(file.size)}</small></span>
      <button class="attachment-remove" type="button" data-remove-attachment="${index}" aria-label="Quitar ${escapeHtml(file.name)}" ${isSubmitting ? 'disabled' : ''}>Quitar</button>
    </li>
  `).join('');
}

function addAttachments(files) {
  if (isSubmitting) return;
  const errors = [];
  for (const file of Array.from(files)) {
    if (selectedAttachments.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue;
    if (BLOCKED_ATTACHMENT_EXTENSIONS.has(file.name.split('.').pop().toLowerCase())) {
      errors.push(`“${file.name}” es un ejecutable y no se puede adjuntar.`);
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`“${file.name}” supera los 10 MB.`);
    } else if (selectedAttachments.length >= MAX_ATTACHMENTS) {
      errors.push('Puedes adjuntar hasta 8 archivos. Quita alguno para agregar otro.');
      break;
    } else {
      selectedAttachments.push(file);
    }
  }
  attachmentMessage.textContent = errors.join(' ');
  renderAttachments();
}

attachmentInput?.addEventListener('change', () => {
  addAttachments(attachmentInput.files);
  attachmentInput.value = '';
});
attachmentList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-attachment]');
  if (!button || isSubmitting) return;
  selectedAttachments.splice(Number(button.dataset.removeAttachment), 1);
  attachmentMessage.textContent = '';
  renderAttachments();
  attachmentInput.focus();
});
['dragenter', 'dragover'].forEach((type) => uploadArea?.addEventListener(type, (event) => {
  event.preventDefault();
  if (!isSubmitting) uploadArea.classList.add('is-dragging');
}));
uploadArea?.addEventListener('dragleave', (event) => {
  if (!uploadArea.contains(event.relatedTarget)) uploadArea.classList.remove('is-dragging');
});
uploadArea?.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadArea.classList.remove('is-dragging');
  addAttachments(event.dataTransfer.files);
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isSubmitting) return;
  const data = new FormData(form);
  const payload = {
    title: String(data.get('title') || '').trim(),
    description: String(data.get('description') || '').trim(),
    area: String(data.get('area') || '').trim(),
    subarea: String(data.get('subarea') || '').trim(),
    type: String(data.get('type') || '').trim(),
    priority: String(data.get('priority') || 'Media').trim(),
    module: String(data.get('module') || '').trim(),
    requester: String(data.get('requester') || '').trim(),
    requester_email: String(data.get('requester_email') || '').trim(),
    environment: 'Cliente',
    acceptance: String(data.get('acceptance') || '').trim(),
    status: 'new', source: 'public'
  };

  const requestData = new FormData();
  Object.entries(payload).forEach(([key, value]) => requestData.append(key, value));
  selectedAttachments.forEach((file) => requestData.append('attachments', file, file.name));
  isSubmitting = true;
  attachmentInput.disabled = true;
  uploadArea.classList.add('is-disabled');
  renderAttachments();
  submitButton.disabled = true;
  submitButton.setAttribute('aria-busy', 'true');
  showMessage('Enviando solicitud…', 'loading');
  try {
    const response = await fetch(entityToken ? `/api/portal/${encodeURIComponent(entityToken)}/tickets` : '/api/public/tickets', {
      method: 'POST', body: requestData
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'No se pudo enviar la solicitud.');
    form.reset();
    selectedAttachments = [];
    attachmentMessage.textContent = '';
    renderAttachments();
    renderSubareas('');
    successCode.textContent = result.id;
    const savedAttachments = Array.isArray(result.attachments) ? result.attachments.length : 0;
    const successAttachments = document.querySelector('#publicSuccessAttachments');
    successAttachments.textContent = savedAttachments === 1 ? 'Se guardó 1 archivo con tu solicitud.' : `Se guardaron ${savedAttachments} archivos con tu solicitud.`;
    successAttachments.classList.toggle('is-hidden', savedAttachments === 0);
    successPanel.classList.add('is-visible');
    form.classList.add('is-hidden');
    formMessage.className = 'public-form-message';
    if (portalEntity) void refreshPortalTickets();
  } catch (error) {
    console.error(error);
    showMessage(error.message || 'No se pudo enviar todavía. Inténtalo de nuevo.', 'error');
  } finally {
    isSubmitting = false;
    attachmentInput.disabled = false;
    uploadArea.classList.remove('is-disabled');
    renderAttachments();
    submitButton.disabled = false;
    submitButton.removeAttribute('aria-busy');
  }
});

document.querySelector('#sendAnotherButton')?.addEventListener('click', () => {
  successPanel.classList.remove('is-visible');
  form.classList.remove('is-hidden');
  document.querySelector('#titleInput')?.focus();
});
areaSelect?.addEventListener('change', () => renderSubareas(areaSelect.value));
void loadFormConfig();
