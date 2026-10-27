const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { MESA_FORM_DEFAULTS, normalizeMesaFormConfig } = require('./form-config');

const ENV_FILE = path.join(__dirname, '.env');
if (typeof process.loadEnvFile === 'function' && fsSync.existsSync(ENV_FILE)) {
  try { process.loadEnvFile(ENV_FILE); } catch {}
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = path.join(__dirname, 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const FORM_CONFIG_FILE = path.join(DATA_DIR, 'form-config.json');
const ENTITIES_FILE = path.join(DATA_DIR, 'entities.json');
const ADMIN_KEY_FILE = path.join(DATA_DIR, 'admin-key.json');
let adminKey = '';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const INCOMING_DIR = path.join(UPLOADS_DIR, '.incoming');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_BUCKET = String(process.env.SUPABASE_BUCKET || 'mesa-uploads').trim();
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);
const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const TICKET_STATUSES = new Set(['new', 'review', 'qa', 'blocked', 'done']);
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set(['.app', '.bat', '.cmd', '.com', '.dll', '.dmg', '.exe', '.jar', '.msi', '.ps1', '.scr', '.sh']);
const INLINE_ATTACHMENT_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.txt', 'text/plain; charset=utf-8']
]);
let writeQueue = Promise.resolve();

const uploadAttachments = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fs.mkdir(INCOMING_DIR, { recursive: true, mode: 0o700 }).then(() => callback(null, INCOMING_DIR), callback);
    },
    filename(_req, _file, callback) {
      callback(null, crypto.randomUUID());
    }
  }),
  limits: { files: MAX_ATTACHMENT_COUNT, fileSize: MAX_ATTACHMENT_SIZE, fields: 30, parts: MAX_ATTACHMENT_COUNT + 30 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_ATTACHMENT_EXTENSIONS.has(extension)) {
      const error = new Error('Ese tipo de archivo ejecutable no se puede adjuntar.');
      error.status = 400;
      callback(error);
      return;
    }
    callback(null, true);
  }
});

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra
  };
}

function kvKeyForFile(file) {
  return path.basename(file, '.json');
}

async function readLocalJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeLocalJson(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

async function readJson(file, fallback) {
  if (!USE_SUPABASE) return readLocalJson(file, fallback);
  const key = kvKeyForFile(file);
  const url = `${SUPABASE_URL}/rest/v1/mesa_kv?key=eq.${encodeURIComponent(key)}&select=value`;
  const response = await fetch(url, { headers: supabaseHeaders({ Accept: 'application/json' }) });
  if (!response.ok) {
    throw new Error(`Error al leer ${key} desde Supabase (${response.status}).`);
  }
  const rows = await response.json();
  if (Array.isArray(rows) && rows.length > 0 && rows[0].value !== undefined) {
    return rows[0].value;
  }
  const localSeed = await readLocalJson(file, undefined);
  if (localSeed !== undefined) {
    await writeJson(file, localSeed);
    return localSeed;
  }
  return fallback;
}

function queueWrite(operation) {
  const next = writeQueue.then(operation);
  writeQueue = next.catch(() => {});
  return next;
}

async function writeJson(file, data) {
  if (!USE_SUPABASE) return writeLocalJson(file, data);
  await writeLocalJson(file, data).catch(() => {});
  const key = kvKeyForFile(file);
  const url = `${SUPABASE_URL}/rest/v1/mesa_kv?on_conflict=key`;
  const response = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify([{ key, value: data, updated_at: new Date().toISOString() }])
  });
  if (!response.ok) {
    throw new Error(`Error al guardar ${key} en Supabase (${response.status}).`);
  }
}

async function storeUploadedFile(file) {
  const destination = path.join(UPLOADS_DIR, file.filename);
  await fs.mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  await fs.rename(file.path, destination);
  await fs.chmod(destination, 0o600);
  if (USE_SUPABASE) {
    const buffer = await fs.readFile(destination);
    const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(file.filename)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: supabaseHeaders({
        'Content-Type': file.mimetype || 'application/octet-stream',
        'x-upsert': 'true'
      }),
      body: buffer
    });
    if (!response.ok) {
      await fs.rm(destination, { force: true }).catch(() => {});
      throw new Error(`No se pudo guardar el archivo adjunto en Supabase Storage (${response.status}).`);
    }
  }
  return destination;
}

