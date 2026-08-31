import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Base de datos de archivos en una carpeta temporal, aislada por ejecución.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tareo-test-'));
process.env.DATA_DIR = dir;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.APP_PASSWORD;

const store = await import('../src/store.js');
const { default: app } = await import('../app.js');

const persona = await store.crear('personas', { nombre: 'Ana Pérez', rol: 'QA', email: 'ana@empresa.com' });
const persona2 = await store.crear('personas', { nombre: 'Luis Gómez', rol: 'Developer' });
const cliente = await store.crear('clientes', { nombre: 'Minera Andes' });
const cliente2 = await store.crear('clientes', { nombre: 'Banco Sur' });

test('roles disponibles y archivos de la base de datos', async () => {
  assert.deepEqual(store.ROLES, ['QA', 'Implementador', 'Producto', 'Developer', 'Soporte', 'Jefe de Proyectos']);
  assert.deepEqual(store.TIPOS_CATALOGO, ['personas', 'clientes']);
  const archivos = await fs.readdir(dir);
  assert.ok(archivos.includes('personas.json') && archivos.includes('clientes.json'));
  assert.ok(!archivos.includes('actividades.json'));
});

test('catálogos: validaciones y duplicados', async () => {
  await assert.rejects(store.crear('personas', { nombre: 'X', rol: 'QA' }), /entre 2 y 80/);
  await assert.rejects(store.crear('personas', { nombre: 'Pedro', rol: 'Gerente' }), /Rol inválido/);
  await assert.rejects(store.crear('personas', { nombre: 'Pedro', rol: 'QA', email: 'no-es-correo' }), /Correo inválido/);
  await assert.rejects(store.crear('clientes', { nombre: '  minera   andes ' }), { status: 409 });
  const soporte = await store.crear('personas', { nombre: 'Rosa Soporte', rol: 'Soporte' });
  assert.equal(soporte.rol, 'Soporte');
  const jefe = await store.crear('personas', { nombre: 'Elena Jefa', rol: 'Jefe de Proyectos' });
  assert.equal(jefe.rol, 'Jefe de Proyectos');
  await store.eliminar('personas', jefe.id);
  const editado = await store.editar('clientes', cliente2.id, { nombre: 'Banco del Sur', activo: false });
  assert.equal(editado.nombre, 'Banco del Sur');
  assert.equal(editado.activo, false);
  await store.editar('clientes', cliente2.id, { activo: true });
  await store.eliminar('personas', soporte.id);
});

test('tareo: cálculo de horas, validaciones y cruces', async () => {
  const t = await store.crearTareo({ personaId: persona.id, clienteId: cliente.id, fecha: '2026-08-03', inicio: '09:00', fin: '11:30', descripcion: '  Setup  ambiente ' });
  assert.equal(t.horas, 2.5);
  assert.equal(t.rol, 'QA'); // rol por defecto de la persona
  assert.equal(t.descripcion, 'Setup ambiente');
  assert.equal(t.clienteNombre, 'Minera Andes');
  assert.equal('actividadId' in t, false);

  await assert.rejects(store.crearTareo({ personaId: persona.id, clienteId: cliente.id, fecha: '2026-08-03', inicio: '10:00', fin: '09:00' }), /mayor que la hora de inicio/);
  await assert.rejects(store.crearTareo({ personaId: persona.id, clienteId: cliente.id, fecha: '2026-08-03', inicio: '11:00', fin: '12:00' }), { status: 409 });
  await assert.rejects(store.crearTareo({ personaId: persona.id, clienteId: 'nope', fecha: '2026-08-03', inicio: '13:00', fin: '14:00' }), /cliente válido/);
  await assert.rejects(store.crearTareo({ personaId: persona.id, clienteId: cliente.id, fecha: '2026-13-03', inicio: '13:00', fin: '14:00' }), /Fecha inválida/);

  // Contiguo (termina 11:30, empieza 11:30) no es cruce.
  const t2 = await store.crearTareo({ personaId: persona.id, clienteId: cliente2.id, rol: 'Producto', fecha: '2026-08-03', inicio: '11:30', fin: '12:15' });
  assert.equal(t2.horas, 0.75);
  assert.equal(t2.rol, 'Producto');

  // Edición parcial: conserva rol y cliente si no se envían.
  const editado = await store.editarTareo(persona.id, t2.id, { fecha: '2026-08-03', inicio: '11:30', fin: '12:30' });
  assert.equal(editado.horas, 1);
  assert.equal(editado.rol, 'Producto');
  assert.equal(editado.clienteId, cliente2.id);
  await assert.rejects(store.editarTareo(persona.id, t2.id, { inicio: '11:00', fin: '12:30' }), { status: 409 });
  await assert.rejects(store.editarTareo(persona.id, t2.id, { personaId: persona2.id }), /cambiar la persona/);
});

