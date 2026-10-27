const PROFILES_KEY = 'mesa-pendientes-profiles-v1';
const LEGACY_PROFILES_KEY = 'julio-ticket-profiles-v1';
const ACTIVE_PROFILE_KEY = 'mesa-pendientes-active-profile-v1';
const LEGACY_ACTIVE_PROFILE_KEY = 'julio-active-profile-v1';
const PROFILE_NAME_SETUP_KEY = 'mesa-pendientes-profile-name-set-v1';

const COLOR_OPTIONS = [
  { name: 'Coral', value: '#f06a3c', hot: '#ff8051', ink: '#9c361b' },
  { name: 'Turquesa', value: '#38b6a4', hot: '#58d2be', ink: '#167568' },
  { name: 'Violeta', value: '#9887f4', hot: '#b0a2ff', ink: '#6652be' },
  { name: 'Azul', value: '#4d9de0', hot: '#6fb6ed', ink: '#2d679c' },
  { name: 'Mostaza', value: '#e7b84b', hot: '#f2ca65', ink: '#987414' },
  { name: 'Rosa', value: '#e8749b', hot: '#f08eae', ink: '#a13f61' },
  { name: 'Lima', value: '#a9cf78', hot: '#c1e294', ink: '#5d7e32' }
];

const DEFAULT_CATEGORIES = ['General', 'Proyectos', 'Clientes', 'Administración', 'Desarrollo', 'Operación', 'Documentación', 'Personal'];
const statusLabels = { new: 'Nuevo', review: 'En revisión', qa: 'Listo para avanzar', blocked: 'Bloqueado', done: 'Cerrado' };
const FORM_CONFIG_KEY = 'mesa-pendientes-form-config-v1';
const LEGACY_FORM_CONFIG_KEY = 'julio-form-config-v1';
const DEFAULT_FORM_CONFIG = window.MESA_FORM_DEFAULTS || { areas: [{ name: 'General', subareas: ['Consulta', 'Soporte', 'Seguimiento'] }], types: ['Solicitud', 'Bug', 'Mejora'], priorities: ['Media', 'Alta', 'Baja'], theme: { mode: 'workspace', accent: '#f06a3c', hot: '#ff8051', ink: '#9c361b', initials: 'M', workspaceName: 'Mi mesa' } };

let profiles = loadProfiles();
let activeProfileId = localStorage.getItem(ACTIVE_PROFILE_KEY) || localStorage.getItem(LEGACY_ACTIVE_PROFILE_KEY) || profiles[0]?.id || null;
let currentProfile = profiles.find((profile) => profile.id === activeProfileId) || null;
let tickets = [];
let entities = [];
let activeEntity = 'all';
const entityHourRequests = new Set();
let formConfig = loadFormConfig();
let selectedId = tickets[0]?.id || null;
let activeFilter = 'all';
let activeView = 'home';
let searchTerm = '';
let isNewTicket = false;
let deskPendingAttachments = [];
let isUploadingAttachments = false;
const MAX_DESK_ATTACHMENTS = 8;
const MAX_DESK_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const BLOCKED_DESK_EXTENSIONS = new Set(['app', 'bat', 'cmd', 'com', 'dll', 'dmg', 'exe', 'jar', 'msi', 'ps1', 'scr', 'sh']);
const INLINE_VIEWABLE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt']);
let onboardingColor = COLOR_OPTIONS[0].value;
let profileDraft = null;
let profileSetupId = null;

let formConfigDraft = null;
let formConfigEntityId = '';
const entityFormDrafts = new Map();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId() {
  return window.crypto?.randomUUID?.() || `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function profileInitials(name) {
  const initials = String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('');
  return (initials || 'JT').toUpperCase().slice(0, 3);
}

function normalizeCategories(categories) {
  return [...new Set((Array.isArray(categories) ? categories : []).map((category) => String(category).trim()).filter(Boolean))].slice(0, 24);
}

function normalizeFormConfig(config) {
  return window.normalizeMesaFormConfig ? window.normalizeMesaFormConfig(config) : clone(DEFAULT_FORM_CONFIG);
}

function loadFormConfig() {
  try {
    const saved = localStorage.getItem(FORM_CONFIG_KEY) || localStorage.getItem(LEGACY_FORM_CONFIG_KEY);
    return normalizeFormConfig(JSON.parse(saved));
  } catch (error) {
    return normalizeFormConfig(DEFAULT_FORM_CONFIG);
  }
}

function persistFormConfig() {
  localStorage.setItem(FORM_CONFIG_KEY, JSON.stringify(formConfig));
}

function normalizeProfile(profile) {
  if (!profile || !profile.id || !profile.name) return null;
  const color = COLOR_OPTIONS.some((option) => option.value === profile.color) ? profile.color : COLOR_OPTIONS[0].value;
  const categories = normalizeCategories(profile.categories);
  return {
    id: String(profile.id),
    name: String(profile.name).trim().slice(0, 40),
    initials: String(profile.initials || profileInitials(profile.name)).replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 3) || profileInitials(profile.name),
    color,
    categories: categories.length ? categories : clone(DEFAULT_CATEGORIES),
    createdAt: profile.createdAt || new Date().toISOString()
  };
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY) || localStorage.getItem(LEGACY_PROFILES_KEY);
    const saved = JSON.parse(raw);
    return Array.isArray(saved) ? saved.map(normalizeProfile).filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function persistProfiles() {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

function persist() {
  // Los tickets se guardan únicamente en el servidor, en DATA_DIR.
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showAdminAccess();
    const error = new Error(body.error || 'No se pudo completar la solicitud.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function formatTicketTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `el ${date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }).replace('.', '')} a las ${date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;
}

function mapTicket(row) {
  return {
    id: row.id,
    title: row.title || '', description: row.description || '', area: row.area || '', subarea: row.subarea || '',
    type: row.type || '', priority: row.priority || '', module: row.module || '', requester: row.requester || '',
    requester_email: row.requester_email || '', environment: row.environment || 'Cliente', acceptance: row.acceptance || '',
    status: row.status || 'new', source: row.source || 'public', updated: formatTicketTime(row.updatedAt || row.updated),
    createdAt: row.createdAt || '', entityId: row.entityId || '', attachments: Array.isArray(row.attachments) ? row.attachments : []
  };
}

async function refreshTickets({ quiet = false } = {}) {
  try {
    tickets = (await apiRequest('/api/tickets')).map(mapTicket);
    const first = visibleTickets()[0];
    selectedId = first?.id || null;
    if (first) { isNewTicket = false; fillForm(first); }
    else { isNewTicket = true; clearForm(); $('#editorTitle').textContent = 'Recibir ticket'; }
    renderList();
    setView(activeView);
    updateSyncStatus();
    if (!quiet) showToast('Cola actualizada.');
    return true;
  } catch (error) {
    console.error(error);
    if (!quiet) showToast('No se pudo actualizar la cola.');
    return false;
  }
}

function scopedTickets() {
  if (activeEntity === 'all') return tickets;
  return tickets.filter((ticket) => activeEntity === 'none' ? !ticket.entityId : ticket.entityId === activeEntity);
}

function entityName(id) {
  return entities.find((entity) => entity.id === id)?.name || 'Sin entidad';
}

function entityLink(entity) {
  const url = new URL('solicitar.html', window.location.href);
  url.searchParams.set('entidad', entity.token);
  return url.href;
}

function renderEntityOptions() {
  const selected = $('#entityInput').value;
  const options = entities.map((entity) => `<option value="${escapeHtml(entity.id)}">${escapeHtml(entity.name)}</option>`).join('');
  $('#entityInput').innerHTML = `<option value="">Sin entidad</option>${options}`;
  $('#entityInput').value = selected;
  $('#workspaceEntityFilter').innerHTML = `<option value="all">Todas las entidades</option><option value="none">Sin entidad</option>${options}`;
  $('#workspaceEntityFilter').value = activeEntity;
}

function renderEntities() {
  const openHistories = new Set($$('.work-history[open]').map((node) => node.dataset.workHistory));
  $('#entityList').innerHTML = entities.length ? entities.map((entity) => {
    const own = tickets.filter((ticket) => ticket.entityId === entity.id);
    const open = own.filter((ticket) => ticket.status !== 'done').length;
    const url = entityLink(entity);
    const running = Boolean(entity.hours?.activeSessionId);
    const busy = entityHourRequests.has(entity.id);
    return `<article class="entity-row" data-entity-row="${escapeHtml(entity.id)}">
      <div class="entity-row-heading"><div><h2>${escapeHtml(entity.name)}</h2><p>${own.length} ticket${own.length === 1 ? '' : 's'} · ${open} abierto${open === 1 ? '' : 's'}</p></div><button class="button" type="button" data-entity-config="${escapeHtml(entity.id)}">Configurar formulario</button><button class="button entity-view-button" type="button" data-entity-view="${escapeHtml(entity.id)}">Ver tickets</button></div>
      <section class="entity-work" aria-label="Horas de ${escapeHtml(entity.name)}">
        <div class="entity-work-heading"><h3>Horas trabajadas</h3><button class="button ${running ? 'work-stop-button' : 'button-primary'}" type="button" data-entity-timer="${escapeHtml(entity.id)}" aria-label="${running ? 'Terminar' : 'Iniciar'} contador de ${escapeHtml(entity.name)}" ${busy ? 'disabled' : ''}>${running ? 'Terminar' : 'Iniciar'}</button></div>
        <button class="button" type="button" data-entity-hours-reset="${escapeHtml(entity.id)}" ${busy || running || !entity.hours?.sessions?.length ? 'disabled' : ''} title="Borra todos los registros de horas de esta entidad. Detén primero el contador.">Restablecer horas</button>
        <label class="work-visibility"><input type="checkbox" data-entity-hours-toggle="${escapeHtml(entity.id)}" ${entity.showHours ? 'checked' : ''} ${busy ? 'disabled' : ''} /><span>Mostrar horas en el portal de esta entidad</span></label>
        <p class="work-visibility-hint">Ocultar el resumen no detiene el contador ni borra sus registros.</p>
        ${window.MesaHours.render(entity, openHistories.has(entity.id))}
      </section>
      <label class="entity-share-label">Enlace privado<input readonly value="${escapeHtml(url)}" aria-label="Enlace de ${escapeHtml(entity.name)}" /></label>
      <div class="entity-share-actions"><button class="button entity-copy-button" type="button" data-entity-copy="${escapeHtml(entity.id)}">Copiar enlace</button><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Abrir portal <span aria-hidden="true">↗</span></a></div>
    </article>`;
  }).join('') : '<div class="entities-empty"><h2>Registra tu primera entidad</h2><p>Cada cliente o equipo tendrá su formulario y sus tickets en un mismo enlace.</p></div>';
}

