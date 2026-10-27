const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function createSupabaseMock() {
  const tickets = Array.from({ length: 100 }, (_, index) => ({
    id: `PEN-${String(index + 1).padStart(4, '0')}`,
    title: `Synthetic ticket ${index + 1}`,
    description: `Synthetic description for ticket ${index + 1}. `.repeat(5),
    acceptance: 'Synthetic acceptance criteria. '.repeat(3),
    area: 'General',
    subarea: 'Support',
    type: 'Request',
    priority: 'Media',
    status: 'review',
    entityId: 'entity-test-1',
    source: 'public',
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    attachments: [{ id: `attachment-${index + 1}`, name: 'evidence.pdf', size: 4096, type: 'application/pdf', source: 'public' }]
  }));
  const state = new Map([
    ['entities', {
      value: [{
        id: 'entity-test-1', name: 'Example Client', token: 'test-portal-token', showHours: true,
        timeEntries: [{ id: 'session-test-1', startedAt: '2026-10-27T10:00:00.000Z', endedAt: null }]
      }],
      updated_at: '2026-10-27T10:00:00.000Z'
    }],
    ['tickets', { value: tickets, updated_at: '2026-10-27T10:00:00.000Z' }],
    ['form-config', {
      value: {
        areas: [{ name: 'General', subareas: ['Support'] }],
        types: ['Request'], priorities: ['Media'],
        theme: { mode: 'workspace', accent: '#f06a3c', hot: '#ff8051', ink: '#9c361b', initials: 'E', workspaceName: 'Example Client' }
      },
      updated_at: '2026-10-27T10:00:00.000Z'
    }]
  ]);
  const stats = {
    restRequests: 0,
    ticketValueReads: 0,
    ticketMetadataReads: 0,
    ticketValueResponseBytes: 0,
    ticketMetadataResponseBytes: 0,
    storageGets: 0,
    storageUploads: 0,
    storageDeletes: 0
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://supabase.mock');
    if (url.pathname === '/rest/v1/mesa_kv' && (request.method === 'GET' || request.method === 'HEAD')) {
      stats.restRequests += 1;
      const filter = url.searchParams.get('key') || '';
      let keys = [];
      if (filter.startsWith('eq.')) keys = [filter.slice(3)];
      else if (filter.startsWith('in.(') && filter.endsWith(')')) keys = filter.slice(4, -1).split(',').filter(Boolean);
      const selection = new Set((url.searchParams.get('select') || '*').split(','));
      const rows = keys.flatMap((key) => {
        const record = state.get(key);
        if (!record) return [];
        const row = {};
        if (selection.has('*') || selection.has('key')) row.key = key;
        if (selection.has('*') || selection.has('value')) row.value = record.value;
        if (selection.has('*') || selection.has('updated_at')) row.updated_at = record.updated_at;
        if (key === 'tickets') {
          if (Object.hasOwn(row, 'value')) stats.ticketValueReads += 1;
          if (Object.hasOwn(row, 'updated_at')) stats.ticketMetadataReads += 1;
        }
        return [row];
      });
      const json = JSON.stringify(rows);
      const bytes = Buffer.byteLength(json);
      if (keys.includes('tickets')) {
        if (selection.has('*') || selection.has('value')) stats.ticketValueResponseBytes += bytes;
        else stats.ticketMetadataResponseBytes += bytes;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'HEAD') response.end();
      else response.end(json);
      return;
    }

    if (url.pathname === '/rest/v1/mesa_kv' && request.method === 'POST') {
      stats.restRequests += 1;
      const rows = JSON.parse((await readRequestBody(request)).toString('utf8') || '[]');
      for (const row of rows) state.set(row.key, { value: row.value, updated_at: row.updated_at });
      response.statusCode = 201;
      response.end();
      return;
    }

    if (url.pathname.startsWith('/storage/v1/object/')) {
      if (request.method === 'GET') stats.storageGets += 1;
      if (request.method === 'POST') {
        stats.storageUploads += 1;
        await readRequestBody(request);
      }
      if (request.method === 'DELETE') stats.storageDeletes += 1;
      response.statusCode = request.method === 'GET' ? 404 : 200;
      response.end();
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  return { server, state, stats };
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 8000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready: ${lastError?.message || 'timeout'}.\n${output()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('portal uses lightweight conditional revalidation and keeps auth checks current', { timeout: 20000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesa-supabase-transfer-test-'));
  const mock = createSupabaseMock();
  let child;
  let output = '';
  let mockStarted = false;

  try {
    for (const filename of ['server.js', 'form-config.js']) {
      await fs.copyFile(path.join(repoRoot, filename), path.join(tempDir, filename));
    }
    await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir');

    mock.server.listen(0, '127.0.0.1');
    await once(mock.server, 'listening');
    mockStarted = true;
    const supabasePort = mock.server.address().port;
    const appPort = await reservePort();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    child = spawn(process.execPath, [path.join(tempDir, 'server.js')], {
      cwd: tempDir,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(appPort),
        ADMIN_KEY: 'mock-admin-key',
        SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
        SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role-key',
        SUPABASE_BUCKET: 'mesa-uploads'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    await waitForHealth(baseUrl, child, () => output);

    // With an explicit admin key and no data/ seed directory, cold startup should not touch Supabase.
    assert.equal(mock.stats.restRequests, 0);
    assert.equal(mock.stats.storageUploads, 0);

    const unauthorized = await fetch(`${baseUrl}/api/tickets`);
    assert.equal(unauthorized.status, 401);
    assert.equal(mock.stats.restRequests, 0);

    const first = await fetch(`${baseUrl}/api/portal/test-portal-token`);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const firstTag = first.headers.get('etag');
    assert.ok(firstTag, 'portal response should expose an ETag when revisions exist');
    assert.equal(firstBody.tickets.length, 100);
    assert.equal(mock.stats.ticketValueReads, 1);
    const fullTicketPayloadBytes = mock.stats.ticketValueResponseBytes;

    const metadataBytesBefore = mock.stats.ticketMetadataResponseBytes;
    const unchanged = await fetch(`${baseUrl}/api/portal/test-portal-token`, {
      headers: { 'If-None-Match': firstTag }
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
    assert.equal(mock.stats.ticketValueReads, 1, '304 revalidation must not read the full tickets JSON');
    const conditionalMetadataBytes = mock.stats.ticketMetadataResponseBytes - metadataBytesBefore;
    assert.ok(conditionalMetadataBytes > 0, 'mock should observe a metadata-only revision response');
    assert.ok(fullTicketPayloadBytes > conditionalMetadataBytes * 10, '100-ticket payload should be much larger than one metadata revalidation');

    mock.state.set('tickets', {
      ...mock.state.get('tickets'),
      value: mock.state.get('tickets').value.map((ticket, index) => index === 0 ? { ...ticket, title: 'Updated synthetic ticket' } : ticket),
      updated_at: '2026-10-27T10:01:00.000Z'
    });
    const ticketChange = await fetch(`${baseUrl}/api/portal/test-portal-token`, {
      headers: { 'If-None-Match': firstTag }
    });
    assert.equal(ticketChange.status, 200);
    const ticketChangeBody = await ticketChange.json();
    assert.equal(ticketChangeBody.tickets[0].title, 'Updated synthetic ticket');
    const ticketTag = ticketChange.headers.get('etag');
    assert.ok(ticketTag && ticketTag !== firstTag);
    assert.equal(mock.stats.ticketValueReads, 2);

    mock.state.set('form-config', {
      ...mock.state.get('form-config'),
      value: { ...mock.state.get('form-config').value, areas: [{ name: 'Changed area', subareas: ['Changed detail'] }] },
      updated_at: '2026-10-27T10:02:00.000Z'
    });
    const configChange = await fetch(`${baseUrl}/api/portal/test-portal-token`, {
      headers: { 'If-None-Match': ticketTag }
    });
    assert.equal(configChange.status, 200);
    const configBody = await configChange.json();
    assert.equal(configBody.config.areas[0].name, 'Changed area');
    const configTag = configChange.headers.get('etag');
    assert.ok(configTag && configTag !== ticketTag);

    mock.state.set('entities', {
      ...mock.state.get('entities'),
      value: [{ ...mock.state.get('entities').value[0], showHours: false }],
      updated_at: '2026-10-27T10:03:00.000Z'
    });
    const entityChange = await fetch(`${baseUrl}/api/portal/test-portal-token`, {
      headers: { 'If-None-Match': configTag }
    });
    assert.equal(entityChange.status, 200);
    const entityBody = await entityChange.json();
    assert.equal(entityBody.entity.showHours, false, 'hour visibility changes should invalidate the portal ETag');
    const entityTag = entityChange.headers.get('etag');
    assert.ok(entityTag && entityTag !== configTag);

    mock.state.set('tickets', {
      ...mock.state.get('tickets'),
      updated_at: null
    });
    const ticketReadsBeforeFallback = mock.stats.ticketValueReads;
    const incompleteMetadata = await fetch(`${baseUrl}/api/portal/test-portal-token`, {
      headers: { 'If-None-Match': entityTag }
    });
    assert.equal(incompleteMetadata.status, 200, 'missing revision metadata should force a full response');
    assert.equal(mock.stats.ticketValueReads, ticketReadsBeforeFallback + 1, 'fallback must read the full tickets value');
    const incompleteBody = await incompleteMetadata.json();
    assert.equal(incompleteBody.tickets[0].title, 'Updated synthetic ticket');

    mock.state.set('entities', { value: [], updated_at: '2026-10-27T10:04:00.000Z' });
    const revoked = await fetch(`${baseUrl}/api/portal/test-portal-token`, {
      headers: { 'If-None-Match': entityTag }
    });
    assert.equal(revoked.status, 404, 'fresh token validation must precede a possible 304');

    console.log(`Synthetic 100-ticket comparison (raw JSON body only): ${fullTicketPayloadBytes} bytes for the ticket value vs ${conditionalMetadataBytes} bytes for a conditional metadata revalidation.`);
  } finally {
    await stopChild(child);
    if (mockStarted) await new Promise((resolve) => mock.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('local persistence still serves portal data without Supabase', { timeout: 15000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesa-local-mode-test-'));
  let child;
  let output = '';
  try {
    for (const filename of ['server.js', 'form-config.js']) {
      await fs.copyFile(path.join(repoRoot, filename), path.join(tempDir, filename));
    }
    await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir');
    await fs.mkdir(path.join(tempDir, 'data'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'data', 'entities.json'), JSON.stringify([{
      id: 'local-entity-1', name: 'Local Fixture', token: 'local-test-token', showHours: false, timeEntries: []
    }]));
    await fs.writeFile(path.join(tempDir, 'data', 'tickets.json'), JSON.stringify([{
      id: 'PEN-LOCAL-0001', title: 'Local fixture ticket', description: 'Fixture only', acceptance: 'Fixture only',
      area: 'General', type: 'Request', priority: 'Media', status: 'new', entityId: 'local-entity-1', attachments: []
    }]));
    await fs.writeFile(path.join(tempDir, 'data', 'form-config.json'), JSON.stringify({
      areas: [{ name: 'Local', subareas: ['Fixture'] }], types: ['Request'], priorities: ['Media'], theme: {}
    }));

    const appPort = await reservePort();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    child = spawn(process.execPath, [path.join(tempDir, 'server.js')], {
      cwd: tempDir,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(appPort),
        ADMIN_KEY: '',
        SUPABASE_URL: '',
        SUPABASE_SERVICE_ROLE_KEY: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    await waitForHealth(baseUrl, child, () => output);

    const response = await fetch(`${baseUrl}/api/portal/local-test-token`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tickets.length, 1);
    assert.equal(body.tickets[0].title, 'Local fixture ticket');
    assert.equal(body.config.areas[0].name, 'Local');
  } finally {
    await stopChild(child);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