test('reporte agrega por persona, cliente y rol', async () => {
  await store.crearTareo({ personaId: persona2.id, clienteId: cliente.id, fecha: '2026-08-04', inicio: '08:00', fin: '16:00' });
  await store.crearTareo({ personaId: persona2.id, clienteId: cliente.id, fecha: '2026-07-30', inicio: '08:00', fin: '09:00' });

  const r = await store.reporte({ desde: '2026-08-01', hasta: '2026-08-31' });
  assert.equal(r.totalTareos, 3);
  assert.equal(r.totalHoras, 11.5);
  assert.deepEqual(r.porPersona.map((p) => [p.persona, p.horas]), [['Luis Gómez', 8], ['Ana Pérez', 3.5]]);
  assert.deepEqual(r.porCliente.map((c) => [c.cliente, c.horas]), [['Minera Andes', 10.5], ['Banco del Sur', 1]]);
  assert.deepEqual(r.porRol.map((x) => [x.rol, x.horas]), [['Developer', 8], ['QA', 2.5], ['Producto', 1]]);
  assert.equal(r.personaCliente.find((x) => x.persona === 'Ana Pérez' && x.cliente === 'Minera Andes').horas, 2.5);
  assert.deepEqual(r.personaRol.map((x) => [x.persona, x.rol, x.horas]), [['Luis Gómez', 'Developer', 8], ['Ana Pérez', 'QA', 2.5], ['Ana Pérez', 'Producto', 1]]);
  assert.match(store.csvResumen(r), /Persona × rol,Ana Pérez,,Producto,1,1\.00/);
  assert.equal('porActividad' in r, false);

  const todo = await store.reporte({});
  assert.equal(todo.totalTareos, 4);

  const csv = store.csvDetalle(r);
  assert.ok(csv.startsWith('﻿Fecha,Persona,Rol,Cliente,Descripción,Inicio,Fin,Horas'));
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(store.csvResumen(r), /TOTAL,,,,3,11\.50/);
});

test('en Vercel sin Blob Store el modo es sin-configurar y no intenta escribir en disco', () => {
  const salida = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const db = await import('./src/db.js');
    let error = '';
    try { await db.leer('personas.json', []); } catch (e) { error = e.status + ' ' + e.message; }
    console.log(JSON.stringify({ modo: db.MODO, error }));
  `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, VERCEL: '1', BLOB_READ_WRITE_TOKEN: '' }, encoding: 'utf8' });
  const r = JSON.parse(salida.trim().split('\n').pop());
  assert.equal(r.modo, 'sin-configurar');
  assert.match(r.error, /^503 Falta conectar el Blob Store/);

  // Con BLOB_STORE_ID (conexión OIDC, la forma actual de Vercel) el modo pasa a vercel-blob.
  const salidaOidc = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const db = await import('./src/db.js');
    console.log(JSON.stringify({ modo: db.MODO, auth: db.BLOB_AUTH }));
  `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, VERCEL: '1', BLOB_READ_WRITE_TOKEN: '', BLOB_STORE_ID: 'store_abc' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(salidaOidc.trim().split('\n').pop()), { modo: 'vercel-blob', auth: 'oidc' });
});

test('no se elimina un catálogo en uso; sí uno libre', async () => {
  await assert.rejects(store.eliminar('clientes', cliente.id), { status: 409 });
  const libre = await store.crear('clientes', { nombre: 'Temporal SAC' });
  await store.eliminar('clientes', libre.id);
  assert.ok(!(await store.listar('clientes')).find((c) => c.id === libre.id));
  await assert.rejects(store.eliminar('clientes', 'no-existe'), { status: 404 });
});

test('API HTTP: config, catálogos, tareos, reporte csv, páginas y errores JSON', async () => {
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(cfg.roles, ['QA', 'Implementador', 'Producto', 'Developer', 'Soporte', 'Jefe de Proyectos']);
    assert.equal(cfg.almacenamiento, 'archivos');

    const cat = await (await fetch(`${base}/api/catalogos`)).json();
    assert.equal(cat.personas.length, 2);
    assert.equal('actividades' in cat, false);

    const res = await fetch(`${base}/api/tareos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personaId: persona.id, clienteId: cliente.id, fecha: '2026-08-05', inicio: '14:00', fin: '15:00' }) });
    assert.equal(res.status, 201);
    const creado = await res.json();
    assert.equal(creado.horas, 1);

    const mal = await fetch(`${base}/api/tareos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{rota' });
    assert.equal(mal.status, 400);
    assert.ok((await mal.json()).error);

    const lista = await (await fetch(`${base}/api/tareos?personaId=${persona.id}&desde=2026-08-05&hasta=2026-08-05`)).json();
    assert.equal(lista.length, 1);

    const csv = await fetch(`${base}/api/reporte.csv?desde=2026-08-01&hasta=2026-08-31`);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /detalle_2026-08-01_2026-08-31\.csv/);

    const borrar = await fetch(`${base}/api/tareos/${creado.id}?personaId=${persona.id}`, { method: 'DELETE' });
    assert.equal(borrar.status, 204);

    const noExiste = await fetch(`${base}/api/nada`);
    assert.equal(noExiste.status, 404);
    assert.equal((await noExiste.json()).error, 'Ruta no encontrada.');

    for (const [ruta, marca] of [['/', 'data-pagina="tareo"'], ['/personas', 'data-pagina="personas"'], ['/clientes', 'data-pagina="clientes"'], ['/reporte', 'data-pagina="reporte"']]) {
      const html = await fetch(`${base}${ruta}`);
      assert.equal(html.status, 200, ruta);
      assert.match(await html.text(), new RegExp(marca), ruta);
    }

    const exp = await (await fetch(`${base}/api/exportar`)).json();
    assert.equal(exp.tareos.length, 4);
  } finally {
    servidor.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