async function refreshEntityHours() {
  if (entityHourRequests.size || $('#adminAccessGate').getAttribute('aria-hidden') !== 'true') return;
  try {
    entities = (await apiRequest('/api/entities')).map(window.MesaHours.track);
    renderEntityOptions();
    renderEntities();
  } catch (error) { showToast(error.message); }
}

async function mutateEntityHours(id, action, visible) {
  if (entityHourRequests.has(id)) return;
  const entity = entities.find((item) => item.id === id);
  if (!entity) return;
  const visibility = action === 'visibility';
  const control = visibility ? 'data-entity-hours-toggle' : action === 'reset' ? 'data-entity-hours-reset' : 'data-entity-timer';
  entityHourRequests.add(id);
  const row = document.querySelector(`[data-entity-row="${id}"]`);
  row?.querySelectorAll('button, input[type="checkbox"]').forEach((node) => { node.disabled = true; });
  try {
    const url = `/api/entities/${encodeURIComponent(id)}${visibility ? '' : `/time/${action}`}`;
    const updated = await apiRequest(url, {
      method: visibility ? 'PATCH' : 'POST',
      body: JSON.stringify(visibility ? { showHours: visible } : { sessionId: entity.hours?.activeSessionId, lastSessionId: entity.hours?.sessions?.at(-1)?.id || null })
    });
    entities = entities.map((item) => item.id === id ? window.MesaHours.track(updated) : item);
    showToast(visibility ? (visible ? 'Las horas ya son visibles en su portal.' : 'Las horas se ocultaron de su portal.') : action === 'reset' ? `Horas restablecidas: ${entity.name}.` : action === 'start' ? `Contador iniciado: ${entity.name}.` : `Registro terminado: ${entity.name}.`);
  } catch (error) {
    showToast(error.message);
    try { entities = (await apiRequest('/api/entities')).map(window.MesaHours.track); } catch { /* Keep the last known state while offline. */ }
  } finally {
    entityHourRequests.delete(id);
    renderEntities();
    document.querySelector(`[${control}="${id}"]`)?.focus();
  }
}