async function removeStoredFile(fileId) {
  if (!fileId || !/^[0-9a-f-]{36}$/i.test(fileId)) return;
  await fs.rm(path.join(UPLOADS_DIR, fileId), { force: true }).catch(() => {});
  if (USE_SUPABASE) {
    const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(fileId)}`;
    await fetch(url, { method: 'DELETE', headers: supabaseHeaders() }).catch(() => {});
  }
}

async function getTickets() {
  const tickets = await readJson(TICKETS_FILE, []);
  if (!Array.isArray(tickets)) throw new Error('El archivo tickets.json debe contener una lista.');
  return tickets;
}

async function getFormConfig() {
  const config = await readJson(FORM_CONFIG_FILE, MESA_FORM_DEFAULTS);
  return normalizeMesaFormConfig(config);
}

function text(value, maxLength = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function adminSessionToken() {
  return crypto.createHmac('sha256', adminKey).update('mesa-admin-session-v1').digest('hex');
}

function isAdmin(req) {
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('mesa_admin='));
  return equalSecret(cookie?.slice('mesa_admin='.length), adminSessionToken());
}

function setAdminCookie(req, res, enabled = true) {
  res.cookie('mesa_admin', enabled ? adminSessionToken() : '', {
    httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: enabled ? 30 * 24 * 60 * 60 * 1000 : 0
  });
}

function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!isAdmin(req)) return res.status(401).json({ error: 'Accede a la mesa con tu clave de administración.' });
  next();
}

async function getEntities() {
  const entities = await readJson(ENTITIES_FILE, []);
  if (!Array.isArray(entities)) throw new Error('El archivo entities.json debe contener una lista.');
  return entities;
}

function entityHours(entity) {
  const now = Date.now();
  const sessions = (entity.timeEntries || []).map((entry) => ({
    id: entry.id, startedAt: entry.startedAt, endedAt: entry.endedAt || null,
    durationMs: Math.max(0, (entry.endedAt ? Date.parse(entry.endedAt) : now) - Date.parse(entry.startedAt))
  }));
  return {
    serverNow: new Date(now).toISOString(), sessions,
    totalMs: sessions.reduce((total, entry) => total + entry.durationMs, 0),
    activeSessionId: sessions.find((entry) => !entry.endedAt)?.id || null
  };
}

function adminEntity(entity) {
  const { timeEntries, ...metadata } = entity;
  return { ...metadata, showHours: entity.showHours === true, hours: entityHours(entity) };
}

async function findPortalEntity(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const entity = (await getEntities()).find((item) => equalSecret(item.token, req.params.token));
    if (!entity) return res.status(404).json({ error: 'Este enlace de entidad no está disponible. Solicita uno nuevo a quien administra la mesa.' });
    req.portalEntity = entity;
    next();
  } catch (error) { next(error); }
}

async function validateEntityId(entityId) {
  if (entityId && !(await getEntities()).some((entity) => entity.id === entityId)) {
    const error = new Error('La entidad seleccionada no existe.');
    error.status = 400;
    throw error;
  }
}

function attachmentName(value) {
  const name = String(value || 'archivo')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  return name || 'archivo';
}

function uploadedAttachmentName(value) {
  // Multipart filename parameters may arrive decoded as Latin-1 by Busboy.
  let name = String(value || 'archivo');
  if ([...name].every((character) => character.charCodeAt(0) <= 255)) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
    } catch { /* Keep filenames that were already decoded correctly. */ }
  }
  return attachmentName(name);
}

function normalizeTicket(input, previous = {}) {
  const ticket = {
    id: previous.id || '',
    title: text(input.title ?? previous.title, 140),
    description: text(input.description ?? previous.description, 5000),
    area: text(input.area ?? previous.area, 100),
    subarea: text(input.subarea ?? previous.subarea, 100),
    type: text(input.type ?? previous.type, 60),
    priority: text(input.priority ?? previous.priority, 30),
    module: text(input.module ?? previous.module, 120),
    requester: text(input.requester ?? previous.requester, 120),
    requester_email: text(input.requester_email ?? previous.requester_email, 254),
    environment: text(input.environment ?? previous.environment ?? 'Cliente', 80),
    acceptance: text(input.acceptance ?? previous.acceptance, 2000),
    status: text(input.status ?? previous.status ?? 'new', 20),
    source: previous.source || (input.source === 'desk' ? 'desk' : 'public'),
    entityId: text(input.entityId ?? previous.entityId, 80),
    attachments: Array.isArray(previous.attachments) ? previous.attachments : [],
    createdAt: previous.createdAt || ''
  };
  const missing = ['title', 'description', 'area', 'type', 'priority', 'acceptance'].filter((key) => !ticket[key]);
  if (missing.length) {
    const error = new Error(`Completa los campos obligatorios: ${missing.join(', ')}.`);
    error.status = 400;
    throw error;
  }
  if (!TICKET_STATUSES.has(ticket.status)) {
    const error = new Error('El estado del ticket no es válido.');
    error.status = 400;
    throw error;
  }
  if (ticket.requester_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ticket.requester_email)) {
    const error = new Error('El correo de contacto no es válido.');
    error.status = 400;
    throw error;
  }
  return ticket;
}

function nextTicketId(tickets) {
  const max = tickets.reduce((value, ticket) => Math.max(value, Number(String(ticket.id).match(/(\d+)$/)?.[1] || 0)), 0);
  return `PEN-${String(max + 1).padStart(4, '0')}`;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '40kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/admin/session', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ authenticated: isAdmin(req) }); });
app.post('/api/admin/session', (req, res) => {
  if (!equalSecret(req.body?.key, adminKey)) return res.status(401).json({ error: 'La clave de administración no es correcta.' });
  setAdminCookie(req, res);
  res.json({ authenticated: true });
});
app.delete('/api/admin/session', (req, res) => { setAdminCookie(req, res, false); res.status(204).end(); });

app.get('/api/entities', requireAdmin, async (_req, res, next) => {
  try { res.json((await getEntities()).map(adminEntity)); } catch (error) { next(error); }
});
app.post('/api/entities', requireAdmin, async (req, res, next) => {
  try {
    const name = text(req.body?.name, 100);
    if (!name) return res.status(400).json({ error: 'Escribe el nombre de la entidad.' });
    const entity = await queueWrite(async () => {
      const entities = await getEntities();
      if (entities.some((item) => item.name.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) {
        const error = new Error('Ya existe una entidad con ese nombre.'); error.status = 409; throw error;
      }
      const created = { id: crypto.randomUUID(), name, token: crypto.randomBytes(24).toString('hex'), createdAt: new Date().toISOString(), showHours: false, timeEntries: [] };
      entities.push(created);
      await writeJson(ENTITIES_FILE, entities);
      return created;
    });
    res.status(201).json(adminEntity(entity));
  } catch (error) { next(error); }
});

app.patch('/api/entities/:id', requireAdmin, async (req, res, next) => {
  try {
    if (typeof req.body?.showHours !== 'boolean') return res.status(400).json({ error: 'Indica si las horas deben mostrarse en el portal.' });
    const entity = await queueWrite(async () => {
      const entities = await getEntities();
      const current = entities.find((item) => item.id === req.params.id);
      if (!current) return null;
      current.showHours = req.body.showHours;
      await writeJson(ENTITIES_FILE, entities);
      return current;
    });
    if (!entity) return res.status(404).json({ error: 'No se encontró esa entidad.' });
    res.json(adminEntity(entity));
  } catch (error) { next(error); }
});

app.post('/api/entities/:id/time/:action', requireAdmin, async (req, res, next) => {
  try {
    if (!['start', 'stop', 'reset'].includes(req.params.action)) return res.status(404).json({ error: 'Acción no disponible.' });
    const entity = await queueWrite(async () => {
      const entities = await getEntities();
      const current = entities.find((item) => item.id === req.params.id);
      if (!current) return null;
      current.timeEntries ||= [];
      const active = current.timeEntries.find((entry) => !entry.endedAt);
      const conflict = (message) => { const error = new Error(message); error.status = 409; throw error; };
      if (req.params.action === 'reset') {
        if (active) conflict('Termina el contador antes de restablecer las horas.');
        const latest = current.timeEntries.at(-1)?.id || null;
        if (req.body?.lastSessionId !== latest) conflict('El registro de horas cambió. Revísalo antes de restablecerlo.');
        current.timeEntries = [];
      } else if (req.params.action === 'start') {
        if (active) conflict('Esta entidad ya tiene un contador iniciado. Se actualizó su estado.');
        current.timeEntries.push({ id: crypto.randomUUID(), startedAt: new Date().toISOString(), endedAt: null });
      } else {
        if (!active) conflict('No hay un contador en curso para terminar.');
        if (req.body?.sessionId !== active.id) conflict('El contador cambió en otra ventana. Revisa el registro actualizado antes de terminarlo.');
        active.endedAt = new Date(Math.max(Date.now(), Date.parse(active.startedAt))).toISOString();
      }
      await writeJson(ENTITIES_FILE, entities);
      return current;
    });
    if (!entity) return res.status(404).json({ error: 'No se encontró esa entidad.' });
    res.json(adminEntity(entity));
  } catch (error) { next(error); }
});

app.get('/api/entities/:id/form-config', requireAdmin, async (req, res, next) => {
  try {
    const entity = (await getEntities()).find((item) => item.id === req.params.id);
    if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });
    res.json({ config: entity.formConfig || await getFormConfig() });
  } catch (error) { next(error); }
});
app.put('/api/entities/:id/form-config', requireAdmin, async (req, res, next) => {
  try {
    const config = normalizeMesaFormConfig(req.body?.config);
    const found = await queueWrite(async () => {
      const entities = await getEntities();
      const entity = entities.find((item) => item.id === req.params.id);
      if (!entity) return false;
      entity.formConfig = config;
      await writeJson(ENTITIES_FILE, entities);
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Entidad no encontrada.' });
    res.json({ config });
  } catch (error) { next(error); }
});
app.get('/api/form-config', async (_req, res, next) => {
  try { res.json({ config: await getFormConfig() }); } catch (error) { next(error); }
});
app.put('/api/form-config', requireAdmin, async (req, res, next) => {
  try {
    const config = normalizeMesaFormConfig(req.body?.config);
    await queueWrite(() => writeJson(FORM_CONFIG_FILE, config));
    res.json({ config });
  } catch (error) { next(error); }
});

async function createTicket(input, source, files = []) {
  return queueWrite(async () => {
    const tickets = await getTickets();
    const ticket = normalizeTicket({ ...input, source }, {});
    await validateEntityId(ticket.entityId);
    const now = new Date().toISOString();
    ticket.id = nextTicketId(tickets);
    ticket.source = source;
    ticket.createdAt = now;
    ticket.updatedAt = now;
    ticket.attachments = files.map((file) => ({
      id: file.filename,
      name: uploadedAttachmentName(file.originalname),
      size: file.size,
      type: file.mimetype,
      source: source === 'desk' ? 'desk' : 'public'
    }));

    const storedIds = [];
    try {
      for (const file of files) {
        await storeUploadedFile(file);
        storedIds.push(file.filename);
      }
      tickets.unshift(ticket);
      await writeJson(TICKETS_FILE, tickets);
    } catch (error) {
      await Promise.all(storedIds.map((id) => removeStoredFile(id)));
      throw error;
    }
    return ticket;
  });
}

async function receivePublicTicket(req, res, next) {
  const files = req.files || [];
  try {
    res.status(201).json(await createTicket({ ...req.body, entityId: req.portalEntity?.id || '', status: 'new' }, 'public', files));
  } catch (error) {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
    next(error);
  }
}
app.post('/api/public/tickets', uploadAttachments.array('attachments', MAX_ATTACHMENT_COUNT), receivePublicTicket);
app.get('/api/portal/:token', findPortalEntity, async (req, res, next) => {
  try {
    const tickets = (await getTickets()).filter((ticket) => ticket.entityId === req.portalEntity.id).map((ticket) => ({
      id: ticket.id, title: ticket.title, description: ticket.description, acceptance: ticket.acceptance,
      status: ticket.status, priority: ticket.priority, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
      attachments: ticket.attachments || []
    }));
    const entity = { id: req.portalEntity.id, name: req.portalEntity.name, showHours: req.portalEntity.showHours === true };
    if (entity.showHours) entity.hours = entityHours(req.portalEntity);
    res.json({ entity, config: req.portalEntity.formConfig || await getFormConfig(), tickets });
  } catch (error) { next(error); }
});
app.post('/api/portal/:token/tickets', findPortalEntity, uploadAttachments.array('attachments', MAX_ATTACHMENT_COUNT), receivePublicTicket);
app.get('/api/tickets', requireAdmin, async (_req, res, next) => {
  try { res.json(await getTickets()); } catch (error) { next(error); }
});
async function downloadAttachment(req, res, next) {
  try {
    const tickets = await getTickets();
    const ticket = tickets.find((item) => item.id === req.params.ticketId && (!req.portalEntity || item.entityId === req.portalEntity.id));
    const attachment = ticket?.attachments?.find((item) => item.id === req.params.attachmentId);
    if (!attachment || !/^[0-9a-f-]{36}$/i.test(attachment.id)) {
      return res.status(404).json({ error: 'No se encontró ese archivo.' });
    }
    const filePath = path.join(UPLOADS_DIR, attachment.id);
    const safeName = attachmentName(attachment.name);
    const inlineType = req.query.inline === '1' ? INLINE_ATTACHMENT_TYPES.get(path.extname(safeName).toLowerCase()) : null;
    if (USE_SUPABASE) {
      try {
        await fs.access(filePath);
      } catch {
        const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(attachment.id)}`;
        const remote = await fetch(url, { headers: supabaseHeaders() });
        if (!remote.ok) return res.status(404).json({ error: 'No se encontró ese archivo.' });
        await fs.mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });
        await fs.writeFile(filePath, Buffer.from(await remote.arrayBuffer()), { mode: 0o600 });
      }
    }
    if (inlineType) {
      res.sendFile(filePath, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Type': inlineType,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`,
          'X-Content-Type-Options': 'nosniff'
        }
      }, (error) => {
        if (error && !res.headersSent) next(error);
      });
      return;
    }
    res.download(filePath, safeName, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      }
    }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) { next(error); }
}
app.get('/api/tickets/:ticketId/attachments/:attachmentId', requireAdmin, downloadAttachment);
app.get('/api/portal/:token/tickets/:ticketId/attachments/:attachmentId', findPortalEntity, downloadAttachment);
app.post('/api/tickets/:ticketId/attachments', requireAdmin, uploadAttachments.array('attachments', MAX_ATTACHMENT_COUNT), async (req, res, next) => {
  const files = req.files || [];
  try {
    if (!files.length) return res.status(400).json({ error: 'Selecciona al menos un archivo para adjuntar.' });
    const updated = await queueWrite(async () => {
      const tickets = await getTickets();
      const index = tickets.findIndex((ticket) => ticket.id === req.params.ticketId);
      if (index < 0) return null;
      const ticket = tickets[index];
      const currentAttachments = Array.isArray(ticket.attachments) ? ticket.attachments : [];
      if (currentAttachments.length + files.length > MAX_ATTACHMENT_COUNT) {
        const error = new Error(`Cada ticket admite hasta ${MAX_ATTACHMENT_COUNT} archivos adjuntos.`);
        error.status = 400;
        throw error;
      }
      const added = files.map((file) => ({
        id: file.filename,
        name: uploadedAttachmentName(file.originalname),
        size: file.size,
        type: file.mimetype,
        source: 'desk'
      }));
      const storedIds = [];
      try {
        for (const file of files) {
          await storeUploadedFile(file);
          storedIds.push(file.filename);
        }
        ticket.attachments = [...currentAttachments, ...added];
        ticket.updatedAt = new Date().toISOString();
        tickets[index] = ticket;
        await writeJson(TICKETS_FILE, tickets);
        return ticket;
      } catch (error) {
        await Promise.all(storedIds.map((id) => removeStoredFile(id)));
        throw error;
      }
    });
    if (!updated) {
      await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
      return res.status(404).json({ error: 'No se encontró ese ticket.' });
    }
    res.status(201).json(updated);
  } catch (error) {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
    next(error);
  }
});
app.delete('/api/tickets/:ticketId/attachments/:attachmentId', requireAdmin, async (req, res, next) => {
  try {
    let removedId = null;
    const updated = await queueWrite(async () => {
      const tickets = await getTickets();
      const index = tickets.findIndex((ticket) => ticket.id === req.params.ticketId);
      if (index < 0) return null;
      const ticket = tickets[index];
      const currentAttachments = Array.isArray(ticket.attachments) ? ticket.attachments : [];
      const attachment = currentAttachments.find((item) => item.id === req.params.attachmentId);
      if (!attachment) return undefined;
      removedId = attachment.id;
      ticket.attachments = currentAttachments.filter((item) => item.id !== req.params.attachmentId);
      ticket.updatedAt = new Date().toISOString();
      tickets[index] = ticket;
      await writeJson(TICKETS_FILE, tickets);
      return ticket;
    });
    if (updated === null) return res.status(404).json({ error: 'No se encontró ese ticket.' });
    if (updated === undefined) return res.status(404).json({ error: 'No se encontró ese archivo.' });
    if (removedId && /^[0-9a-f-]{36}$/i.test(removedId)) {
      await removeStoredFile(removedId);
    }
    res.json(updated);
  } catch (error) { next(error); }
});
app.post('/api/tickets', requireAdmin, async (req, res, next) => {
  try { res.status(201).json(await createTicket(req.body || {}, 'desk')); } catch (error) { next(error); }
});
app.patch('/api/tickets/:id', requireAdmin, async (req, res, next) => {
  try {
    const updated = await queueWrite(async () => {
      const tickets = await getTickets();
      const index = tickets.findIndex((ticket) => ticket.id === req.params.id);
      if (index < 0) return null;
      const ticket = normalizeTicket(req.body || {}, tickets[index]);
      await validateEntityId(ticket.entityId);
      ticket.id = tickets[index].id;
      ticket.source = tickets[index].source;
      ticket.createdAt = tickets[index].createdAt;
      ticket.updatedAt = new Date().toISOString();
      tickets[index] = ticket;
      await writeJson(TICKETS_FILE, tickets);
      return ticket;
    });
    if (!updated) return res.status(404).json({ error: 'No se encontró ese ticket.' });
    res.json(updated);
  } catch (error) { next(error); }
});
app.delete('/api/tickets/:id', requireAdmin, async (req, res, next) => {
  try {
    let removedAttachments = [];
    const deleted = await queueWrite(async () => {
      const tickets = await getTickets();
      const index = tickets.findIndex((ticket) => ticket.id === req.params.id);
      if (index < 0) return false;
      removedAttachments = Array.isArray(tickets[index].attachments) ? tickets[index].attachments : [];
      tickets.splice(index, 1);
      await writeJson(TICKETS_FILE, tickets);
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'No se encontró ese ticket.' });
    await Promise.all(
      removedAttachments
        .filter((file) => file?.id && /^[0-9a-f-]{36}$/i.test(file.id))
        .map((file) => removeStoredFile(file.id))
    );
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/', (req, res) => {
  if (req.query.access) {
    if (equalSecret(req.query.access, adminKey)) setAdminCookie(req, res);
    return res.redirect(303, '/');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});
for (const asset of ['index.html', 'solicitar.html', 'styles.css', 'app.js', 'public-form.js', 'form-config.js', 'work-hours.js', 'favicon.ico', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png']) {
  app.get(`/${asset}`, (_req, res) => res.sendFile(path.join(__dirname, asset)));
}
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Cada archivo puede pesar hasta 10 MB.'
      : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Adjunta hasta 8 archivos por solicitud.'
        : 'No se pudieron procesar los archivos adjuntos.';
    res.status(400).json({ error: message });
    return;
  }
  res.status(error.status || 500).json({ error: error.status && error.status < 500 ? error.message : 'Ocurrió un error en el servidor.' });
});

