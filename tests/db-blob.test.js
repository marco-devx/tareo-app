import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearBackendBlob, crearAlmacen } from '../src/db.js';

// SDK de @vercel/blob simulado: un store en memoria cuyo get() devuelve el ETag como cabecera HTTP
// débil (W/"…"), igual que el CDN de Vercel, y cuyo put() valida x-if-match contra el ETag real.
function sdkFalso({ headRoto = false } = {}) {
  const store = new Map(); // pathname → { texto, etag }
  let n = 0;
  class BlobPreconditionFailedError extends Error {
    constructor() { super('Vercel Blob: Precondition failed: ETag mismatch.'); this.name = 'BlobPreconditionFailedError'; }
  }
  class BlobNotFoundError extends Error {
    constructor() { super('Vercel Blob: The requested blob does not exist'); this.name = 'BlobNotFoundError'; }
  }
  const sdk = {
    puts: 0,
    heads: 0,
    store,
    BlobPreconditionFailedError,
    BlobNotFoundError,
    async get(pathname) {
      const b = store.get(pathname);
      if (!b) return null;
      return { statusCode: 200, stream: new Blob([b.texto]).stream(), headers: new Headers(), blob: { etag: `W/${b.etag}` } };
    },
    async head(pathname) {
      sdk.heads++;
      const b = store.get(pathname);
      if (!b) throw new BlobNotFoundError();
      return { etag: headRoto ? '"otro"' : b.etag };
    },
    async put(pathname, cuerpo, opts) {
      sdk.puts++;
      const actual = store.get(pathname);
      if (opts.ifMatch && actual && opts.ifMatch !== actual.etag) throw new BlobPreconditionFailedError();
      store.set(pathname, { texto: String(cuerpo), etag: `"v${++n}"` });
      return { pathname };
    },
  };
  return sdk;
}

test('blob: leer devuelve null si no existe y actualizar crea, luego sobrescribe con ifMatch', async () => {
  const sdk = sdkFalso();
  const db = crearAlmacen(crearBackendBlob(async () => sdk, { prefijo: 'p' }), { avisar: () => {} });
  assert.equal(await db.leer('a.json', null), null);
  assert.deepEqual(await db.actualizar('a.json', [], (v) => { v.push(1); }), [1]);
  assert.deepEqual(await db.actualizar('a.json', [], (v) => { v.push(2); }), [1, 2]);
  assert.deepEqual(await db.leer('a.json'), [1, 2]);
  assert.equal(sdk.puts, 2, 'sin conflictos: un put por actualización');
  assert.ok(sdk.store.has('p/a.json'));
});

test('blob: una escritura concurrente externa provoca reintento y no se pierde nada', async () => {
  const sdk = sdkFalso();
  const db = crearAlmacen(crearBackendBlob(async () => sdk, { prefijo: 'p' }), { avisar: () => {} });
  await db.actualizar('a.json', [], (v) => { v.push('base'); });
  let interferido = false;
  const resultado = await db.actualizar('a.json', [], (v) => {
    if (!interferido) {
      interferido = true;
      // Otro proceso escribe entre nuestra lectura y nuestra escritura.
      const b = sdk.store.get('p/a.json');
      sdk.store.set('p/a.json', { texto: JSON.stringify([...JSON.parse(b.texto), 'externo']), etag: '"externo"' });
    }
    v.push('mio');
  });
  assert.deepEqual(resultado, ['base', 'externo', 'mio']);
  assert.equal(sdk.puts, 3, 'put fallido + put reintentado');
});

test('blob: si el ETag nunca coincide, el último intento escribe sin condición y avisa', async () => {
  const sdk = sdkFalso({ headRoto: true });
  const avisos = [];
  const db = crearAlmacen(crearBackendBlob(async () => sdk, { prefijo: 'p' }), { reintentos: 3, avisar: (m) => avisos.push(m) });
  await db.actualizar('a.json', [], (v) => { v.push(1); });
  assert.deepEqual(await db.actualizar('a.json', [], (v) => { v.push(2); }), [1, 2]);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /conflictos de ETag/);
});

test('blob: errores que no son de ETag se propagan sin reintentar', async () => {
  const sdk = sdkFalso();
  sdk.put = async () => { throw new Error('Vercel Blob: Access denied'); };
  const db = crearAlmacen(crearBackendBlob(async () => sdk, { prefijo: 'p' }), { avisar: () => {} });
  await assert.rejects(db.actualizar('a.json', [], (v) => v), /Access denied/);
});