function changeEntityScope(value) {
  activeEntity = value;
  $('#workspaceEntityFilter').value = value;
  activeFilter = 'all';
  searchTerm = '';
  $('#searchInput').value = '';
  renderFilterChips();
  $$('[data-filter]').forEach((button) => {
    const selected = button.dataset.filter === 'all';
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  const first = visibleTickets()[0];
  if (first) selectTicket(first.id);
  else { selectedId = null; isNewTicket = true; clearForm(); $('#editorTitle').textContent = 'Recibir ticket'; renderList(); }
  setView(activeView);
}

function showAdminAccess() {
  $('#authGate').setAttribute('aria-hidden', 'true');
  $('#adminAccessGate').setAttribute('aria-hidden', 'false');
  $('.app-shell').inert = true;
  $('#adminKeyInput').focus();
}

async function bootAdminWorkspace() {
  try {
    const session = await apiRequest('/api/admin/session');
    if (!session.authenticated) { showAdminAccess(); return; }
    entities = (await apiRequest('/api/entities')).map(window.MesaHours.track);
    renderEntityOptions();
    $('#adminAccessGate').setAttribute('aria-hidden', 'true');
    $('.app-shell').inert = false;
    await bootApp();
  } catch (error) {
    showAdminAccess();
    $('#adminAccessError').textContent = error.message || 'No se pudo conectar con el servidor.';
  }
}

async function refreshFormConfig({ quiet = false } = {}) {
  try {
    const data = await apiRequest('/api/form-config');
    if (data?.config) {
      formConfig = normalizeFormConfig(data.config);
      persistFormConfig();
      renderFormOptions();
    }
    return true;
  } catch (error) {
    console.error(error);
    if (!quiet) showToast('No se pudo actualizar la configuración del formulario.');
    return false;
  }
}

async function saveServerFormConfig() {
  await apiRequest('/api/form-config', { method: 'PUT', body: JSON.stringify({ config: formConfig }) });
  return true;
}

function getWorkspaceTheme() {
  const color = colorOption(currentProfile?.color);
  return {
    mode: 'workspace',
    accent: color.value,
    hot: color.hot,
    ink: color.ink,
    initials: currentProfile?.initials || 'J',
    workspaceName: currentProfile?.name || 'Mi mesa'
  };
}

function syncFormThemeFromWorkspace({ saveToServer = true } = {}) {
  if (!currentProfile || formConfig.theme?.mode === 'custom') return;
  formConfig.theme = getWorkspaceTheme();
  persistFormConfig();
  if (saveToServer) void saveServerFormConfig().catch((error) => console.error('No se pudo guardar la apariencia del formulario.', error));
}

async function createServerTicket(ticket) {
  const created = await apiRequest('/api/tickets', { method: 'POST', body: JSON.stringify(ticket) });
  return mapTicket(created);
}

async function updateServerTicket(ticket) {
  const updated = await apiRequest(`/api/tickets/${encodeURIComponent(ticket.id)}`, { method: 'PATCH', body: JSON.stringify(ticket) });
  return mapTicket(updated);
}

async function updateServerTicketStatus(ticket) {
  const updated = await apiRequest(`/api/tickets/${encodeURIComponent(ticket.id)}`, { method: 'PATCH', body: JSON.stringify({ status: ticket.status }) });
  return mapTicket(updated);
}

function priorityClass(priority) {
  return priority === 'Alta' ? 'high' : priority === 'Media' ? 'medium' : 'low';
}

function visibleTickets() {
  const categoryFilter = activeFilter.startsWith('category:') ? activeFilter.slice(9) : null;
  return scopedTickets().filter((ticket) => {
    const matchesSearch = !searchTerm || [ticket.title, ticket.area, ticket.subarea, ticket.module, ticket.id].join(' ').toLowerCase().includes(searchTerm.toLowerCase());
    const isClosed = ticket.status === 'done';
    const matchesFilter = (activeFilter === 'all' && !isClosed)
      || (activeFilter === 'high' && !isClosed && ticket.priority === 'Alta')
      || (activeFilter === 'active' && ['review', 'qa'].includes(ticket.status))
      || ((activeFilter === 'history' || activeFilter === 'done') && isClosed)
      || (['new', 'review', 'qa', 'blocked'].includes(activeFilter) && ticket.status === activeFilter)
      || (Boolean(categoryFilter) && !isClosed && ticket.area === categoryFilter);
    return matchesSearch && matchesFilter;
  });
}

function renderList() {
  const list = $('#ticketList');
  const items = visibleTickets();
  $('#visibleCount').textContent = items.length;
  $('#emptyState').classList.toggle('is-hidden', items.length > 0);
  const openCount = scopedTickets().filter((ticket) => ticket.status !== 'done').length;
  const isEmptyDesk = activeFilter === 'all' && !searchTerm && openCount === 0;
  $('#queueEmptyTitle').textContent = isEmptyDesk ? 'Aún no hay pendientes' : activeFilter === 'done' && !searchTerm ? 'No hay tickets cerrados' : 'Sin coincidencias';
  $('#queueEmptyCopy').textContent = isEmptyDesk ? 'Crea un ticket o comparte el formulario para recibir solicitudes.' : activeFilter === 'done' && !searchTerm ? 'Los tickets que cierres aparecerán aquí y en Historial.' : 'Prueba otra búsqueda o cambia el filtro seleccionado.';
  $('#queueEmptyAction').textContent = isEmptyDesk ? 'Crear un ticket' : 'Ver pendientes';
  list.innerHTML = items.map((ticket) => `
    <button class="ticket-item ${ticket.id === selectedId ? 'is-selected' : ''}" type="button" data-id="${escapeHtml(ticket.id)}" aria-pressed="${ticket.id === selectedId}" aria-label="Abrir ${escapeHtml(ticket.title)}">
      <span class="ticket-frame" aria-hidden="true"></span>
      <span>
        <h3>${escapeHtml(ticket.title)}</h3>
        <span class="ticket-meta"><span>${escapeHtml(entityName(ticket.entityId))}</span><span>${escapeHtml(ticket.area)}</span>${ticket.subarea ? `<span>${escapeHtml(ticket.subarea)}</span>` : ''}<span>${escapeHtml(statusLabels[ticket.status] || 'Sin estado')}</span></span>
      </span>
      <span class="ticket-side"><span class="ticket-code">${escapeHtml(ticket.id)}</span><span class="priority-mark ${priorityClass(ticket.priority)}" title="Prioridad ${escapeHtml(ticket.priority)}"></span></span>
    </button>
  `).join('');
  $$('.ticket-item').forEach((item) => item.addEventListener('click', () => selectTicket(item.dataset.id)));
  updateCounts();
  updateScrollHint();
}

function renderHome() {
  if (!currentProfile) return;
  const scoped = scopedTickets();
  const openScoped = scoped.filter((ticket) => ticket.status !== 'done');
  $('#homeName').textContent = currentProfile.name;
  $('#homeTotal').textContent = openScoped.length;
  $('#homeActive').textContent = scoped.filter((ticket) => ['review', 'qa'].includes(ticket.status)).length;
  $('#homeDone').textContent = scoped.filter((ticket) => ticket.status === 'done').length;

  const recent = scoped.slice(0, 4);
  $('#homeRecentList').innerHTML = recent.length ? recent.map((ticket) => `
    <button class="home-recent-item" type="button" data-ticket-id="${escapeHtml(ticket.id)}">
      <span class="home-recent-dot" aria-hidden="true"></span>
      <span><strong>${escapeHtml(ticket.title)}</strong><small>${escapeHtml(ticket.area)} · ${escapeHtml(statusLabels[ticket.status] || 'Sin estado')}</small></span>
      <span class="home-recent-id">${escapeHtml(ticket.id)}</span>
    </button>
  `).join('') : `
    <div class="home-recent-empty">
      <span><strong>Aún no hay movimientos.</strong><span>Tu primer ticket puede empezar aquí.</span></span>
      <button class="button button-quiet" type="button" data-view="receiving">Crear el primero</button>
    </div>
  `;
  $('#homeRecentList').querySelectorAll('[data-ticket-id]').forEach((item) => item.addEventListener('click', () => openTicket(item.dataset.ticketId)));

  const categoryCounts = currentProfile.categories.map((category) => ({ category, count: scoped.filter((ticket) => ticket.area === category).length }));
  $('#homeCategoryList').innerHTML = categoryCounts.map(({ category, count }) => `<span class="home-category-chip">${escapeHtml(category)}<strong>${count}</strong></span>`).join('');
}

function renderSecondaryList(view) {
  const isHistory = view === 'history';
  const items = scopedTickets().filter((ticket) => isHistory ? ticket.status === 'done' : ['review', 'qa'].includes(ticket.status));
  const list = $(`#${isHistory ? 'historyTicketList' : 'activeTicketList'}`);
  const empty = $(`#${isHistory ? 'historyEmpty' : 'activeEmpty'}`);
  const total = $(`#${isHistory ? 'historyViewTotal' : 'activeViewTotal'}`);
  total.textContent = items.length;
  list.innerHTML = items.map((ticket) => `
    <div class="secondary-ticket-row">
      <button class="secondary-ticket" type="button" data-ticket-id="${escapeHtml(ticket.id)}">
        <span class="secondary-ticket-dot" aria-hidden="true"></span>
        <span><strong>${escapeHtml(ticket.title)}</strong><small>${escapeHtml(entityName(ticket.entityId))} · ${escapeHtml(ticket.area)} · ${escapeHtml(statusLabels[ticket.status] || 'Sin estado')}</small></span>
        <span class="secondary-ticket-code">${escapeHtml(ticket.id)}</span>
      </button>
      <div class="secondary-ticket-actions">
        ${!isHistory && ticket.status === 'review' ? `<button class="text-button secondary-step-button" type="button" data-quick-status="qa" data-ticket-id="${escapeHtml(ticket.id)}">Listo para avanzar<span class="sr-only"> ${escapeHtml(ticket.title)}</span> <svg class="icon-svg inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-6 6 6-6 6" /></svg></button>` : ''}
        <button class="button ${isHistory ? 'button-quiet secondary-reopen-button' : 'status-close-button'}" type="button" data-quick-status="${isHistory ? 'review' : 'done'}" data-ticket-id="${escapeHtml(ticket.id)}">
          ${isHistory ? 'Reabrir ticket' : '<svg class="icon-svg inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4L19 6" /></svg> Cerrar ticket'}<span class="sr-only"> ${escapeHtml(ticket.title)}</span>
        </button>
        <button class="button button-danger-quiet secondary-delete-button" type="button" data-delete-ticket="${escapeHtml(ticket.id)}"><span data-delete-label>Eliminar</span><span class="sr-only"> ${escapeHtml(ticket.title)}</span></button>
      </div>
    </div>
  `).join('');
  empty.classList.toggle('is-hidden', items.length > 0);
  list.classList.toggle('is-hidden', items.length === 0);
  list.querySelectorAll('.secondary-ticket[data-ticket-id]').forEach((item) => item.addEventListener('click', () => openTicket(item.dataset.ticketId)));
  list.querySelectorAll('[data-quick-status]').forEach((button) => button.addEventListener('click', () => changeTicketStatus(button.dataset.ticketId, button.dataset.quickStatus, button)));
  list.querySelectorAll('[data-delete-ticket]').forEach((button) => button.addEventListener('click', () => handleDeleteTicketClick(button.dataset.deleteTicket, button)));
}

function openTicket(id) {
  const ticket = tickets.find((item) => item.id === id);
  const targetFilter = ticket?.status === 'done' ? 'done' : (activeFilter === 'done' ? 'all' : activeFilter);
  if (targetFilter !== activeFilter) {
    activeFilter = targetFilter;
    $$('[data-filter]').forEach((button) => {
      const selected = button.dataset.filter === activeFilter;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }
  setView('receiving');
  selectTicket(id);
}

function setView(view) {
  if (!currentProfile) return;
  activeView = view;
  $$('.app-view').forEach((section) => section.classList.toggle('is-hidden', section.id !== `${view}View`));
  $$('[data-view]').forEach((button) => {
    const selected = button.dataset.view === view;
    if (button.classList.contains('topnav-link')) {
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  });
  if (view === 'home') renderHome();
  if (view === 'active' || view === 'history') renderSecondaryList(view);
  if (view === 'receiving') renderList();
  if (view === 'entities') { renderEntities(); void refreshEntityHours(); }
  $('.workspace-entity-filter').classList.toggle('is-hidden', view === 'entities');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateCounts() {
  const scoped = scopedTickets();
  const openTickets = scoped.filter((ticket) => ticket.status !== 'done');
  $('#railTotal').textContent = openTickets.length;
  $('#allCount').textContent = `${openTickets.length} ticket${openTickets.length === 1 ? '' : 's'}`;
  ['new', 'review', 'qa', 'blocked', 'done'].forEach((status) => {
    const count = scoped.filter((ticket) => ticket.status === status).length;
    const node = $(`#${status}Count`);
    if (node) node.textContent = `${count} ticket${count === 1 ? '' : 's'}`;
  });
  const activeCount = scoped.filter((ticket) => ['review', 'qa'].includes(ticket.status)).length;
  $('#activeCount').textContent = activeCount;
  renderHome();
  renderEntities();
}

function updateScrollHint() {
  const list = $('#ticketList');
  const hint = $('#scrollHint');
  if (!list || !hint) return;
  const isNarrow = window.matchMedia('(max-width: 930px)').matches;
  hint.classList.toggle('is-hidden', !isNarrow || list.scrollHeight <= list.clientHeight + 4);
}

function selectTicket(id) {
  selectedId = id;
  isNewTicket = false;
  const ticket = tickets.find((item) => item.id === id);
  if (ticket) fillForm(ticket);
  renderList();
  $('#editorTitle').textContent = 'Editar ticket';
}

function resetDeleteButtonState(button, defaultText = 'Eliminar ticket') {
  if (!button) return;
  clearTimeout(button._confirmTimeout);
  delete button.dataset.confirmDelete;
  button.classList.remove('is-confirming');
  const label = button.querySelector('[data-delete-label]');
  if (label) label.textContent = defaultText;
  else button.textContent = defaultText;
}

async function handleDeleteTicketClick(ticketId, button) {
  if (!ticketId || !button) return;
  const isRowButton = Boolean(button.querySelector('[data-delete-label]'));
  const defaultText = isRowButton ? 'Eliminar' : 'Eliminar ticket';
  if (button.dataset.confirmDelete !== 'true') {
    button.dataset.confirmDelete = 'true';
    button.classList.add('is-confirming');
    const label = button.querySelector('[data-delete-label]');
    if (label) label.textContent = 'Confirmar eliminar';
    else button.textContent = 'Confirmar eliminar';
    clearTimeout(button._confirmTimeout);
    button._confirmTimeout = setTimeout(() => resetDeleteButtonState(button, defaultText), 4000);
    return;
  }
  clearTimeout(button._confirmTimeout);
  button.disabled = true;
  try {
    await apiRequest(`/api/tickets/${encodeURIComponent(ticketId)}`, { method: 'DELETE' });
    tickets = tickets.filter((item) => item.id !== ticketId);
    if (selectedId === ticketId) {
      const nextVisible = visibleTickets()[0];
      if (nextVisible) {
        selectTicket(nextVisible.id);
      } else {
        selectedId = null;
        isNewTicket = true;
        clearForm();
        $('#editorTitle').textContent = 'Recibir ticket';
      }
    }
    renderList();
    if (activeView === 'active' || activeView === 'history') renderSecondaryList(activeView);
    showToast('Ticket eliminado.');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'No se pudo eliminar el ticket.');
    button.disabled = false;
    resetDeleteButtonState(button, defaultText);
  }
}

function fillForm(ticket) {
  const deleteBtn = $('#deleteTicketButton');
  if (deleteBtn) {
    deleteBtn.classList.remove('is-hidden');
    deleteBtn.disabled = false;
    resetDeleteButtonState(deleteBtn, 'Eliminar ticket');
  }
  $('#editorId').textContent = ticket.id;
  $('#saveLabel').textContent = ticket.updated ? `Guardado ${ticket.updated}` : 'Sin guardar';
  $('#titleInput').value = ticket.title || '';
  $('#descriptionInput').value = ticket.description || '';
  $('#entityInput').value = ticket.entityId || '';
  renderFormOptions(ticket);
  $('#areaInput').value = ticket.area || '';
  renderSubareaOptions(ticket.area || '', ticket.subarea || '');
  if (ticket.subarea && !Array.from($('#subareaInput').options).some((option) => option.value === ticket.subarea)) {
    $('#subareaInput').add(new Option(ticket.subarea, ticket.subarea));
    $('#subareaInput').value = ticket.subarea;
    $('#subareaField').classList.remove('is-hidden');
  }
  $('#typeInput').value = ticket.type || '';
  $('#priorityInput').value = ticket.priority || '';
  $('#moduleInput').value = ticket.module || '';
  $('#requesterInput').value = ticket.requester || '';
  $('#environmentInput').value = ticket.environment || 'Local';
  $('#acceptanceInput').value = ticket.acceptance || '';
  renderTicketAttachments(ticket);
  updateStatus(ticket.status);
  updateReadiness();
}

function clearForm() {
  deskPendingAttachments = [];
  if ($('#deskAttachmentMessage')) $('#deskAttachmentMessage').textContent = '';
  const deleteBtn = $('#deleteTicketButton');
  if (deleteBtn) {
    deleteBtn.classList.add('is-hidden');
    resetDeleteButtonState(deleteBtn, 'Eliminar ticket');
  }
  $('#editorId').textContent = 'NUEVO';
  $('#saveLabel').textContent = 'Borrador sin guardar';
  $('#ticketForm').reset();
  renderSubareaOptions('', '');
  $('#environmentInput').value = 'Local';
  $('#entityInput').value = entities.some((entity) => entity.id === activeEntity) ? activeEntity : '';
  renderFormOptions();
  renderTicketAttachments(null);
  updateStatus('new');
  updateReadiness();
}

function formatAttachmentSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toLocaleString('es-MX', { maximumFractionDigits: 1 })} MB`;
}

function canPreviewInline(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return INLINE_VIEWABLE_EXTENSIONS.has(ext);
}

function renderDeskAttachmentRows(ticketId, files) {
  return `<ul class="ticket-attachment-list">${files.map((file) => {
    const size = formatAttachmentSize(file.size);
    const url = `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(file.id)}`;
    const previewable = canPreviewInline(file.name);
    return `<li class="attachment-row">
      <svg class="attachment-file-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8l-5-5ZM14 3v6h5M8 13h8M8 17h6" /></svg>
      <span class="attachment-file-copy"><strong>${escapeHtml(file.name)}</strong><small>${size}</small></span>
      <span class="attachment-actions">
        ${previewable ? `<a class="attachment-action-link" href="${escapeHtml(`${url}?inline=1`)}" target="_blank" rel="noreferrer">Ver<span class="sr-only"> ${escapeHtml(file.name)}</span></a>` : ''}
        <a class="attachment-action-link" href="${escapeHtml(url)}" download="${escapeHtml(file.name)}">Descargar<span class="sr-only"> ${escapeHtml(file.name)}</span></a>
        <button class="attachment-remove" type="button" data-delete-attachment="${escapeHtml(file.id)}" aria-label="Quitar ${escapeHtml(file.name)}" ${isUploadingAttachments ? 'disabled' : ''}>Quitar</button>
      </span>
    </li>`;
  }).join('')}</ul>`;
}

function renderTicketAttachments(ticket) {
  const savedAttachments = Array.isArray(ticket?.attachments) ? ticket.attachments : [];
  const totalCount = isNewTicket ? deskPendingAttachments.length : savedAttachments.length;
  $('#ticketAttachmentCount').textContent = `${totalCount} / ${MAX_DESK_ATTACHMENTS}`;
  $('#deskUploadArea')?.classList.toggle('is-disabled', isUploadingAttachments);
  if ($('#deskAttachmentInput')) $('#deskAttachmentInput').disabled = isUploadingAttachments;

  if (isNewTicket) {
    $('#ticketAttachmentList').innerHTML = deskPendingAttachments.length ? `
      <div class="attachment-group is-returned-group">
        <h4>Entregables de la mesa (${deskPendingAttachments.length})</h4>
        <ul class="ticket-attachment-list">${deskPendingAttachments.map((file, index) => `
          <li class="attachment-row">
            <svg class="attachment-file-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8l-5-5ZM14 3v6h5M8 13h8M8 17h6" /></svg>
            <span class="attachment-file-copy"><strong>${escapeHtml(file.name)}</strong><small>${formatAttachmentSize(file.size)} · Se subirá al guardar</small></span>
            <button class="attachment-remove" type="button" data-remove-pending-attachment="${index}" aria-label="Quitar ${escapeHtml(file.name)}" ${isUploadingAttachments ? 'disabled' : ''}>Quitar</button>
          </li>
        `).join('')}</ul>
      </div>
    ` : '';
    return;
  }

  const requestFiles = savedAttachments.filter((file) => file.source !== 'desk');
  const deskFiles = savedAttachments.filter((file) => file.source === 'desk');
  $('#ticketAttachmentList').innerHTML = [
    requestFiles.length ? `<div class="attachment-group"><h4>Adjuntados en la solicitud (${requestFiles.length})</h4>${renderDeskAttachmentRows(ticket.id, requestFiles)}</div>` : '',
    deskFiles.length ? `<div class="attachment-group is-returned-group ${requestFiles.length ? 'has-previous-group' : ''}"><h4>Entregables enviados por la mesa (${deskFiles.length})</h4>${renderDeskAttachmentRows(ticket.id, deskFiles)}</div>` : ''
  ].join('');
}

async function uploadTicketFiles(ticketId, files) {
  const formData = new FormData();
  files.forEach((file) => formData.append('attachments', file));
  const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/attachments`, {
    method: 'POST',
    credentials: 'same-origin',
    body: formData
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showAdminAccess();
    if (response.status === 413) throw new Error('El envío supera el límite del servidor. Reduce el tamaño total de los archivos a menos de 4 MB e inténtalo de nuevo.');
    throw new Error(body.error || 'No se pudieron subir los archivos.');
  }
  return mapTicket(body);
}

async function handleDeskFiles(fileList) {
  if (isUploadingAttachments) return;
  const messageNode = $('#deskAttachmentMessage');
  if (messageNode) messageNode.textContent = '';
  const currentTicket = !isNewTicket ? tickets.find((item) => item.id === selectedId) : null;
  const existingCount = isNewTicket ? deskPendingAttachments.length : (currentTicket?.attachments?.length || 0);
  const errors = [];
  const validFiles = [];

  for (const file of Array.from(fileList || [])) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (BLOCKED_DESK_EXTENSIONS.has(ext)) {
      errors.push(`“${file.name}” es un ejecutable y no se puede adjuntar.`);
    } else if (file.size > MAX_DESK_ATTACHMENT_BYTES) {
      errors.push(`“${file.name}” supera los 10 MB.`);
    } else if (existingCount + validFiles.length >= MAX_DESK_ATTACHMENTS) {
      errors.push(`Puedes adjuntar hasta ${MAX_DESK_ATTACHMENTS} archivos por ticket.`);
      break;
    } else {
      validFiles.push(file);
    }
  }

  if (errors.length && messageNode) messageNode.textContent = errors.join(' ');
  if (!validFiles.length) return;

  if (isNewTicket || !currentTicket) {
    deskPendingAttachments.push(...validFiles);
    renderTicketAttachments(null);
    return;
  }

  isUploadingAttachments = true;
  renderTicketAttachments(currentTicket);
  try {
    const updated = await uploadTicketFiles(currentTicket.id, validFiles);
    Object.assign(currentTicket, updated);
    if (selectedId === currentTicket.id) {
      $('#saveLabel').textContent = currentTicket.updated ? `Guardado ${currentTicket.updated}` : 'Guardado ahora';
    }
    showToast(validFiles.length === 1 ? 'Evidencia adjuntada al ticket.' : 'Evidencias adjuntadas al ticket.');
  } catch (error) {
    if (messageNode) messageNode.textContent = error.message;
    showToast(error.message || 'No se pudo adjuntar el archivo.');
  } finally {
    isUploadingAttachments = false;
    renderTicketAttachments(currentTicket);
  }
}

async function deleteDeskAttachment(attachmentId) {
  if (isUploadingAttachments || isNewTicket || !selectedId) return;
  const currentTicket = tickets.find((item) => item.id === selectedId);
  if (!currentTicket) return;
  isUploadingAttachments = true;
  renderTicketAttachments(currentTicket);
  try {
    const updated = mapTicket(await apiRequest(`/api/tickets/${encodeURIComponent(currentTicket.id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }));
    Object.assign(currentTicket, updated);
    showToast('Archivo eliminado del ticket.');
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar el archivo.');
  } finally {
    isUploadingAttachments = false;
    renderTicketAttachments(currentTicket);
  }
}

function updateStatus(status) {
  const label = statusLabels[status] || statusLabels.new;
  $('#statusLabel').textContent = label;
  $('#statusHelp').textContent = status === 'qa'
    ? 'La ficha está lista para avanzar o cerrarse'
    : status === 'blocked'
      ? 'Falta una respuesta para continuar'
      : status === 'done'
        ? 'Este ticket está cerrado y en el historial'
        : status === 'new'
          ? 'Recién recibida'
          : 'Falta confirmar un criterio';
  const pip = $('#statusPip');
  if (pip) {
    pip.classList.toggle('is-done', status === 'done');
    pip.classList.toggle('is-blocked', status === 'blocked');
  }
  const blockButton = $('#blockStatusButton');
  const advanceButton = $('#advanceStatusButton');
  const closeButton = $('#closeStatusButton');
  if (blockButton) {
    blockButton.classList.toggle('is-hidden', status === 'done');
    blockButton.textContent = status === 'blocked' ? 'Devolver a revisión' : 'Bloquear';
    blockButton.dataset.nextStatus = status === 'blocked' ? 'review' : 'blocked';
  }
  if (advanceButton) {
    const isBack = status === 'qa' || status === 'done';
    $('#advanceStatusText').textContent = status === 'qa' ? 'Devolver a revisión' : status === 'done' ? 'Reabrir ticket' : 'Marcar listo para avanzar';
    advanceButton.querySelector('.inline-icon').innerHTML = isBack ? '<path d="M19 12H6m5 6-6-6 6-6" />' : '<path d="M5 12h13m-5-6 6 6-6 6" />';
    advanceButton.dataset.nextStatus = isBack ? 'review' : 'qa';
  }
  if (closeButton) {
    closeButton.classList.toggle('is-hidden', status === 'done');
    closeButton.classList.toggle('is-primary-step', status === 'qa');
    closeButton.dataset.nextStatus = 'done';
  }
}

function updateReadiness() {
  const values = ['#titleInput', '#descriptionInput', '#areaInput', '#typeInput', '#priorityInput', '#acceptanceInput'].map((selector) => $(selector).value.trim());
  const completed = values.filter(Boolean).length;
  const percent = Math.round((completed / values.length) * 100);
  $('#readinessValue').textContent = `${percent}%`;
  $('#readinessTitle').textContent = percent === 100 ? 'Ficha lista para circular' : 'Ficha incompleta';
  $('#readinessCopy').textContent = percent === 100 ? 'Puedes guardarla y enviarla a la cola.' : `Completa ${values.length - completed} campo${values.length - completed === 1 ? '' : 's'} marcado${values.length - completed === 1 ? '' : 's'}.`;
  const ring = $('.readiness-ring');
  ring.style.borderRightColor = percent === 100 ? 'var(--good)' : 'var(--orange)';
  ring.style.borderTopColor = percent > 24 ? 'var(--orange)' : 'var(--paper-deep)';
}

function getFormData() {
  return {
    title: $('#titleInput').value.trim(), description: $('#descriptionInput').value.trim(), area: $('#areaInput').value, subarea: $('#subareaInput').value, type: $('#typeInput').value, priority: $('#priorityInput').value,
    module: $('#moduleInput').value.trim(), requester: $('#requesterInput').value.trim(), environment: $('#environmentInput').value, acceptance: $('#acceptanceInput').value.trim(), entityId: $('#entityInput').value
  };
}

async function saveTicket(event) {
  event.preventDefault();
  const data = getFormData();
  if (!data.title || !data.description || !data.area || !data.type || !data.priority || !data.acceptance) {
    showFormError('Faltan datos obligatorios. Completa asunto, descripción, categoría, tipo, prioridad y criterios de aceptación.');
    showToast('Completa los campos obligatorios antes de guardar.');
    $('#ticketForm').querySelector(':invalid')?.focus();
    return;
  }
  hideFormError();
  const saveButton = $('#saveTicketButton');
  saveButton.disabled = true;
  saveButton.setAttribute('aria-busy', 'true');
  const now = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  try {
    if (isNewTicket) {
      const nextNumber = Math.max(...tickets.map((ticket) => Number(String(ticket.id).replace(/\D/g, ''))), 0) + 1;
      let ticket = { id: `PEN-${String(nextNumber).padStart(4, '0')}`, ...data, status: 'new', updated: `a las ${now}`, source: 'desk' };
      ticket = await createServerTicket(ticket);
      if (deskPendingAttachments.length) {
        ticket = await uploadTicketFiles(ticket.id, deskPendingAttachments);
        deskPendingAttachments = [];
      }
      tickets = [ticket, ...tickets.filter((item) => item.id !== ticket.id)];
      selectedId = ticket.id;
      isNewTicket = false;
    } else {
      const index = tickets.findIndex((ticket) => ticket.id === selectedId);
      if (index !== -1) {
        let ticket = { ...tickets[index], ...data, updated: `a las ${now}` };
        ticket = await updateServerTicket(ticket);
        tickets[index] = ticket;
      }
    }
    if (activeEntity !== 'all' && (data.entityId || 'none') !== activeEntity) {
      activeEntity = data.entityId || 'none';
      $('#workspaceEntityFilter').value = activeEntity;
    }
    persist();
    renderList();
    selectTicket(selectedId);
    showToast('Ticket guardado en la mesa.');
  } catch (error) {
    console.error(error);
    showFormError(error.message || 'No se pudo guardar el ticket. Revisa que el servidor siga activo e inténtalo de nuevo.');
    showToast('No se pudo guardar el ticket.');
  } finally {
    saveButton.disabled = false;
    saveButton.removeAttribute('aria-busy');
  }
}

const statusToastMessages = {
  qa: 'Ticket marcado como listo para avanzar.',
  review: 'Ticket devuelto a revisión.',
  blocked: 'Ticket marcado como bloqueado.',
  done: 'Ticket cerrado y enviado al historial.'
};

async function changeTicketStatus(ticketId, nextStatus, triggerButton = null) {
  if (!ticketId || (isNewTicket && ticketId === selectedId)) {
    showToast('Guarda el ticket antes de enviarlo a la cola.');
    return;
  }
  const ticket = tickets.find((item) => item.id === ticketId);
  if (!ticket || !nextStatus) return;
  const previousStatus = ticket.status;
  const controls = triggerButton
    ? [triggerButton]
    : [$('#blockStatusButton'), $('#advanceStatusButton'), $('#closeStatusButton')].filter(Boolean);
  controls.forEach((node) => { node.disabled = true; });
  try {
    const updated = await updateServerTicketStatus({ id: ticket.id, status: nextStatus });
    Object.assign(ticket, updated);
    persist();
    const stillVisible = visibleTickets().some((item) => item.id === selectedId);
    if (!stillVisible) {
      const nextVisible = visibleTickets()[0];
      if (nextVisible) {
        selectTicket(nextVisible.id);
      } else {
        selectedId = null;
        isNewTicket = true;
        clearForm();
        $('#editorTitle').textContent = 'Recibir ticket';
        renderList();
      }
    } else {
      if (ticket.id === selectedId) {
        updateStatus(ticket.status);
        $('#saveLabel').textContent = ticket.updated ? `Guardado ${ticket.updated}` : 'Guardado ahora';
      }
      renderList();
    }
    if (activeView === 'active' || activeView === 'history') renderSecondaryList(activeView);
    const reopened = previousStatus === 'done' && ticket.status === 'review';
    showToast(reopened ? 'Ticket reabierto.' : (statusToastMessages[ticket.status] || 'Estado actualizado.'));
  } catch (error) {
    console.error(error);
    showToast('No se pudo actualizar el estado.');
  } finally {
    controls.forEach((node) => { node.disabled = false; });
  }
}

async function advanceStatus(event) {
  if (isNewTicket) {
    showToast('Guarda el ticket antes de enviarlo a la cola.');
    return;
  }
  const button = event?.currentTarget || $('#advanceStatusButton');
  await changeTicketStatus(selectedId, button?.dataset.nextStatus);
}

function smartStructure() {
  const text = `${$('#titleInput').value} ${$('#descriptionInput').value}`.toLowerCase();
  if (!text.trim()) {
    showFormError('Escribe un asunto o una descripción antes de estructurar la solicitud.');
    showToast('Escribe primero un asunto o una descripción.');
    $('#titleInput').focus();
    return;
  }
  const category = (name) => formConfig.areas.some((area) => area.name === name) ? name : formConfig.areas[0]?.name || '';
  const areaRules = [
    { terms: ['cliente', 'usuario'], area: 'Clientes' },
    { terms: ['administr', 'gestión', 'documento', 'reporte'], area: 'Administración' },
    { terms: ['operación', 'proceso', 'coordinación'], area: 'Operación' },
    { terms: ['desarrollo', 'mejora', 'corrección'], area: 'Desarrollo' },
    { terms: ['proyecto', 'planificación', 'entrega'], area: 'Proyectos' }
  ];
  const matchedRule = areaRules.find((rule) => rule.terms.some((term) => text.includes(term)));
  const area = category(matchedRule?.area || 'General');
  const type = text.includes('bug') || text.includes('no ') || text.includes('error') || text.includes('falla') ? 'Bug' : 'Solicitud';
  $('#areaInput').value = area;
  $('#typeInput').value = type;
  if (!$('#priorityInput').value) $('#priorityInput').value = text.includes('no ') || text.includes('error') || text.includes('urg') ? 'Alta' : 'Media';
  if (!$('#acceptanceInput').value) $('#acceptanceInput').value = `El comportamiento solicitado funciona en ${area || 'la categoría elegida'}.\nLa prueba no genera errores ni afecta el flujo existente.`;
  updateReadiness();
  showToast('Solicitud estructurada: revisa y ajusta antes de guardar.');
}

function applyFilter(filter) {
  setView('receiving');
  activeFilter = filter;
  const visible = visibleTickets();
  if (!visible.some((item) => item.id === selectedId)) {
    const firstVisible = visible[0];
    if (firstVisible) {
      selectedId = firstVisible.id;
      isNewTicket = false;
      fillForm(firstVisible);
      $('#editorTitle').textContent = 'Editar ticket';
    } else {
      selectedId = null;
      isNewTicket = true;
      clearForm();
      $('#editorTitle').textContent = 'Recibir ticket';
    }
  }
  $$('[data-filter]').forEach((button) => {
    const selected = button.dataset.filter === filter;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  const areaFilter = $('#queueAreaFilter');
  if (areaFilter) areaFilter.value = filter.startsWith('category:') ? filter : 'all';
  renderList();
}

function editorFormConfig() {
  return entities.find((entity) => entity.id === $('#entityInput')?.value)?.formConfig || formConfig;
}

function findFormArea(areaName) {
  return editorFormConfig().areas.find((area) => area.name === areaName);
}

function renderSubareaOptions(areaName = $('#areaInput')?.value, selectedValue = $('#subareaInput')?.value) {
  const field = $('#subareaField');
  const select = $('#subareaInput');
  if (!field || !select) return;
  const area = findFormArea(areaName);
  const subareas = area?.subareas || [];
  field.classList.toggle('is-hidden', subareas.length === 0);
  select.innerHTML = `<option value="">Seleccionar detalle</option>${subareas.map((subarea) => `<option value="${escapeHtml(subarea)}">${escapeHtml(subarea)}</option>`).join('')}`;
  select.value = subareas.includes(selectedValue) ? selectedValue : '';
}

function renderFormOptions(ticket = null) {
  const config = editorFormConfig();
  const areaSelect = $('#areaInput');
  const typeSelect = $('#typeInput');
  const prioritySelect = $('#priorityInput');
  if (!areaSelect || !typeSelect || !prioritySelect) return;
  const selectedArea = ticket?.area || areaSelect.value;
  const selectedType = ticket?.type || typeSelect.value;
  const selectedPriority = ticket?.priority || prioritySelect.value;
  areaSelect.innerHTML = `<option value="">Seleccionar área</option>${config.areas.map((area) => `<option value="${escapeHtml(area.name)}">${escapeHtml(area.name)}</option>`).join('')}`;
  typeSelect.innerHTML = `<option value="">Seleccionar tipo</option>${config.types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}`;
  prioritySelect.innerHTML = `<option value="">Seleccionar prioridad</option>${config.priorities.map((priority) => `<option value="${escapeHtml(priority)}">${escapeHtml(priority)}</option>`).join('')}`;
  if (ticket || !isNewTicket) {
    [[areaSelect, selectedArea], [typeSelect, selectedType], [prioritySelect, selectedPriority]].forEach(([select, value]) => {
      if (value && !Array.from(select.options).some((option) => option.value === value)) select.add(new Option(value, value));
    });
  }
  areaSelect.value = Array.from(areaSelect.options).some((option) => option.value === selectedArea) ? selectedArea : '';
  typeSelect.value = Array.from(typeSelect.options).some((option) => option.value === selectedType) ? selectedType : '';
  prioritySelect.value = Array.from(prioritySelect.options).some((option) => option.value === selectedPriority) ? selectedPriority : '';
  renderSubareaOptions(areaSelect.value, $('#subareaInput')?.value || '');
}

function renderCategoryOptions() {
  renderFormOptions();
}

function renderFilterChips() {
  if (!currentProfile) return;
  const filters = [
    { label: 'Todos', value: 'all' },
    { label: 'Alta prioridad', value: 'high' }
  ];
  $('#categoryFilters').innerHTML = `<div class="queue-quick-filters">${filters.map((filter) => `<button class="filter-chip ${activeFilter === filter.value ? 'is-active' : ''}" type="button" data-filter="${escapeHtml(filter.value)}" aria-pressed="${activeFilter === filter.value}">${escapeHtml(filter.label)}</button>`).join('')}</div>
    <label class="queue-area-filter"><span>Área</span><select id="queueAreaFilter"><option value="all">Todas las áreas</option>${currentProfile.categories.map((category) => `<option value="${escapeHtml(`category:${category}`)}">${escapeHtml(category)}</option>`).join('')}</select></label>`;
  $('#queueAreaFilter').value = activeFilter.startsWith('category:') ? activeFilter : 'all';
  $('#queueAreaFilter').addEventListener('change', (event) => applyFilter(event.target.value));
}

const dashboardDateFormat = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dashboardTimeFormat = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function updateDashboardClock() {
  const now = new Date();
  $('#homeDate').textContent = dashboardDateFormat.format(now);
  $('#homeDate').dateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  $('#homeTime').textContent = dashboardTimeFormat.format(now);
  $('#homeTime').dateTime = now.toISOString();
  const seconds = now.getSeconds();
  const minutes = now.getMinutes() + seconds / 60;
  const hours = now.getHours() % 12 + minutes / 60;
  $('#analogHourHand').setAttribute('transform', `rotate(${hours * 30} 50 50)`);
  $('#analogMinuteHand').setAttribute('transform', `rotate(${minutes * 6} 50 50)`);
  $('#analogSecondHand').setAttribute('transform', `rotate(${seconds * 6} 50 50)`);
  window.MesaHours.tick(entities);
  $('#railDate').textContent = now.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '').toUpperCase();
}

function renderColorPicker(containerId, selectedColor, onSelect) {
  const container = $(`#${containerId}`);
  container.innerHTML = COLOR_OPTIONS.map((option) => `<button class="color-swatch ${option.value === selectedColor ? 'is-selected' : ''}" type="button" role="radio" aria-label="${option.name}" aria-checked="${option.value === selectedColor}" data-color="${option.value}" style="--swatch: ${option.value}"></button>`).join('');
  container.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => {
    onSelect(button.dataset.color);
    renderColorPicker(containerId, button.dataset.color, onSelect);
  }));
}

function colorOption(value) {
  return COLOR_OPTIONS.find((option) => option.value === value) || COLOR_OPTIONS[0];
}

function applyProfileTheme() {
  if (!currentProfile) return;
  const color = colorOption(currentProfile.color);
  document.documentElement.style.setProperty('--profile-color', color.value);
  document.documentElement.style.setProperty('--profile-hot', color.hot);
  document.documentElement.style.setProperty('--profile-ink', color.ink);
  document.documentElement.style.setProperty('--orange', color.value);
  document.documentElement.style.setProperty('--orange-hot', color.hot);
  document.documentElement.style.setProperty('--orange-ink', color.ink);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = color.value;
}

function updateSyncStatus() {
  const node = $('#syncStatus');
  if (!node) return;
  node.textContent = 'Guardado en este equipo';
}

function updateProfileSummary() {
  if (!currentProfile) return;
  $('#brandMark').textContent = currentProfile.initials[0] || 'M';
  $('#brandWorkspace').textContent = `${currentProfile.name} · mesa de pendientes`;
  $('#profileButton').textContent = currentProfile.initials;
  $('#profileButton').setAttribute('aria-label', `Abrir perfil de ${currentProfile.name}`);
  $('#railWorkspace').textContent = currentProfile.name.toUpperCase();
  $('#railDate').textContent = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '').toUpperCase();
  $('#railEnvironment').textContent = currentProfile.name;
  $('#authMark').textContent = currentProfile.initials;
  updateSyncStatus();
}

function initializeWorkspace() {
  applyProfileTheme();
  syncFormThemeFromWorkspace();
  updateProfileSummary();
  renderCategoryOptions();
  renderFilterChips();
  const first = visibleTickets()[0];
  if (first) {
    selectedId = first.id;
    isNewTicket = false;
    fillForm(first);
  } else {
    selectedId = null;
    isNewTicket = true;
    clearForm();
    $('#editorTitle').textContent = 'Recibir ticket';
  }
  renderList();
  setView('home');
}

function renderProfileList() {
  const list = $('#profileList');
  if (!profiles.length) {
    list.innerHTML = '<p class="auth-note">Todavía no hay perfiles en este navegador.</p>';
    return;
  }
  list.innerHTML = profiles.map((profile) => `<button class="profile-choice" type="button" data-profile-id="${escapeHtml(profile.id)}"><span class="profile-choice-avatar" style="background: ${profile.color}">${escapeHtml(profile.initials)}</span><span><strong>${escapeHtml(profile.name)}</strong><small>${profile.categories.length} categorías · mesa local</small></span></button>`).join('');
  list.querySelectorAll('[data-profile-id]').forEach((button) => button.addEventListener('click', () => loginProfile(button.dataset.profileId)));
}

function showProfilePicker() {
  $('#authTitle').textContent = 'Elige un perfil';
  $('#authCopy').textContent = 'Cada perfil puede personalizar su apariencia y sus categorías en esta mesa.';
  $('#profilePicker').classList.remove('is-hidden');
  $('#onboardingForm').classList.add('is-hidden');
  renderProfileList();
}

function showOnboarding(profileId = null) {
  const existingProfile = profiles.find((profile) => profile.id === profileId);
  profileSetupId = existingProfile?.id || null;
  $('#authTitle').textContent = existingProfile ? 'Personaliza tu espacio' : 'Ponle nombre a tu mesa';
  $('#authCopy').textContent = existingProfile
    ? 'Escribe el nombre que quieres mostrar en esta mesa.'
    : 'Escribe tu nombre o el de tu espacio para personalizar la mesa.';
  $('#profilePicker').classList.add('is-hidden');
  $('#onboardingForm').classList.remove('is-hidden');
  $('#onboardingName').value = '';
  $('#onboardingInitials').value = '';
  onboardingColor = existingProfile?.color || COLOR_OPTIONS[0].value;
  renderColorPicker('onboardingColors', onboardingColor, (color) => { onboardingColor = color; });
  setTimeout(() => $('#onboardingName').focus(), 0);
}

function showAuthGate() {
  $('#authGate').setAttribute('aria-hidden', 'false');
  if (profiles.length) showProfilePicker(); else showOnboarding();
}

function hideAuthGate() {
  $('#authGate').setAttribute('aria-hidden', 'true');
}

async function bootApp() {
  if (!profiles.length) {
    showAuthGate();
    return;
  }
  currentProfile = profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
  activeProfileId = currentProfile.id;
  localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId);

  if (!localStorage.getItem(PROFILE_NAME_SETUP_KEY)) {
    showAuthGate();
    showOnboarding(currentProfile.id);
    return;
  }

  await refreshFormConfig({ quiet: true });
  const loaded = await refreshTickets({ quiet: true });
  hideAuthGate();
  initializeWorkspace();
  if (!loaded) showToast('No se pudieron cargar los tickets. Pulsa actualizar para intentarlo de nuevo.');
}

async function createProfile(event) {
  event.preventDefault();
  const name = $('#onboardingName').value.trim();
  if (!name) return;
  const rawInitials = $('#onboardingInitials').value.trim().replace(/[^a-z0-9]/gi, '').toUpperCase();
  const existing = profiles.find((profile) => profile.id === profileSetupId);
  const profile = normalizeProfile(existing
    ? { ...existing, name, initials: rawInitials || profileInitials(name), color: onboardingColor }
    : { id: makeId(), name, initials: rawInitials || profileInitials(name), color: onboardingColor, categories: DEFAULT_CATEGORIES });
  profiles = existing
    ? profiles.map((item) => item.id === profile.id ? profile : item)
    : [...profiles, profile];
  profileSetupId = null;
  localStorage.setItem(PROFILE_NAME_SETUP_KEY, 'configured');
  persistProfiles();
  currentProfile = profile;
  activeProfileId = profile.id;
  localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId);
  await refreshFormConfig({ quiet: true });
  const loaded = await refreshTickets({ quiet: true });
  hideAuthGate();
  initializeWorkspace();
  if (!loaded) showToast('No se pudieron cargar los tickets. Pulsa actualizar para intentarlo de nuevo.');
}