async function syncLocalSeedToSupabase() {
  if (!USE_SUPABASE) return;
  await readJson(ENTITIES_FILE, []);
  await readJson(FORM_CONFIG_FILE, MESA_FORM_DEFAULTS);
  const tickets = await readJson(TICKETS_FILE, []);
  if (!Array.isArray(tickets)) return;
  for (const ticket of tickets) {
    for (const attachment of ticket.attachments || []) {
      if (!attachment?.id || !/^[0-9a-f-]{36}$/i.test(attachment.id)) continue;
      const localPath = path.join(UPLOADS_DIR, attachment.id);
      try {
        const buffer = await fs.readFile(localPath);
        const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(attachment.id)}`;
        await fetch(url, {
          method: 'POST',
          headers: supabaseHeaders({
            'Content-Type': attachment.type || 'application/octet-stream',
            'x-upsert': 'true'
          }),
          body: buffer
        });
      } catch {}
    }
  }
}

async function startServer() {
  const stored = await readJson(ADMIN_KEY_FILE, null);
  adminKey = process.env.ADMIN_KEY || stored?.key || crypto.randomBytes(24).toString('hex');
  if (!process.env.ADMIN_KEY && !stored?.key) await writeJson(ADMIN_KEY_FILE, { key: adminKey });
  await syncLocalSeedToSupabase();
  app.listen(PORT, HOST, () => {
  console.log(`Mesa de pendientes disponible en http://${HOST}:${PORT}`);
  console.log(`Formulario público local: http://${HOST}:${PORT}/solicitar.html`);
  console.log(`Datos persistentes: ${USE_SUPABASE ? `Supabase (${SUPABASE_URL})` : DATA_DIR}`);
  console.log(`Acceso privado de administración: http://127.0.0.1:${PORT}/?access=${encodeURIComponent(adminKey)}`);
  });
}
void startServer().catch((error) => { console.error(error); process.exitCode = 1; });
