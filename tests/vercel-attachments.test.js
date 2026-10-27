const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const readBody = async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); };

test('Vercel uses temporary uploads and persists attachments in Supabase', { timeout: 20000 }, async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mesa-attachment-test-'));
  const records = new Map([
    ['entities', [{ id: 'entity-1', token: 'test-entity-token', name: 'Prueba', timeEntries: [] }]],
    ['tickets', [{ id: 'PEN-0001', title: 'Prueba', description: 'Prueba', area: 'General', type: 'Solicitud', priority: 'Media', acceptance: 'Listo', status: 'new', entityId: 'entity-1', attachments: [] }]],
    ['form-config', { areas: [{ name: 'General', subareas: ['General'] }], types: ['Solicitud'], priorities: ['Media'] }]
  ]);
  const objects = new Map();
  let failUpload = false;
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/rest/v1/mesa_kv') {
      if (req.method === 'GET') {
        const key = (url.searchParams.get('key') || '').replace(/^eq\./, '');
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(records.has(key) ? [{ value: records.get(key) }] : []));
      }
      if (req.method === 'POST') {
        const rows = JSON.parse((await readBody(req)).toString());
        for (const row of rows) records.set(row.key, row.value);
        res.statusCode = 201;
        return res.end();
      }
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-1));
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (failUpload) { res.statusCode = 500; return res.end(); }
        objects.set(key, body); res.statusCode = 200; return res.end();
      }
      if (req.method === 'GET') {
        if (!objects.has(key)) { res.statusCode = 404; return res.end(); }
        return res.end(objects.get(key));
      }
      if (req.method === 'DELETE') { objects.delete(key); return res.end(); }
    }
    res.statusCode = 404; res.end();
  });
  let app;
  try {
    for (const name of ['server.js', 'form-config.js']) await fs.copyFile(path.join(root, name), path.join(work, name));
    await fs.symlink(path.join(root, 'node_modules'), path.join(work, 'node_modules'), 'dir');
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
    const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    // Simulates the read-only deployment bundle. Supabase remains writable.
    await fs.chmod(work, 0o555);
    app = spawn(process.execPath, [path.join(work, 'server.js')], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), VERCEL: '1', ADMIN_KEY: 'test-only', SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'test-only' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = ''; app.stderr.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.ok(ready, output);
    const login = await fetch(`${base}/api/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'test-only' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const txt = 'Evidencia de prueba, sin datos reales.\n';
    const files = new FormData(); files.append('attachments', new Blob([txt], { type: 'text/plain' }), 'prueba.txt');
    const upload = await fetch(`${base}/api/tickets/PEN-0001/attachments`, { method: 'POST', headers: { Cookie: cookie }, body: files });
    assert.equal(upload.status, 201, await upload.text().catch(() => ''));
    const attachment = records.get('tickets')[0].attachments[0];
    assert.equal(objects.get(attachment.id).toString(), txt);
    const scratch = path.join(os.tmpdir(), 'mesa-de-pendientes', String(app.pid));
    await fs.rm(scratch, { recursive: true, force: true }); // Simulate a cold instance.
    const adminRead = await fetch(`${base}/api/tickets/PEN-0001/attachments/${attachment.id}`, { headers: { Cookie: cookie } });
    assert.equal(adminRead.status, 200); assert.equal(await adminRead.text(), txt);
    assert.match(adminRead.headers.get('content-disposition'), /^attachment/);
    const portalRead = await fetch(`${base}/api/portal/test-entity-token/tickets/PEN-0001/attachments/${attachment.id}?inline=1`);
    assert.equal(portalRead.status, 200); assert.equal(await portalRead.text(), txt);
    assert.match(portalRead.headers.get('content-type'), /^text\/plain/);
    assert.equal((await fetch(`${base}/api/tickets/PEN-0001/attachments/${attachment.id}`)).status, 401);
    assert.equal((await fetch(`${base}/api/portal/wrong-token/tickets/PEN-0001/attachments/${attachment.id}`)).status, 404);
    const requestData = new FormData();
    for (const [key, value] of Object.entries({ title: 'Solicitud', description: 'Prueba', area: 'General', type: 'Solicitud', priority: 'Media', acceptance: 'Lista' })) requestData.append(key, value);
    requestData.append('attachments', new Blob(['Texto del portal'], { type: 'text/plain' }), 'cliente.txt');
    const createdResponse = await fetch(`${base}/api/portal/test-entity-token/tickets`, { method: 'POST', body: requestData });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.attachments.length, 1);
    assert.equal(objects.get(created.attachments[0].id).toString(), 'Texto del portal');
    const createdRead = await fetch(`${base}/api/portal/test-entity-token/tickets/${created.id}/attachments/${created.attachments[0].id}`);
    assert.equal(createdRead.status, 200); assert.equal(await createdRead.text(), 'Texto del portal');
    failUpload = true;
    const badFiles = new FormData(); badFiles.append('attachments', new Blob(['error']), 'error.txt');
    const failed = await fetch(`${base}/api/tickets/PEN-0001/attachments`, { method: 'POST', headers: { Cookie: cookie }, body: badFiles });
    assert.equal(failed.status, 500); assert.equal(records.get('tickets').find(ticket => ticket.id === 'PEN-0001').attachments.length, 1);
    const tempFiles = await fs.readdir(path.join(scratch, 'uploads')).catch(() => []);
    assert.deepEqual(tempFiles.filter(name => name !== '.incoming'), []);
  } finally {
    if (app && app.exitCode === null) { app.kill('SIGTERM'); await once(app, 'exit'); }
    if (app) await fs.rm(path.join(os.tmpdir(), 'mesa-de-pendientes', String(app.pid)), { recursive: true, force: true });
    await new Promise(resolve => mock.close(resolve));
    await fs.chmod(work, 0o755); await fs.rm(work, { recursive: true, force: true });
  }
});