function loginProfile(profileId) {
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) return;
  activeProfileId = profile.id;
  currentProfile = profile;
  localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId);
  tickets = tickets || [];
  selectedId = tickets[0]?.id || null;
  activeFilter = 'all';
  searchTerm = '';
  $('#searchInput').value = '';
  hideAuthGate();
  initializeWorkspace();
  showToast(`Bienvenido, ${currentProfile.name}.`);
}

function readFormConfigDraft() {
  if (!formConfigDraft) return;
  const rows = [...$('#formAreaList').querySelectorAll('[data-form-area-row]')];
  formConfigDraft.areas = rows.map((row) => ({
    name: row.querySelector('[data-form-area-name]').value.trim(),
    subareas: row.querySelector('[data-form-area-subareas]').value.split(',').map((item) => item.trim()).filter(Boolean)
  }));
  formConfigDraft.types = $('#formTypesInput').value.split(',').map((item) => item.trim()).filter(Boolean);
  formConfigDraft.priorities = $('#formPrioritiesInput').value.split(',').map((item) => item.trim()).filter(Boolean);
  const mode = $('#formThemeModeInput').value;
  const workspaceTheme = getWorkspaceTheme();
  formConfigDraft.theme = mode === 'workspace'
    ? workspaceTheme
    : {
      mode: 'custom',
      accent: $('#formThemeColorInput').value,
      hot: $('#formThemeColorInput').value,
      ink: '#' + $('#formThemeColorInput').value.slice(1).match(/../g).map((part) => Math.round(parseInt(part, 16) * 0.35).toString(16).padStart(2, '0')).join(''),
      initials: $('#formThemeInitialsInput').value.trim(),
      workspaceName: $('#formThemeWorkspaceNameInput').value.trim()
    };
}

