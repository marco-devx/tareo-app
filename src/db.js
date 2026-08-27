// Capa de almacenamiento: "base de datos" de archivos JSON.
//   - Local / servidor propio: archivos dentro de ./data (o DATA_DIR).
//   - Vercel: los mismos archivos JSON guardados en un Vercel Blob Store
//     (se activa cuando existen BLOB_STORE_ID [OIDC] o BLOB_READ_WRITE_TOKEN).
// Cada "tabla" es un archivo: personas.json, clientes.json y un archivo de tareos
// por persona: tareos/<personaId>.json
import fs from 'node:fs/promises';
import path from 'node:path';

// Credenciales del Blob Store. Al conectar un store, Vercel agrega BLOB_STORE_ID (+ VERCEL_OIDC_TOKEN,
// autenticación OIDC por defecto) o, en stores antiguos / fuera de Vercel, BLOB_READ_WRITE_TOKEN.
// El SDK @vercel/blob lee cualquiera de las dos por sí solo.
export const BLOB_AUTH = process.env.BLOB_READ_WRITE_TOKEN ? 'token' : process.env.BLOB_STORE_ID ? 'oidc' : null;
export const EN_VERCEL = Boolean(process.env.VERCEL);
// 'vercel-blob'    → nube, archivos JSON en un Vercel Blob Store
// 'archivos'       → local / servidor propio, carpeta DATA_DIR
// 'sin-configurar' → estamos en Vercel pero falta conectar el Blob Store
export const MODO = BLOB_AUTH ? 'vercel-blob' : EN_VERCEL ? 'sin-configurar' : 'archivos';
export const MENSAJE_SIN_CONFIGURAR =
  'Falta conectar el Blob Store al proyecto en Vercel (no existen las variables BLOB_STORE_ID ni BLOB_READ_WRITE_TOKEN). ' +
  'Ve a Storage → tu store → Connect Project, elige el proyecto y sus ambientes, y luego haz Redeploy.';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const BLOB_ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
const BLOB_PREFIX = (process.env.BLOB_PREFIX || 'tareo-db').replace(/^\/+|\/+$/g, '');
export const REINTENTOS = 5;

const clon = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

// ---------------- backend: archivos locales ----------------
// Las escrituras se serializan con la cola de crearAlmacen(); no necesita versiones.
export function crearBackendArchivos(dir = DATA_DIR) {
  const rutaDe = (clave) => path.join(dir, clave);
  return {
    async leer(clave) {
      try {
        return { valor: JSON.parse(await fs.readFile(rutaDe(clave), 'utf8')), version: null };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async escribir(clave, valor) {
      const ruta = rutaDe(clave);
      await fs.mkdir(path.dirname(ruta), { recursive: true });
      // Escritura atómica: primero a un temporal, luego rename.
      const tmp = `${ruta}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(valor, null, 2) + '\n', 'utf8');
      await fs.rename(tmp, ruta);
    },
  };
}

// ---------------- backend: Vercel Blob ----------------
// `cargarSdk` devuelve (o resuelve a) el módulo @vercel/blob; se inyecta para poder probarlo sin red.
export function crearBackendBlob(cargarSdk, { access = BLOB_ACCESS, prefijo = BLOB_PREFIX } = {}) {
  const rutaBlob = (clave) => `${prefijo}/${clave}`;
  const esNoEncontrado = (e) => e?.name === 'BlobNotFoundError' || /not found|404/i.test(e?.message ?? '');
  // El ETag que compara el servidor es el del API (head). El de get() sale de la cabecera HTTP y
  // puede venir como ETag débil (W/"…"); se normaliza por si acaso.
  const normalizarEtag = (e) => (e ? String(e).replace(/^W\//, '') : null);

  return {
    async leer(clave, { conVersion = false } = {}) {
      const { get, head } = await cargarSdk();
      let res;
      try {
        // useCache:false → siempre la última versión (evita la caché del CDN).
        res = await get(rutaBlob(clave), { access, useCache: false });
      } catch (e) {
        if (esNoEncontrado(e)) return null;
        throw e;
      }
      if (!res || !res.stream) return null;
      const texto = await new Response(res.stream).text();
      let version = null;
      if (conVersion) {
        try {
          version = normalizarEtag((await head(rutaBlob(clave))).etag);
        } catch (e) {
          if (!esNoEncontrado(e)) throw e;
        }
      }
      return { valor: JSON.parse(texto), version };
    },
    async escribir(clave, valor, version) {
      const { put } = await cargarSdk();
      await put(rutaBlob(clave), JSON.stringify(valor, null, 2), {
        access,
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        // Escritura condicional: si otro proceso escribió antes, falla con BlobPreconditionFailedError y reintentamos.
        ...(version ? { ifMatch: version } : {}),
      });
    },
  };
}

// ---------------- backend: Vercel sin Blob Store ----------------
function crearBackendSinConfigurar() {
  const fallar = () => {
    const err = new Error(MENSAJE_SIN_CONFIGURAR);
    err.status = 503;
    throw err;
  };
  return { leer: fallar, escribir: fallar };
}

// ---------------- almacén: cola por clave + reintentos ----------------
export function crearAlmacen(backend, { reintentos = REINTENTOS, avisar = (m) => console.warn(m) } = {}) {
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
  const esConflicto = (e) => e?.name === 'BlobPreconditionFailedError' || /precondition|etag/i.test(e?.message ?? '');

  return {
    /** Devuelve el contenido del archivo o `porDefecto` si no existe. */
    async leer(clave, porDefecto = null) {
      const r = await backend.leer(clave);
      return r ? r.valor : clon(porDefecto);
    },
    /** Sobrescribe el archivo completo. */
    escribir(clave, valor) {
      return enCola(clave, () => backend.escribir(clave, valor));
    },
    /**
     * Lee, aplica `mutar(valor)` y guarda el resultado (o el mismo valor mutado).
     * Con Blob usa ifMatch (ETag) y reintenta si hubo escritura concurrente; el último
     * intento escribe sin condición para no dejar al usuario bloqueado.
     */
    actualizar(clave, porDefecto, mutar) {
      return enCola(clave, async () => {
        for (let intento = 1; ; intento++) {
          const ultimo = intento >= reintentos;
          const r = await backend.leer(clave, { conVersion: !ultimo });
          const valor = r ? r.valor : clon(porDefecto);
          const nuevo = (await mutar(valor)) ?? valor;
          try {
            await backend.escribir(clave, nuevo, ultimo ? null : r?.version);
            return nuevo;
          } catch (e) {
            if (!esConflicto(e) || ultimo) throw e;
            if (intento === reintentos - 1) avisar(`[tareo-db] ${clave}: ${intento} conflictos de ETag seguidos; el siguiente intento escribe sin condición.`);
            await new Promise((ok) => setTimeout(ok, 60 * intento));
          }
        }
      });
    },
  };
}

let sdkPromise;
const cargarSdkReal = () => (sdkPromise ??= import('@vercel/blob'));

const backend = {
  'vercel-blob': () => crearBackendBlob(cargarSdkReal),
  archivos: () => crearBackendArchivos(),
  'sin-configurar': () => crearBackendSinConfigurar(),
}[MODO]();

const almacen = crearAlmacen(backend);
export const leer = almacen.leer;
export const escribir = almacen.escribir;
export const actualizar = almacen.actualizar;
