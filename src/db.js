// Capa de almacenamiento: "base de datos" de archivos JSON.
//   - Local / servidor propio: archivos dentro de ./data (o DATA_DIR).
//   - Vercel: los mismos archivos JSON guardados en un Vercel Blob Store
//     (se activa solo cuando existe BLOB_READ_WRITE_TOKEN).
// Cada "tabla" es un archivo: personas.json, clientes.json, actividades.json
// y un archivo de tareos por persona: tareos/<personaId>.json
import fs from 'node:fs/promises';
import path from 'node:path';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
export const EN_VERCEL = Boolean(process.env.VERCEL);
// 'vercel-blob'    → nube, archivos JSON en un Vercel Blob Store
// 'archivos'       → local / servidor propio, carpeta DATA_DIR
// 'sin-configurar' → estamos en Vercel pero falta conectar el Blob Store (BLOB_READ_WRITE_TOKEN)
export const MODO = BLOB_TOKEN ? 'vercel-blob' : EN_VERCEL ? 'sin-configurar' : 'archivos';
export const MENSAJE_SIN_CONFIGURAR =
  'Falta conectar el Blob Store al proyecto en Vercel (no existe la variable BLOB_READ_WRITE_TOKEN). ' +
  'Ve a Storage → Create Database → Blob → Connect Project y luego haz Redeploy.';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const BLOB_ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
const BLOB_PREFIX = (process.env.BLOB_PREFIX || 'tareo-db').replace(/^\/+|\/+$/g, '');
const REINTENTOS = 6;

let sdkPromise;
const sdk = () => (sdkPromise ??= import('@vercel/blob'));

// Cola por clave: serializa leer-modificar-escribir dentro del mismo proceso.
const colas = new Map();
function enCola(clave, fn) {
  const anterior = colas.get(clave) ?? Promise.resolve();
  const actual = anterior.catch(() => {}).then(fn);
  colas.set(clave, actual);
  actual
    .finally(() => { if (colas.get(clave) === actual) colas.delete(clave); })
    .catch(() => {});
  return actual;
}

const clon = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

// ---------------- backend: archivos locales ----------------
const rutaDe = (clave) => path.join(DATA_DIR, clave);

async function archivoLeer(clave) {
  try {
    const texto = await fs.readFile(rutaDe(clave), 'utf8');
    return { valor: JSON.parse(texto), version: null };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function archivoEscribir(clave, valor) {
  const ruta = rutaDe(clave);
  await fs.mkdir(path.dirname(ruta), { recursive: true });
  // Escritura atómica: primero a un temporal, luego rename.
  const tmp = `${ruta}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(valor, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, ruta);
}

// ---------------- backend: Vercel Blob ----------------
const rutaBlob = (clave) => `${BLOB_PREFIX}/${clave}`;

async function blobLeer(clave) {
  const { get, BlobNotFoundError } = await sdk();
  let res;
  try {
    // useCache:false → siempre la última versión (evita la caché del CDN).
    res = await get(rutaBlob(clave), { access: BLOB_ACCESS, useCache: false });
  } catch (e) {
    if (BlobNotFoundError && e instanceof BlobNotFoundError) return null;
    throw e;
  }
  if (!res || !res.stream) return null;
  const texto = await new Response(res.stream).text();
  return { valor: JSON.parse(texto), version: res.blob?.etag ?? null };
}

async function blobEscribir(clave, valor, version) {
  const { put } = await sdk();
  await put(rutaBlob(clave), JSON.stringify(valor, null, 2), {
    access: BLOB_ACCESS,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    // Escritura condicional por ETag: si otro proceso escribió antes, falla y reintentamos.
    ...(version ? { ifMatch: version } : {}),
  });
}

// ---------------- backend: Vercel sin Blob Store ----------------
function sinConfigurar() {
  const err = new Error(MENSAJE_SIN_CONFIGURAR);
  err.status = 503;
  throw err;
}

const backend = {
  'vercel-blob': { leer: blobLeer, escribir: blobEscribir },
  archivos: { leer: archivoLeer, escribir: archivoEscribir },
  'sin-configurar': { leer: sinConfigurar, escribir: sinConfigurar },
}[MODO];

/** Devuelve el contenido del archivo o `porDefecto` si no existe. */
export async function leer(clave, porDefecto = null) {
  const r = await backend.leer(clave);
  return r ? r.valor : clon(porDefecto);
}

/** Sobrescribe el archivo completo. */
export function escribir(clave, valor) {
  return enCola(clave, () => backend.escribir(clave, valor));
}

/**
 * Lee, aplica `mutar(valor)` y guarda el resultado (o el mismo valor mutado).
 * En Vercel Blob usa ifMatch (ETag) y reintenta si hubo escritura concurrente.
 */
export function actualizar(clave, porDefecto, mutar) {
  return enCola(clave, async () => {
    for (let intento = 1; ; intento++) {
      const r = await backend.leer(clave);
      const valor = r ? r.valor : clon(porDefecto);
      const nuevo = (await mutar(valor)) ?? valor;
      try {
        await backend.escribir(clave, nuevo, r?.version);
        return nuevo;
      } catch (e) {
        const conflicto = e?.name === 'BlobPreconditionFailedError' || /precondition/i.test(e?.message ?? '');
        if (!conflicto || intento >= REINTENTOS) throw e;
        await new Promise((ok) => setTimeout(ok, 60 * intento));
      }
    }
  });
}
