// Reglas de negocio: catálogos (personas, clientes), tareos y reportes.
import { randomUUID } from 'node:crypto';
import * as db from './db.js';

export const ROLES = ['QA', 'Implementador', 'Producto', 'Developer', 'Soporte'];

const CLAVE = {
  personas: 'personas.json',
  clientes: 'clientes.json',
  tareos: (personaId) => `tareos/${personaId}.json`,
};

export class ErrorApp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

const ahora = () => new Date().toISOString();
const nuevoId = () => randomUUID().replace(/-/g, '').slice(0, 10);
const normalizar = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const mismoNombre = (a, b) => normalizar(a).localeCompare(normalizar(b), 'es', { sensitivity: 'base' }) === 0;
const redondear2 = (n) => Math.round(n * 100) / 100;

function validarNombre(nombre, etiqueta) {
  const n = normalizar(nombre);
  if (n.length < 2 || n.length > 80) throw new ErrorApp(400, `El nombre de ${etiqueta} debe tener entre 2 y 80 caracteres.`);
  return n;
}

function validarRol(rol) {
  if (!ROLES.includes(rol)) throw new ErrorApp(400, `Rol inválido. Opciones: ${ROLES.join(', ')}.`);
  return rol;
}

function validarEmail(email) {
  const e = normalizar(email).toLowerCase();
  if (!e) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ErrorApp(400, 'Correo inválido.');
  return e;
}

// ---------------- catálogos ----------------
const CATALOGOS = {
  personas: {
    clave: CLAVE.personas,
    etiqueta: 'la persona',
    campoTareo: 'personaId',
    semilla: () => [],
    campos: (d, existente) => ({
      rol: validarRol(d.rol ?? existente?.rol),
      email: validarEmail(d.email ?? existente?.email ?? ''),
    }),
  },
  clientes: {
    clave: CLAVE.clientes,
    etiqueta: 'el cliente',
    campoTareo: 'clienteId',
    semilla: () => [],
    campos: () => ({}),
  },
};

export const TIPOS_CATALOGO = Object.keys(CATALOGOS);

function definicion(tipo) {
  const c = CATALOGOS[tipo];
  if (!c) throw new ErrorApp(404, 'Catálogo desconocido.');
  return c;
}

export async function listar(tipo) {
  const c = definicion(tipo);
  const items = await db.leer(c.clave, null);
  if (items) return items;
  const semilla = c.semilla();
  if (semilla.length) await db.escribir(c.clave, semilla);
  return semilla;
}

export async function catalogos() {
  const [personas, clientes] = await Promise.all([listar('personas'), listar('clientes')]);
  return { personas, clientes };
}

export async function crear(tipo, datos) {
  const c = definicion(tipo);
  const nombre = validarNombre(datos.nombre, c.etiqueta);
  const extra = c.campos(datos);
  const item = { id: nuevoId(), nombre, ...extra, activo: true, creadoEn: ahora() };
  await db.actualizar(c.clave, c.semilla(), (items) => {
    if (items.some((i) => mismoNombre(i.nombre, nombre))) throw new ErrorApp(409, `Ya existe ${c.etiqueta} "${nombre}".`);
    items.push(item);
  });
  return item;
}

export async function editar(tipo, id, datos) {
  const c = definicion(tipo);
  let resultado;
  await db.actualizar(c.clave, c.semilla(), (items) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new ErrorApp(404, `No existe ${c.etiqueta}.`);
    if (datos.nombre !== undefined) {
      const nombre = validarNombre(datos.nombre, c.etiqueta);
      if (items.some((i) => i.id !== id && mismoNombre(i.nombre, nombre))) throw new ErrorApp(409, `Ya existe ${c.etiqueta} "${nombre}".`);
      item.nombre = nombre;
    }
    Object.assign(item, c.campos(datos, item));
    if (datos.activo !== undefined) item.activo = Boolean(datos.activo);
    item.actualizadoEn = ahora();
    resultado = item;
  });
  return resultado;
}

export async function eliminar(tipo, id) {
  const c = definicion(tipo);
  const todos = await listarTareos();
  const enUso = todos.filter((t) => t[c.campoTareo] === id).length;
  if (enUso > 0) throw new ErrorApp(409, `No se puede eliminar: tiene ${enUso} tareo(s) registrado(s). Desactívalo en su lugar.`);
  await db.actualizar(c.clave, c.semilla(), (items) => {
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw new ErrorApp(404, `No existe ${c.etiqueta}.`);
    items.splice(idx, 1);
  });
}

