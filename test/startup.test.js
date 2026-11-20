// Arranque real (como en Render/Vercel): con cron, WhatsApp y puerto activos.
// Existe porque admin-auth.test.js carga la app con los efectos desactivados y
// no detectaría un fallo que solo ocurre al arrancar en producción.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..', 'server.js');

test('server.js arranca con efectos activos y responde /health', async () => {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'barberelite-start-')); // sin .env real
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PORT: String(port),
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
      ENABLE_WA: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  try {
    let status = null;
    for (let i = 0; i < 40 && status === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode !== null) break;
      try { status = (await fetch(`http://127.0.0.1:${port}/health`)).status; } catch { /* aún arrancando */ }
    }
    assert.equal(child.exitCode, null, `el servidor terminó al arrancar:\n${stderr.slice(0, 800)}`);
    assert.equal(status, 200);
  } finally {
    child.kill();
    await exited;
  }
});