function renderFormThemeFields() {
  const mode = $('#formThemeModeInput').value;
  const customFields = $('#formCustomThemeFields');
  if (!customFields) return;
  customFields.classList.toggle('is-hidden', mode !== 'custom');
  const disabled = mode !== 'custom';
  ['#formThemeColorInput', '#formThemeInitialsInput', '#formThemeWorkspaceNameInput'].forEach((selector) => {
    const input = $(selector);
    if (input) input.disabled = disabled;
  });
}

function renderFormAreaList() {
  const list = $('#formAreaList');
  if (!list || !formConfigDraft) return;
  $('#formAreaCount').textContent = formConfigDraft.areas.length;
  list.innerHTML = formConfigDraft.areas.map((area, index) => `
    <div class="form-config-area-row" data-form-area-row>
      <div class="form-config-area-fields">
        <label class="field"><span>Área</span><input type="text" data-form-area-name maxlength="40" /></label>
        <label class="field"><span>Detalles dependientes <small>(separados por coma)</small></span><input type="text" data-form-area-subareas placeholder="Ej. soporte, seguimiento, revisión" /></label>
      </div>
      <button class="icon-button form-config-remove" type="button" data-remove-form-area="${index}" aria-label="Eliminar área">×</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-form-area-row]').forEach((row, index) => {
    row.querySelector('[data-form-area-name]').value = formConfigDraft.areas[index].name;
    row.querySelector('[data-form-area-subareas]').value = formConfigDraft.areas[index].subareas.join(', ');
  });
  list.querySelectorAll('[data-remove-form-area]').forEach((button) => button.addEventListener('click', () => removeFormArea(button.dataset.removeFormArea)));
}

function loadEntityFormDraft() {
  formConfigDraft = clone(entityFormDrafts.get(formConfigEntityId) || entities.find((entity) => entity.id === formConfigEntityId)?.formConfig || formConfig);
  populateFormConfigFields();
}

function populateFormConfigFields() {
  $('#formConfigSaved').textContent = '';
  $('#formTypesInput').value = formConfigDraft.types.join(', ');
  $('#formPrioritiesInput').value = formConfigDraft.priorities.join(', ');
  $('#formThemeModeInput').value = formConfigDraft.theme.mode;
  $('#formThemeColorInput').value = formConfigDraft.theme.accent;
  $('#formThemeInitialsInput').value = formConfigDraft.theme.initials;
  $('#formThemeWorkspaceNameInput').value = formConfigDraft.theme.workspaceName;
  $('#formConfigError').classList.add('is-hidden');
  renderFormAreaList();
  renderFormThemeFields();
}

function openFormConfigModal(entityId) {
  if (!currentProfile) return;
  entityFormDrafts.clear();
  formConfigEntityId = typeof entityId === 'string' ? entityId : (entities.some((entity) => entity.id === activeEntity) ? activeEntity : entities[0]?.id || '');
  $('#formConfigEntityInput').innerHTML = `<option value="">Formulario general</option>${entities.map((entity) => `<option value="${escapeHtml(entity.id)}">${escapeHtml(entity.name)}</option>`).join('')}`;
  $('#formConfigEntityInput').value = formConfigEntityId;
  loadEntityFormDraft();
  $('#formConfigModal').classList.remove('is-hidden');
  $('#formConfigModal').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#newFormAreaInput').focus(), 0);
}

function closeFormConfigModal() {
  $('#formConfigModal').classList.add('is-hidden');
  $('#formConfigModal').setAttribute('aria-hidden', 'true');
  formConfigDraft = null;
}

function showFormConfigError(message) {
  const error = $('#formConfigError');
  error.textContent = message;
  error.classList.remove('is-hidden');
}

function addFormArea() {
  if (!formConfigDraft) return;
  readFormConfigDraft();
  const input = $('#newFormAreaInput');
  const name = input.value.trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (formConfigDraft.areas.some((area) => area.name.toLowerCase() === name.toLowerCase())) {
    showFormConfigError('Esa área ya existe.');
    return;
  }
  if (formConfigDraft.areas.length >= 40) {
    showFormConfigError('Puedes tener hasta 40 áreas.');
    return;
  }
  formConfigDraft.areas.push({ name, subareas: [] });
  input.value = '';
  $('#formConfigError').classList.add('is-hidden');
  renderFormAreaList();
  input.focus();
}

function removeFormArea(index) {
  if (!formConfigDraft) return;
  readFormConfigDraft();
  if (formConfigDraft.areas.length <= 1) {
    showFormConfigError('Conserva al menos un área.');
    return;
  }
  formConfigDraft.areas.splice(Number(index), 1);
  renderFormAreaList();
}

function resetFormConfig() {
  formConfigDraft = clone(DEFAULT_FORM_CONFIG);
  formConfigDraft.theme = getWorkspaceTheme();
  $('#formTypesInput').value = formConfigDraft.types.join(', ');
  $('#formPrioritiesInput').value = formConfigDraft.priorities.join(', ');
  $('#formThemeModeInput').value = formConfigDraft.theme.mode;
  $('#formThemeColorInput').value = formConfigDraft.theme.accent;
  $('#formThemeInitialsInput').value = formConfigDraft.theme.initials;
  $('#formThemeWorkspaceNameInput').value = formConfigDraft.theme.workspaceName;
  $('#formConfigError').classList.add('is-hidden');
  renderFormAreaList();
  renderFormThemeFields();
}

async function saveFormConfig(event) {
  event.preventDefault();
  if (!formConfigDraft) return;
  readFormConfigDraft();
  const normalized = normalizeFormConfig(formConfigDraft);
  if (!normalized.areas.length || !normalized.types.length || !normalized.priorities.length) {
    showFormConfigError('Necesitas al menos un área, un tipo y una prioridad.');
    return;
  }
  const saveButton = $('#formConfigForm button[type="submit"]');
  saveButton.disabled = true;
  $('#formConfigEntityInput').disabled = true;
  $('#formConfigError').classList.add('is-hidden');
  try {
    const targetId = formConfigEntityId;
    const url = targetId ? `/api/entities/${encodeURIComponent(targetId)}/form-config` : '/api/form-config';
    const result = await apiRequest(url, { method: 'PUT', body: JSON.stringify({ config: normalized }) });
    if (targetId) entities.find((entity) => entity.id === targetId).formConfig = result.config;
    else { formConfig = result.config; persistFormConfig(); }
    entityFormDrafts.set(targetId, clone(result.config));
    renderFormOptions();
    $('#formConfigSaved').textContent = 'Guardado. Puedes elegir otra entidad para configurar su formulario.';
    showToast('Formulario guardado. Puedes elegir otra entidad.');
  } catch (error) {
    console.error(error);
    showFormConfigError('No se pudo guardar la configuración. Revisa que el servidor siga activo e inténtalo de nuevo.');
  } finally {
    saveButton.disabled = false;
    $('#formConfigEntityInput').disabled = false;
  }
}

function openProfileModal() {
  if (!currentProfile) return;
  profileDraft = { ...clone(currentProfile), categories: clone(currentProfile.categories) };
  $('#profileNameInput').value = profileDraft.name;
  $('#profileInitialsInput').value = profileDraft.initials;
  renderColorPicker('profileColors', profileDraft.color, (color) => { profileDraft.color = color; });
  renderCategoryList();
  $('#profileError').classList.add('is-hidden');
  $('#profileModal').classList.remove('is-hidden');
  $('#profileModal').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#profileNameInput').focus(), 0);
}

function closeProfileModal() {
  $('#profileModal').classList.add('is-hidden');
  $('#profileModal').setAttribute('aria-hidden', 'true');
  profileDraft = null;
}

function renderCategoryList() {
  const list = $('#categoryList');
  const categories = profileDraft?.categories || [];
  $('#categoryCount').textContent = categories.length;
  list.innerHTML = categories.length ? categories.map((category) => `<span class="category-tag">${escapeHtml(category)}<button type="button" data-remove-category="${escapeHtml(category)}" aria-label="Eliminar ${escapeHtml(category)}">×</button></span>`).join('') : '<span class="category-empty">Agrega una categoría para empezar.</span>';
  list.querySelectorAll('[data-remove-category]').forEach((button) => button.addEventListener('click', () => removeCategory(button.dataset.removeCategory)));
}

function addCategory() {
  if (!profileDraft) return;
  const input = $('#categoryInput');
  const category = input.value.trim().replace(/\s+/g, ' ');
  if (!category) return;
  if (profileDraft.categories.some((item) => item.toLowerCase() === category.toLowerCase())) {
    showProfileError('Esa categoría ya existe en tu mesa.');
    return;
  }
  if (profileDraft.categories.length >= 24) {
    showProfileError('Puedes tener hasta 24 categorías por perfil.');
    return;
  }
  profileDraft.categories.push(category);
  input.value = '';
  hideProfileError();
  renderCategoryList();
  input.focus();
}

function removeCategory(category) {
  if (!profileDraft) return;
  if (profileDraft.categories.length <= 1) {
    showProfileError('Conserva al menos una categoría para poder clasificar tickets.');
    return;
  }
  profileDraft.categories = profileDraft.categories.filter((item) => item !== category);
  renderCategoryList();
}

function saveProfile(event) {
  event.preventDefault();
  if (!profileDraft) return;
  const name = $('#profileNameInput').value.trim();
  if (!name) {
    showProfileError('Escribe un nombre visible para tu perfil.');
    $('#profileNameInput').focus();
    return;
  }
  const initialsInput = $('#profileInitialsInput').value.trim().replace(/[^a-z0-9]/gi, '').toUpperCase();
  const initials = name !== profileDraft.name && initialsInput === profileDraft.initials
    ? profileInitials(name)
    : initialsInput || profileInitials(name);
  const updated = normalizeProfile({ ...profileDraft, name, initials });
  profiles = profiles.map((profile) => profile.id === updated.id ? updated : profile);
  currentProfile = updated;
  persistProfiles();
  applyProfileTheme();
  syncFormThemeFromWorkspace();
  updateProfileSummary();
  renderHome();
  renderCategoryOptions();
  renderFilterChips();
  closeProfileModal();
  showToast('Perfil y categorías actualizados.');
}

function logoutProfile() {
  closeProfileModal();
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
  currentProfile = null;
  activeProfileId = null;
  showAuthGate();
}

function showFormError(message) {
  const error = $('#formError');
  error.textContent = message;
  error.classList.remove('is-hidden');
}

function hideFormError() {
  $('#formError').classList.add('is-hidden');
}

function showProfileError(message) {
  const error = $('#profileError');
  error.textContent = message;
  error.classList.remove('is-hidden');
}

function hideProfileError() {
  $('#profileError').classList.add('is-hidden');
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove('is-visible'), 3300);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function openNewTicket() {
  setView('receiving');
  isNewTicket = true;
  selectedId = null;
  clearForm();
  renderList();
  $('#editorTitle').textContent = 'Recibir ticket';
  $('#titleInput').focus();
}

$('#ticketForm').addEventListener('submit', saveTicket);
$('#workspaceEntityFilter').addEventListener('change', (event) => changeEntityScope(event.target.value));
$('#entityForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#createEntityButton');
  button.disabled = true;
  $('#entityFormMessage').textContent = 'Registrando entidad…';
  try {
    const entity = await apiRequest('/api/entities', { method: 'POST', body: JSON.stringify({ name: $('#entityNameInput').value.trim() }) });
    entities.push(window.MesaHours.track(entity));
    renderEntityOptions();
    renderEntities();
    $('#entityForm').reset();
    $('#entityFormMessage').textContent = `Entidad registrada: ${entity.name}. Ya puedes copiar su enlace.`;
  } catch (error) { $('#entityFormMessage').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#entityList').addEventListener('click', async (event) => {
  const reset = event.target.closest('[data-entity-hours-reset]');
  if (reset) {
    const entity = entities.find((item) => item.id === reset.dataset.entityHoursReset);
    if (entity && window.confirm(`¿Restablecer las horas de ${entity.name}? Se borrará todo su historial de horas y el total quedará en cero. Esta acción no se puede deshacer.`)) {
      void mutateEntityHours(entity.id, 'reset');
    }
    return;
  }
  const timer = event.target.closest('[data-entity-timer]');
  if (timer) {
    const entity = entities.find((item) => item.id === timer.dataset.entityTimer);
    void mutateEntityHours(entity.id, entity.hours?.activeSessionId ? 'stop' : 'start');
    return;
  }
  const configure = event.target.closest('[data-entity-config]');
  if (configure) { openFormConfigModal(configure.dataset.entityConfig); return; }
  const view = event.target.closest('[data-entity-view]');
  if (view) { changeEntityScope(view.dataset.entityView); setView('receiving'); return; }
  const copy = event.target.closest('[data-entity-copy]');
  if (!copy) return;
  const entity = entities.find((item) => item.id === copy.dataset.entityCopy);
  try { await navigator.clipboard.writeText(entityLink(entity)); showToast(`Enlace de ${entity.name} copiado.`); }
  catch { const input = copy.closest('.entity-row').querySelector('input'); input.focus(); input.select(); showToast('Selecciona y copia el enlace privado.'); }
});
$('#entityList').addEventListener('change', (event) => {
  if (event.target.matches('[data-entity-hours-toggle]')) void mutateEntityHours(event.target.dataset.entityHoursToggle, 'visibility', event.target.checked);
});
$('#adminLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('#adminAccessError').textContent = '';
  try {
    await apiRequest('/api/admin/session', { method: 'POST', body: JSON.stringify({ key: $('#adminKeyInput').value.trim() }) });
    $('#adminLoginForm').reset();
    await bootAdminWorkspace();
  } catch (error) { $('#adminAccessError').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#lockAccessButton').addEventListener('click', async () => {
  try { await apiRequest('/api/admin/session', { method: 'DELETE' }); tickets = []; entities = []; clearForm(); showAdminAccess(); }
  catch (error) { showToast(error.message); }
});
$('#blockStatusButton')?.addEventListener('click', advanceStatus);
$('#advanceStatusButton').addEventListener('click', advanceStatus);
$('#closeStatusButton')?.addEventListener('click', advanceStatus);
$('#structureButton').addEventListener('click', smartStructure);
$('#newTicketButton').addEventListener('click', openNewTicket);
$('#homeNewTicketButton').addEventListener('click', openNewTicket);
$('#homeSettingsButton').addEventListener('click', openProfileModal);
$('#homeProfileButton').addEventListener('click', openProfileModal);
$('#formConfigButton').addEventListener('click', () => openFormConfigModal());
$('#entityInput').addEventListener('change', () => renderFormOptions());
$('#formConfigEntityInput').addEventListener('change', (event) => {
  readFormConfigDraft();
  entityFormDrafts.set(formConfigEntityId, clone(formConfigDraft));
  formConfigEntityId = event.target.value;
  loadEntityFormDraft();
});
$('#deleteTicketButton')?.addEventListener('click', (event) => {
  if (!isNewTicket && selectedId) void handleDeleteTicketClick(selectedId, event.currentTarget);
});
$('#discardButton').addEventListener('click', () => { if (isNewTicket) { const first = visibleTickets()[0]; if (first) selectTicket(first.id); else clearForm(); } else selectTicket(selectedId); showToast('Cambios descartados.'); });
$('#deskAttachmentInput')?.addEventListener('change', () => {
  void handleDeskFiles($('#deskAttachmentInput').files);
  $('#deskAttachmentInput').value = '';
});
$('#ticketAttachmentList')?.addEventListener('click', (event) => {
  const pendingRemove = event.target.closest('[data-remove-pending-attachment]');
  if (pendingRemove) {
    deskPendingAttachments.splice(Number(pendingRemove.dataset.removePendingAttachment), 1);
    renderTicketAttachments(null);
    return;
  }
  const deleteButton = event.target.closest('[data-delete-attachment]');
  if (deleteButton) {
    void deleteDeskAttachment(deleteButton.dataset.deleteAttachment);
  }
});
['dragenter', 'dragover'].forEach((type) => $('#deskUploadArea')?.addEventListener(type, (event) => {
  event.preventDefault();
  if (!isUploadingAttachments) $('#deskUploadArea').classList.add('is-dragging');
}));
$('#deskUploadArea')?.addEventListener('dragleave', (event) => {
  if (!$('#deskUploadArea').contains(event.relatedTarget)) $('#deskUploadArea').classList.remove('is-dragging');
});
$('#deskUploadArea')?.addEventListener('drop', (event) => {
  event.preventDefault();
  $('#deskUploadArea').classList.remove('is-dragging');
  void handleDeskFiles(event.dataTransfer.files);
});
$('#searchInput').addEventListener('input', (event) => { searchTerm = event.target.value; renderList(); });
$('#refreshButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await refreshTickets(); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
});
$('#queueEmptyAction').addEventListener('click', () => {
  const openCount = scopedTickets().filter((ticket) => ticket.status !== 'done').length;
  if (activeFilter === 'all' && !searchTerm && openCount === 0) { openNewTicket(); return; }
  searchTerm = '';
  $('#searchInput').value = '';
  applyFilter('all');
});
$('#profileButton').addEventListener('click', openProfileModal);
$('#homeLink').addEventListener('click', (event) => { event.preventDefault(); setView('home'); });
$('#createProfileButton').addEventListener('click', showOnboarding);
$('#backToProfilesButton').addEventListener('click', showProfilePicker);
$('#onboardingForm').addEventListener('submit', createProfile);
$('#profileForm').addEventListener('submit', saveProfile);
$('#addCategoryButton').addEventListener('click', addCategory);
$('#categoryInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addCategory(); } });
$('#closeProfileButton').addEventListener('click', closeProfileModal);
$('#logoutButton').addEventListener('click', logoutProfile);
$('#closeFormConfigButton').addEventListener('click', closeFormConfigModal);
$('#formConfigForm').addEventListener('submit', saveFormConfig);
$('#addFormAreaButton').addEventListener('click', addFormArea);
$('#newFormAreaInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addFormArea(); } });
$('#resetFormConfigButton').addEventListener('click', resetFormConfig);
$('#formThemeModeInput').addEventListener('change', renderFormThemeFields);
$('#areaInput').addEventListener('change', () => renderSubareaOptions($('#areaInput').value, ''));
document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) setView(viewButton.dataset.view);
  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) applyFilter(filterButton.dataset.filter);
  if (event.target.matches('[data-close-profile]')) closeProfileModal();
  if (event.target.matches('[data-close-form-config]')) closeFormConfigModal();
});
$$('#ticketForm input, #ticketForm textarea, #ticketForm select').forEach((input) => input.addEventListener('input', () => { updateReadiness(); hideFormError(); }));
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { event.preventDefault(); $('#searchInput').focus(); }
  if (event.key === 'Escape') { closeProfileModal(); closeFormConfigModal(); }
});
window.addEventListener('resize', updateScrollHint);

const authMark = document.querySelector('.auth-mark');
if (authMark) authMark.id = 'authMark';

updateDashboardClock();
setInterval(updateDashboardClock, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateDashboardClock(); if (activeView === 'entities') void refreshEntityHours(); } });
void bootAdminWorkspace();
