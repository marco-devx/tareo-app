/* Tareo de horas — frontend (vanilla JS, sin dependencias).
   Una sola hoja de JS para las cuatro páginas: / (tareo), /personas, /clientes y /reporte.
   La página se identifica por <body data-pagina="..."> */
(() => {
  'use strict';

  const LS = { persona: 'tareo.personaId', password: 'tareo.password' };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const fmtH = (n) => (Number(n) || 0).toFixed(2);
  const pct = (parte, total) => (total ? `${Math.round((parte / total) * 100)}%` : '0%');
  const fechaLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hoy = () => fechaLocal();
  const fmtFecha = (iso) => {
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  };
  const minutos = (hhmm) => {
    if (!hhmm) return NaN;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };

  const pagina = document.body.dataset.pagina || 'tareo';
  const estado = {
    config: null,
    catalogos: { personas: [], clientes: [] },
    personaId: localStorage.getItem(LS.persona) || '',
    editando: null,
    mes: hoy().slice(0, 7),
    montada: false,
  };

  // ---------------- utilidades ----------------
  function aviso(mensaje, tipo = '') {
    const el = document.createElement('div');
    el.className = `aviso ${tipo}`;
    el.textContent = mensaje;
    $('#avisos').appendChild(el);
    setTimeout(() => el.remove(), tipo === 'error' ? 6000 : 3500);
  }

  function cabecerasAuth() {
    const h = {};
    const pw = localStorage.getItem(LS.password);
    if (pw) h['x-app-password'] = pw;
    return h;
  }

  async function api(ruta, opciones = {}) {
    const headers = { ...cabecerasAuth() };
    if (opciones.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api${ruta}`, {
      method: opciones.method || 'GET',
      headers,
      body: opciones.body !== undefined ? JSON.stringify(opciones.body) : undefined,
    });
    if (res.status === 204) return null;
    const esJson = (res.headers.get('content-type') || '').includes('application/json');
    const datos = esJson ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((esJson && datos?.error) || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return datos;
  }

  async function descargar(ruta, nombreArchivo) {
    const res = await fetch(`/api${ruta}`, { headers: cabecerasAuth() });
    if (!res.ok) throw new Error(`No se pudo descargar (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function conBoton(boton, fn) {
    const texto = boton.textContent;
    boton.disabled = true;
    try {
      return await fn();
    } catch (e) {
      aviso(e.message, 'error');
      if (e.status === 401) {
        localStorage.removeItem(LS.password);
        mostrarGatePassword(e.message);
      }
    } finally {
      boton.disabled = false;
      boton.textContent = texto;
    }
  }

  const opciones = (items, seleccionado, placeholder) =>
    (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    items.map((i) => `<option value="${esc(i.id)}" ${i.id === seleccionado ? 'selected' : ''}>${esc(i.nombre)}</option>`).join('');

  const activos = (tipo) => estado.catalogos[tipo].filter((i) => i.activo);
  const persona = () => estado.catalogos.personas.find((p) => p.id === estado.personaId);
  const nombreDe = (tipo, id) => estado.catalogos[tipo].find((i) => i.id === id)?.nombre ?? '';

  async function cargarCatalogos() {
    estado.catalogos = await api('/catalogos');
  }

  // ---------------- arranque ----------------
  async function iniciar() {
    try {
      estado.config = await api('/config');
    } catch (e) {
      aviso('No se pudo conectar con el servidor.', 'error');
      return;
    }
    $$('select[data-roles]').forEach((sel) => {
      sel.innerHTML = estado.config.roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    });
    if (estado.config.almacenamiento === 'sin-configurar' && !$('#banner-config')) {
      const b = document.createElement('div');
      b.id = 'banner-config';
      b.className = 'banner-error';
      b.innerHTML = '<b>La base de datos no está conectada.</b> En Vercel: Storage → tu Blob Store → Connect Project (elige el proyecto y sus ambientes) y luego Redeploy. Revisa <a href="/api/health" target="_blank">/api/health</a>.';
      $('main').prepend(b);
    }
    if (estado.config.requierePassword && !localStorage.getItem(LS.password)) return mostrarGatePassword();
    try {
      await cargarCatalogos();
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem(LS.password);
        return mostrarGatePassword(e.message);
      }
      aviso(e.message, 'error');
      return;
    }
    $('#app').hidden = false;
    const p = PAGINAS[pagina];
    if (!p) return;
    if (!estado.montada) {
      estado.montada = true;
      p.montar();
    }
    p.render();
  }

  // ---------------- contraseña compartida (opcional) ----------------
  function mostrarGatePassword(error) {
    let gate = $('#gate-password');
    if (!gate) {
      gate = document.createElement('section');
      gate.id = 'gate-password';
      gate.className = 'tarjeta gate';
      gate.innerHTML = `<h2>Acceso</h2>
        <p class="ayuda">Ingresa la contraseña compartida del equipo. Se recordará en este navegador.</p>
        <form class="fila"><input type="password" required autocomplete="current-password" placeholder="Contraseña"><button class="btn primario">Entrar</button></form>
        <p class="error" hidden></p>`;
      $('main').prepend(gate);
      gate.querySelector('form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const input = gate.querySelector('input');
        localStorage.setItem(LS.password, input.value);
        input.value = '';
        gate.hidden = true;
        await iniciar();
      });
    }
    $('#app').hidden = true;
    gate.hidden = false;
    const err = gate.querySelector('.error');
    err.hidden = !error;
    err.textContent = error || '';
    gate.querySelector('input').focus();
  }

  // ======================= PÁGINA: TAREO (/) =======================
  function fijarPersona(id) {
    estado.personaId = id;
    if (id) localStorage.setItem(LS.persona, id);
    else localStorage.removeItem(LS.persona);
  }

  function marcarRol(rol) {
    const radio = rol && $(`#f-rol input[value="${CSS.escape(rol)}"]`);
    if (radio) radio.checked = true;
  }

  function renderFormulario() {
    const personas = activos('personas');
    if (estado.personaId && !personas.some((p) => p.id === estado.personaId)) fijarPersona('');
    const selP = $('#f-persona');
    selP.innerHTML = personas.length ? opciones(personas, estado.personaId, 'Selecciona tu nombre…') : '<option value="">(Aún no hay personas en la lista)</option>';
    selP.disabled = !personas.length;
    $('#ayuda-personas').hidden = personas.length > 0;

    const rolActual = estado.editando?.rol ?? persona()?.rol;
    $('#f-rol').innerHTML = estado.config.roles
      .map((r) => `<label><input type="radio" name="rol" value="${esc(r)}" ${r === rolActual ? 'checked' : ''}>${esc(r)}</label>`)
      .join('');

    const clientes = activos('clientes');
    const selC = $('#f-cliente');
    selC.innerHTML = clientes.length ? opciones(clientes, estado.editando?.clienteId ?? selC.value, 'Selecciona un cliente…') : '<option value="">(Aún no hay clientes en la lista)</option>';
    selC.disabled = !clientes.length;
    $('#ayuda-clientes').hidden = clientes.length > 0;

    if (!$('#f-fecha').value) $('#f-fecha').value = hoy();
    $('#mes-mis-tareos').value = estado.mes;
    actualizarHoras();
  }

  function actualizarHoras() {
    const ini = minutos($('#f-inicio').value);
    const fin = minutos($('#f-fin').value);
    const out = $('#f-horas');
    if (Number.isNaN(ini) || Number.isNaN(fin)) {
      out.textContent = '0.00 h';
      out.style.color = '';
      return;
    }
    const h = (fin - ini) / 60;
    out.textContent = h > 0 ? `${fmtH(h)} h` : 'Fin debe ser mayor a inicio';
    out.style.color = h > 0 ? '' : 'var(--error)';
  }

  function datosFormulario() {
    return {
      personaId: $('#f-persona').value,
      rol: $('#f-rol input:checked')?.value,
      clienteId: $('#f-cliente').value,
      descripcion: $('#f-descripcion').value.trim(),
      fecha: $('#f-fecha').value,
      inicio: $('#f-inicio').value,
      fin: $('#f-fin').value,
    };
  }

  function salirEdicion() {
    estado.editando = null;
    $('#titulo-form').textContent = 'Nuevo tareo';
    $('#btn-guardar').textContent = 'Guardar tareo';
    $('#btn-cancelar-edicion').hidden = true;
    $('#f-descripcion').value = '';
    $('#f-inicio').value = '';
    $('#f-fin').value = '';
    actualizarHoras();
  }

  function entrarEdicion(t) {
    estado.editando = t;
    $('#titulo-form').textContent = `Editando tareo del ${fmtFecha(t.fecha)}`;
    $('#btn-guardar').textContent = 'Guardar cambios';
    $('#btn-cancelar-edicion').hidden = false;
    marcarRol(t.rol);
    $('#f-cliente').value = t.clienteId;
    $('#f-descripcion').value = t.descripcion || '';
    $('#f-fecha').value = t.fecha;
    $('#f-inicio').value = t.inicio;
    $('#f-fin').value = t.fin;
    actualizarHoras();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function cargarMisTareos() {
    const cont = $('#mis-tareos');
    if (!estado.personaId) {
      cont.innerHTML = '<p class="vacio">Selecciona tu nombre en el paso 1 para ver tus tareos.</p>';
      return;
    }
    cont.innerHTML = '<p class="vacio">Cargando…</p>';
    try {
      const tareos = await api(`/tareos?personaId=${encodeURIComponent(estado.personaId)}&desde=${estado.mes}-01&hasta=${estado.mes}-31`);
      renderMisTareos(tareos);
    } catch (e) {
      cont.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  function renderMisTareos(tareos) {
    const cont = $('#mis-tareos');
    cont.dataset.tareos = JSON.stringify(tareos);
    if (!tareos.length) {
      cont.innerHTML = '<p class="vacio">No tienes tareos registrados en este mes.</p>';
      return;
    }
    const total = tareos.reduce((s, t) => s + t.horas, 0);
    const filas = tareos
      .map(
        (t) => `<tr data-id="${esc(t.id)}">
          <td>${fmtFecha(t.fecha)}</td>
          <td>${esc(nombreDe('clientes', t.clienteId) || t.clienteNombre)}${t.descripcion ? `<div class="descr">${esc(t.descripcion)}</div>` : ''}</td>
          <td><span class="badge rol">${esc(t.rol)}</span></td>
          <td class="num">${t.inicio}–${t.fin}</td>
          <td class="num">${fmtH(t.horas)}</td>
          <td><div class="acciones-fila">
            <button class="btn chico" data-accion="editar">Editar</button>
            <button class="btn chico peligro" data-accion="eliminar">Eliminar</button>
          </div></td>
        </tr>`,
      )
      .join('');
    cont.innerHTML = `<div class="tabla-scroll"><table class="tabla">
      <thead><tr><th>Fecha</th><th>Cliente</th><th>Rol</th><th class="num">Horario</th><th class="num">Horas</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr class="total"><td colspan="4">Total del mes (${tareos.length} tareos)</td><td class="num">${fmtH(total)}</td><td></td></tr></tfoot>
    </table></div>`;
  }

  function confirmarEnDosPasos(btn) {
    btn.textContent = '¿Seguro? Sí, eliminar';
    btn.dataset.accion = 'confirmar-eliminar';
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.accion === 'confirmar-eliminar') {
        btn.textContent = 'Eliminar';
        btn.dataset.accion = 'eliminar';
      }
    }, 4000);
  }

  const paginaTareo = {
    montar() {
      $('#f-inicio').addEventListener('input', actualizarHoras);
      $('#f-fin').addEventListener('input', actualizarHoras);
      $('#btn-cancelar-edicion').addEventListener('click', salirEdicion);

      $('#f-persona').addEventListener('change', (ev) => {
        if (estado.editando) {
          aviso('No se puede cambiar la persona mientras editas un tareo.', 'error');
          ev.target.value = estado.personaId;
          return;
        }
        fijarPersona(ev.target.value);
        marcarRol(persona()?.rol);
        cargarMisTareos();
      });

      $('#mes-mis-tareos').addEventListener('change', (ev) => {
        if (!ev.target.value) return;
        estado.mes = ev.target.value;
        cargarMisTareos();
      });

      $('#form-tareo').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const datos = datosFormulario();
        if (!datos.personaId) return aviso('Selecciona tu nombre en el paso 1.', 'error');
        if (!datos.rol) return aviso('Selecciona un rol.', 'error');
        if (!datos.clienteId) return aviso('Selecciona un cliente.', 'error');
        if (minutos(datos.fin) <= minutos(datos.inicio)) return aviso('La hora de fin debe ser mayor que la de inicio.', 'error');
        await conBoton($('#btn-guardar'), async () => {
          if (estado.editando) {
            await api(`/tareos/${estado.editando.id}`, { method: 'PUT', body: datos });
            aviso('Tareo actualizado.', 'ok');
            salirEdicion();
          } else {
            const t = await api('/tareos', { method: 'POST', body: datos });
            aviso(`Tareo guardado: ${fmtH(t.horas)} h en ${t.clienteNombre}.`, 'ok');
            // Deja listo el siguiente tramo: empieza donde terminó este.
            $('#f-inicio').value = t.fin;
            $('#f-fin').value = '';
            $('#f-descripcion').value = '';
            actualizarHoras();
          }
          if (datos.fecha.slice(0, 7) !== estado.mes) {
            estado.mes = datos.fecha.slice(0, 7);
            $('#mes-mis-tareos').value = estado.mes;
          }
          await cargarMisTareos();
        });
      });

      $('#mis-tareos').addEventListener('click', async (ev) => {
        const btn = ev.target.closest('button[data-accion]');
        if (!btn) return;
        const fila = btn.closest('tr');
        const tareos = JSON.parse($('#mis-tareos').dataset.tareos || '[]');
        const t = tareos.find((x) => x.id === fila.dataset.id);
        if (!t) return;
        const accion = btn.dataset.accion;
        if (accion === 'editar') return entrarEdicion(t);
        if (accion === 'eliminar') return confirmarEnDosPasos(btn);
        if (accion === 'confirmar-eliminar') {
          await conBoton(btn, async () => {
            await api(`/tareos/${t.id}?personaId=${encodeURIComponent(t.personaId)}`, { method: 'DELETE' });
            if (estado.editando?.id === t.id) salirEdicion();
            aviso('Tareo eliminado.', 'ok');
            await cargarMisTareos();
          });
        }
      });
    },
    render() {
      renderFormulario();
      cargarMisTareos();
    },
  };

  // ======================= PÁGINAS: PERSONAS / CLIENTES =======================
  const META = {
    personas: { columnas: ['Nombre', 'Rol por defecto', 'Correo'], vacio: 'Aún no hay personas. Agrega la primera con el formulario de arriba.' },
    clientes: { columnas: ['Nombre'], vacio: 'Aún no hay clientes. Agrega el primero con el formulario de arriba.' },
  };

  function filaCatalogo(tipo, it, editando) {
    const esPersona = tipo === 'personas';
    const estadoHtml = `<span class="badge ${it.activo ? 'ok' : 'off'}">${it.activo ? 'Activo' : 'Inactivo'}</span>`;
    if (editando) {
      return `<tr data-id="${esc(it.id)}" class="editando">
        <td><input name="nombre" value="${esc(it.nombre)}" required minlength="2" maxlength="80"></td>
        ${esPersona ? `<td><select name="rol">${estado.config.roles.map((r) => `<option ${r === it.rol ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></td><td><input name="email" type="email" value="${esc(it.email || '')}" placeholder="opcional"></td>` : ''}
        <td>${estadoHtml}</td>
        <td><div class="acciones-fila"><button class="btn chico primario" data-accion="guardar">Guardar</button><button class="btn chico" data-accion="cancelar">Cancelar</button></div></td>
      </tr>`;
    }
    return `<tr data-id="${esc(it.id)}" class="${it.activo ? '' : 'apagado'}">
      <td>${esc(it.nombre)}</td>
      ${esPersona ? `<td><span class="badge rol">${esc(it.rol)}</span></td><td>${esc(it.email || '—')}</td>` : ''}
      <td>${estadoHtml}</td>
      <td><div class="acciones-fila">
        <button class="btn chico" data-accion="editar">Editar</button>
        <button class="btn chico" data-accion="toggle">${it.activo ? 'Desactivar' : 'Activar'}</button>
        <button class="btn chico peligro" data-accion="eliminar">Eliminar</button>
      </div></td>
    </tr>`;
  }

  function renderCatalogo(tipo, editandoId = null) {
    const cont = $('#lista');
    const items = estado.catalogos[tipo];
    if (!items.length) {
      cont.innerHTML = `<p class="vacio">${META[tipo].vacio}</p>`;
      return;
    }
    cont.innerHTML = `<div class="tabla-scroll"><table class="tabla">
      <thead><tr>${META[tipo].columnas.map((c) => `<th>${c}</th>`).join('')}<th>Estado</th><th></th></tr></thead>
      <tbody>${items.map((it) => filaCatalogo(tipo, it, it.id === editandoId)).join('')}</tbody>
    </table></div>`;
    if (editandoId) cont.querySelector('tr.editando input[name="nombre"]')?.focus();
  }

  function paginaCatalogo(tipo) {
    const singular = tipo === 'personas' ? 'Persona' : 'Cliente';
    return {
      montar() {
        const form = $('#form-catalogo');
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const datos = Object.fromEntries(new FormData(form).entries());
          await conBoton(form.querySelector('button'), async () => {
            const nuevo = await api(`/${tipo}`, { method: 'POST', body: datos });
            form.reset();
            aviso(`${singular} "${nuevo.nombre}" agregado.`, 'ok');
            await cargarCatalogos();
            renderCatalogo(tipo);
          });
        });

        $('#lista').addEventListener('click', async (ev) => {
          const btn = ev.target.closest('button[data-accion]');
          if (!btn) return;
          const fila = btn.closest('tr');
          const id = fila.dataset.id;
          const item = estado.catalogos[tipo].find((i) => i.id === id);
          if (!item) return;
          const accion = btn.dataset.accion;
          if (accion === 'editar') return renderCatalogo(tipo, id);
          if (accion === 'cancelar') return renderCatalogo(tipo);
          if (accion === 'eliminar') return confirmarEnDosPasos(btn);
          const cambios = {};
          if (accion === 'guardar') fila.querySelectorAll('input, select').forEach((el) => (cambios[el.name] = el.value));
          if (accion === 'toggle') cambios.activo = !item.activo;
          await conBoton(btn, async () => {
            if (accion === 'confirmar-eliminar') {
              await api(`/${tipo}/${id}`, { method: 'DELETE' });
              aviso(`"${item.nombre}" eliminado.`, 'ok');
            } else {
              await api(`/${tipo}/${id}`, { method: 'PUT', body: cambios });
              aviso(accion === 'toggle' ? `"${item.nombre}" ${item.activo ? 'desactivado' : 'activado'}.` : 'Guardado.', 'ok');
            }
            await cargarCatalogos();
            renderCatalogo(tipo);
          });
        });

        // Enter en un campo de edición = guardar
        $('#lista').addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter') return;
          const fila = ev.target.closest('tr.editando');
          if (!fila) return;
          ev.preventDefault();
          fila.querySelector('button[data-accion="guardar"]')?.click();
        });
      },
      render() {
        renderCatalogo(tipo);
      },
    };
  }

  // ======================= PÁGINA: REPORTE =======================
  function rango(tipo) {
    const d = new Date();
    if (tipo === 'mes') return [fechaLocal(new Date(d.getFullYear(), d.getMonth(), 1)), hoy()];
    if (tipo === 'mes-anterior') return [fechaLocal(new Date(d.getFullYear(), d.getMonth() - 1, 1)), fechaLocal(new Date(d.getFullYear(), d.getMonth(), 0))];
    if (tipo === 'semana') return [fechaLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6)), hoy()];
    return ['', ''];
  }

  const queryReporte = () => {
    const q = new URLSearchParams();
    if ($('#r-desde').value) q.set('desde', $('#r-desde').value);
    if ($('#r-hasta').value) q.set('hasta', $('#r-hasta').value);
    return q.toString();
  };
  const sufijoArchivo = () => `${$('#r-desde').value || 'inicio'}_${$('#r-hasta').value || 'hoy'}`;

  async function generarReporte() {
    const cont = $('#reporte');
    cont.innerHTML = '<div class="tarjeta"><p class="vacio">Generando…</p></div>';
    try {
      renderReporte(await api(`/reporte?${queryReporte()}`));
    } catch (e) {
      cont.innerHTML = `<div class="tarjeta"><p class="error">${esc(e.message)}</p></div>`;
    }
  }

  const kpi = (nombre, valor) => `<div class="kpi"><div class="valor">${valor}</div><div class="nombre">${nombre}</div></div>`;
  const barra = (parte, total) => `<div class="barra"><span style="width:${total ? Math.round((parte / total) * 100) : 0}%"></span></div>`;

  function tablaResumen(cabecera, filas, total) {
    const conExtra = filas[0]?.extra !== undefined;
    const cuerpo = filas
      .map((f) => `<tr><td>${esc(f.nombre)}</td>${conExtra ? `<td>${f.extra}</td>` : ''}<td class="num">${f.tareos}</td><td class="num">${fmtH(f.horas)}</td><td class="num">${pct(f.horas, total)}</td><td>${barra(f.horas, total)}</td></tr>`)
      .join('');
    return `<div class="tabla-scroll"><table class="tabla">
      <thead><tr><th>${cabecera}</th>${conExtra ? '<th>Rol</th>' : ''}<th class="num">Tareos</th><th class="num">Horas</th><th class="num">%</th><th></th></tr></thead>
      <tbody>${cuerpo}</tbody>
      <tfoot><tr class="total"><td colspan="${conExtra ? 2 : 1}">Total</td><td class="num">${filas.reduce((s, f) => s + f.tareos, 0)}</td><td class="num">${fmtH(total)}</td><td class="num">100%</td><td></td></tr></tfoot>
    </table></div>`;
  }

  function matriz(celdas, filaKey, filaNombre, colKey, colNombre, ordenFilas, ordenCols) {
    const filas = ordenFilas.map((f) => ({ id: f[filaKey], nombre: f[filaNombre] }));
    const cols = ordenCols.map((c) => ({ id: c[colKey], nombre: c[colNombre] }));
    const mapa = new Map(celdas.map((c) => [`${c[filaKey]}|${c[colKey]}`, c.horas]));
    const v = (f, c) => mapa.get(`${f}|${c}`) || 0;
    const cuerpo = filas
      .map((f) => `<tr><td>${esc(f.nombre)}</td>${cols.map((c) => `<td class="num">${mapa.has(`${f.id}|${c.id}`) ? fmtH(v(f.id, c.id)) : '·'}</td>`).join('')}<td class="num"><b>${fmtH(cols.reduce((s, c) => s + v(f.id, c.id), 0))}</b></td></tr>`)
      .join('');
    const granTotal = filas.reduce((s, f) => s + cols.reduce((x, c) => x + v(f.id, c.id), 0), 0);
    return `<div class="tabla-scroll"><table class="tabla">
      <thead><tr><th></th>${cols.map((c) => `<th class="num">${esc(c.nombre)}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>${cuerpo}</tbody>
      <tfoot><tr class="total"><td>Total</td>${cols.map((c) => `<td class="num">${fmtH(filas.reduce((s, f) => s + v(f.id, c.id), 0))}</td>`).join('')}<td class="num">${fmtH(granTotal)}</td></tr></tfoot>
    </table></div>`;
  }

  function renderReporte(r) {
    const cont = $('#reporte');
    const periodo = `${r.desde ? `desde ${fmtFecha(r.desde)}` : 'desde el inicio'} ${r.hasta ? `hasta ${fmtFecha(r.hasta)}` : 'hasta hoy'}`;
    if (!r.totalTareos) {
      cont.innerHTML = `<div class="tarjeta"><p class="vacio">No hay tareos ${periodo}.</p></div>`;
      return;
    }
    const T = r.totalHoras;
    const tarjeta = (titulo, html) => `<div class="tarjeta"><h3>${titulo}</h3>${html}</div>`;
    cont.innerHTML = `
      <p class="subtitulo-reporte">Periodo: ${periodo}. Generado el ${new Date(r.generadoEn).toLocaleString('es')}.</p>
      <div class="kpis">
        ${kpi('Horas totales', `${fmtH(T)} h`)}
        ${kpi('Tareos', r.totalTareos)}
        ${kpi('Personas', r.porPersona.length)}
        ${kpi('Clientes', r.porCliente.length)}
      </div>
      <div class="grid-2">
        ${tarjeta('Horas por persona', tablaResumen('Persona', r.porPersona.map((g) => ({ nombre: g.persona, extra: `<span class="badge rol">${esc(g.rol)}</span>`, tareos: g.tareos, horas: g.horas })), T))}
        ${tarjeta('Horas por cliente', tablaResumen('Cliente', r.porCliente.map((g) => ({ nombre: g.cliente, tareos: g.tareos, horas: g.horas })), T))}
        ${tarjeta('Horas por rol', tablaResumen('Rol', r.porRol.map((g) => ({ nombre: g.rol, tareos: g.tareos, horas: g.horas })), T))}
      </div>
      ${tarjeta('Persona × Cliente (horas)', matriz(r.personaCliente, 'personaId', 'persona', 'clienteId', 'cliente', r.porPersona, r.porCliente))}
      ${tarjeta('Persona × Rol (horas dedicadas por rol)', matriz(r.personaRol, 'personaId', 'persona', 'rol', 'rol', r.porPersona, r.porRol))}`;
  }

  const paginaReporte = {
    montar() {
      [$('#r-desde').value, $('#r-hasta').value] = rango('mes');
      $('#form-reporte').addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-rango]');
        if (!b) return;
        [$('#r-desde').value, $('#r-hasta').value] = rango(b.dataset.rango);
        generarReporte();
      });
      $('#form-reporte').addEventListener('submit', (ev) => {
        ev.preventDefault();
        generarReporte();
      });
      $('#btn-csv-detalle').addEventListener('click', (ev) => conBoton(ev.target, () => descargar(`/reporte.csv?${queryReporte()}`, `tareos_detalle_${sufijoArchivo()}.csv`)));
      $('#btn-csv-resumen').addEventListener('click', (ev) => conBoton(ev.target, () => descargar(`/reporte.csv?tipo=resumen&${queryReporte()}`, `tareos_resumen_${sufijoArchivo()}.csv`)));
      $('#btn-json').addEventListener('click', (ev) => conBoton(ev.target, () => descargar('/exportar', `tareo-respaldo_${hoy()}.json`)));
      $('#btn-imprimir').addEventListener('click', () => window.print());
    },
    render() {
      generarReporte();
    },
  };

  const PAGINAS = {
    tareo: paginaTareo,
    personas: paginaCatalogo('personas'),
    clientes: paginaCatalogo('clientes'),
    reporte: paginaReporte,
  };

  // Marca el enlace de la página actual en la navegación de administración.
  $$('.tabs a[data-pagina-link]').forEach((a) => a.classList.toggle('activa', a.dataset.paginaLink === pagina));

  iniciar();
})();
