// API HTTP (JSON) bajo /api
import { Router } from 'express';
import * as store from './store.js';
import { MODO, EN_VERCEL, MENSAJE_SIN_CONFIGURAR } from './db.js';

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const api = Router();

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fechaQuery = (v) => (typeof v === 'string' && RE_FECHA.test(v) ? v : undefined);
const texto = (v) => (typeof v === 'string' && v ? v : undefined);
const nombreArchivo = (base, rep) => `${base}_${rep.desde || 'inicio'}_${rep.hasta || 'hoy'}.csv`;

// Diagnóstico rápido: abre /api/health en el navegador para saber dónde se guardan los datos.
api.get('/health', (req, res) => {
  const ok = MODO !== 'sin-configurar';
  res.status(ok ? 200 : 503).json({
    ok,
    almacenamiento: MODO,
    enVercel: EN_VERCEL,
    blobConectado: MODO === 'vercel-blob',
    mensaje: ok
      ? MODO === 'vercel-blob'
        ? 'Correcto: los datos se guardan en el Vercel Blob Store.'
        : 'Modo local: los datos se guardan en archivos de la carpeta DATA_DIR.'
      : MENSAJE_SIN_CONFIGURAR,
  });
});
api.get('/config', (req, res) => {
  res.json({ roles: store.ROLES, requierePassword: Boolean(APP_PASSWORD), almacenamiento: MODO });
});

// Contraseña compartida opcional (APP_PASSWORD)
api.use((req, res, next) => {
  if (APP_PASSWORD && req.get('x-app-password') !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña de acceso incorrecta.' });
  }
  next();
});

api.get('/catalogos', async (req, res) => res.json(await store.catalogos()));

for (const tipo of store.TIPOS_CATALOGO) {
  api.get(`/${tipo}`, async (req, res) => res.json(await store.listar(tipo)));
  api.post(`/${tipo}`, async (req, res) => res.status(201).json(await store.crear(tipo, req.body ?? {})));
  api.put(`/${tipo}/:id`, async (req, res) => res.json(await store.editar(tipo, req.params.id, req.body ?? {})));
  api.delete(`/${tipo}/:id`, async (req, res) => {
    await store.eliminar(tipo, req.params.id);
    res.status(204).end();
  });
}

api.get('/tareos', async (req, res) => {
  const { personaId, clienteId, desde, hasta } = req.query;
  res.json(await store.listarTareos({ personaId: texto(personaId), clienteId: texto(clienteId), desde: fechaQuery(desde), hasta: fechaQuery(hasta) }));
});
api.post('/tareos', async (req, res) => res.status(201).json(await store.crearTareo(req.body ?? {})));
api.put('/tareos/:id', async (req, res) => {
  const personaId = texto(req.body?.personaId) ?? texto(req.query.personaId);
  if (!personaId) throw new store.ErrorApp(400, 'Falta personaId.');
  res.json(await store.editarTareo(personaId, req.params.id, req.body ?? {}));
});
api.delete('/tareos/:id', async (req, res) => {
  const personaId = texto(req.query.personaId);
  if (!personaId) throw new store.ErrorApp(400, 'Falta personaId.');
  await store.eliminarTareo(personaId, req.params.id);
  res.status(204).end();
});

api.get('/reporte', async (req, res) => {
  res.json(await store.reporte({ desde: fechaQuery(req.query.desde), hasta: fechaQuery(req.query.hasta) }));
});
api.get('/reporte.csv', async (req, res) => {
  const rep = await store.reporte({ desde: fechaQuery(req.query.desde), hasta: fechaQuery(req.query.hasta) });
  const resumen = req.query.tipo === 'resumen';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo(resumen ? 'resumen' : 'detalle', rep)}"`);
  res.send(resumen ? store.csvResumen(rep) : store.csvDetalle(rep));
});
api.get('/exportar', async (req, res) => {
  const datos = await store.exportar();
  res.setHeader('Content-Disposition', `attachment; filename="tareo-respaldo_${datos.exportadoEn.slice(0, 10)}.json"`);
  res.json(datos);
});

api.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// Manejo centralizado de errores (Express 5 captura también los rechazos async).
// Se monta a nivel de app para cubrir también los errores de express.json().
export function manejarErrores(err, req, res, next) {
  const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
  const inesperado = status >= 500 && status !== 503; // 503 = falta configurar el almacenamiento (mensaje ya claro)
  if (inesperado) console.error(err);
  res.status(status).json({ error: inesperado ? `Error interno: ${err.message}` : err.message });
}

export default api;