// ---------------- tareos ----------------
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const ordenTareo = (a, b) => (a.fecha + a.inicio).localeCompare(b.fecha + b.inicio);

function validarTareo(datos, cat) {
  const persona = cat.personas.find((p) => p.id === datos.personaId);
  if (!persona) throw new ErrorApp(400, 'Selecciona una persona válida.');
  const rol = validarRol(datos.rol ?? persona.rol);
  const cliente = cat.clientes.find((c) => c.id === datos.clienteId);
  if (!cliente) throw new ErrorApp(400, 'Selecciona un cliente válido.');
  const fecha = String(datos.fecha ?? '');
  if (!RE_FECHA.test(fecha) || Number.isNaN(Date.parse(fecha))) throw new ErrorApp(400, 'Fecha inválida (formato AAAA-MM-DD).');
  const inicio = String(datos.inicio ?? '');
  const fin = String(datos.fin ?? '');
  if (!RE_HORA.test(inicio) || !RE_HORA.test(fin)) throw new ErrorApp(400, 'Horas inválidas (formato HH:MM).');
  if (minutos(fin) <= minutos(inicio)) throw new ErrorApp(400, 'La hora de fin debe ser mayor que la hora de inicio.');
  const descripcion = normalizar(datos.descripcion ?? '').slice(0, 300);
  return {
    personaId: persona.id,
    personaNombre: persona.nombre,
    rol,
    clienteId: cliente.id,
    clienteNombre: cliente.nombre,
    descripcion,
    fecha,
    inicio,
    fin,
    horas: redondear2((minutos(fin) - minutos(inicio)) / 60),
  };
}

function verificarCruce(tareos, nuevo, ignorarId) {
  const cruce = tareos.find(
    (t) => t.id !== ignorarId && t.fecha === nuevo.fecha && minutos(t.inicio) < minutos(nuevo.fin) && minutos(nuevo.inicio) < minutos(t.fin),
  );
  if (cruce) throw new ErrorApp(409, `Se cruza con otro tareo del ${cruce.fecha} (${cruce.inicio}–${cruce.fin}, ${cruce.clienteNombre}).`);
}

export async function crearTareo(datos) {
  const base = validarTareo(datos, await catalogos());
  const tareo = { id: nuevoId(), ...base, creadoEn: ahora() };
  await db.actualizar(CLAVE.tareos(base.personaId), [], (tareos) => {
    verificarCruce(tareos, tareo);
    tareos.push(tareo);
    tareos.sort(ordenTareo);
  });
  return tareo;
}

export async function editarTareo(personaId, id, datos) {
  if (datos.personaId && datos.personaId !== personaId) {
    throw new ErrorApp(400, 'No se puede cambiar la persona de un tareo; elimínalo y créalo de nuevo.');
  }
  const cat = await catalogos();
  let resultado;
  await db.actualizar(CLAVE.tareos(personaId), [], (tareos) => {
    const idx = tareos.findIndex((t) => t.id === id);
    if (idx < 0) throw new ErrorApp(404, 'No existe el tareo.');
    // Los campos no enviados conservan su valor actual (edición parcial).
    const base = validarTareo({ ...tareos[idx], ...datos, personaId }, cat);
    const actualizado = { ...tareos[idx], ...base, actualizadoEn: ahora() };
    verificarCruce(tareos, actualizado, id);
    tareos[idx] = actualizado;
    tareos.sort(ordenTareo);
    resultado = actualizado;
  });
  return resultado;
}

export async function eliminarTareo(personaId, id) {
  await db.actualizar(CLAVE.tareos(personaId), [], (tareos) => {
    const idx = tareos.findIndex((t) => t.id === id);
    if (idx < 0) throw new ErrorApp(404, 'No existe el tareo.');
    tareos.splice(idx, 1);
  });
}

export async function listarTareos({ personaId, desde, hasta, clienteId } = {}) {
  const ids = personaId ? [personaId] : (await listar('personas')).map((p) => p.id);
  const listas = await Promise.all(ids.map((id) => db.leer(CLAVE.tareos(id), [])));
  return listas
    .flat()
    .filter((t) => (!desde || t.fecha >= desde) && (!hasta || t.fecha <= hasta) && (!clienteId || t.clienteId === clienteId))
    .sort(ordenTareo);
}

// ---------------- reportes ----------------
function enriquecer(t, cat) {
  // Usa el nombre actual del catálogo (por si se renombró) y conserva el guardado como respaldo.
  const p = cat.personas.find((x) => x.id === t.personaId);
  const c = cat.clientes.find((x) => x.id === t.clienteId);
  return {
    ...t,
    personaNombre: p?.nombre ?? t.personaNombre,
    personaRolActual: p?.rol ?? t.rol,
    clienteNombre: c?.nombre ?? t.clienteNombre,
  };
}

function agrupar(tareos, claveDe, etiquetaDe) {
  const grupos = new Map();
  for (const t of tareos) {
    const k = claveDe(t);
    const g = grupos.get(k) ?? { ...etiquetaDe(t), horas: 0, tareos: 0 };
    g.horas += t.horas;
    g.tareos += 1;
    grupos.set(k, g);
  }
  return [...grupos.values()]
    .map((g) => ({ ...g, horas: redondear2(g.horas) }))
    .sort((a, b) => b.horas - a.horas);
}

export async function reporte({ desde, hasta } = {}) {
  const cat = await catalogos();
  const tareos = (await listarTareos({ desde, hasta })).map((t) => enriquecer(t, cat));
  return {
    desde: desde || null,
    hasta: hasta || null,
    generadoEn: ahora(),
    totalHoras: redondear2(tareos.reduce((s, t) => s + t.horas, 0)),
    totalTareos: tareos.length,
    porPersona: agrupar(tareos, (t) => t.personaId, (t) => ({ personaId: t.personaId, persona: t.personaNombre, rol: t.personaRolActual })),
    porCliente: agrupar(tareos, (t) => t.clienteId, (t) => ({ clienteId: t.clienteId, cliente: t.clienteNombre })),
    porRol: agrupar(tareos, (t) => t.rol, (t) => ({ rol: t.rol })),
    personaCliente: agrupar(tareos, (t) => `${t.personaId}|${t.clienteId}`, (t) => ({ personaId: t.personaId, persona: t.personaNombre, clienteId: t.clienteId, cliente: t.clienteNombre })),
    personaRol: agrupar(tareos, (t) => `${t.personaId}|${t.rol}`, (t) => ({ personaId: t.personaId, persona: t.personaNombre, rol: t.rol })),
    tareos,
  };
}

const escaparCsv = (v) => {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const aCsv = (filas) => '\uFEFF' + filas.map((f) => f.map(escaparCsv).join(',')).join('\r\n') + '\r\n';

export function csvDetalle(rep) {
  const cab = ['Fecha', 'Persona', 'Rol', 'Cliente', 'Descripción', 'Inicio', 'Fin', 'Horas'];
  const filas = rep.tareos.map((t) => [t.fecha, t.personaNombre, t.rol, t.clienteNombre, t.descripcion, t.inicio, t.fin, t.horas.toFixed(2)]);
  return aCsv([cab, ...filas]);
}

export function csvResumen(rep) {
  const filas = [['Sección', 'Persona', 'Cliente', 'Rol', 'Tareos', 'Horas']];
  for (const g of rep.porPersona) filas.push(['Por persona', g.persona, '', g.rol, g.tareos, g.horas.toFixed(2)]);
  for (const g of rep.porCliente) filas.push(['Por cliente', '', g.cliente, '', g.tareos, g.horas.toFixed(2)]);
  for (const g of rep.porRol) filas.push(['Por rol', '', '', g.rol, g.tareos, g.horas.toFixed(2)]);
  for (const g of rep.personaCliente) filas.push(['Persona × cliente', g.persona, g.cliente, '', g.tareos, g.horas.toFixed(2)]);
  for (const g of rep.personaRol) filas.push(['Persona × rol', g.persona, '', g.rol, g.tareos, g.horas.toFixed(2)]);
  filas.push(['TOTAL', '', '', '', rep.totalTareos, rep.totalHoras.toFixed(2)]);
  return aCsv(filas);
}

/** Copia completa de la base de datos (respaldo). */
export async function exportar() {
  const cat = await catalogos();
  return { exportadoEn: ahora(), almacenamiento: db.MODO, ...cat, tareos: await listarTareos() };
}
