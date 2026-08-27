# Tareo de horas

Web app mínima para que un equipo pequeño (≈5 personas) registre **de qué hora a qué hora trabajó y para qué cliente**, y luego sacar un reporte de horas por persona, por cliente y por rol.

- **Monolito**: un solo servicio Node.js (Express 5) que sirve la web y la API.
- **Base de datos = archivos JSON**. No hay motor de base de datos: cada "tabla" es un archivo legible (`personas.json`, `clientes.json`, `tareos/<persona>.json`).
- **Costo cero en Vercel**: la app corre como una función y los archivos JSON viven en un **Vercel Blob Store** (plan Hobby gratuito).
- Sin login: cada persona elige su nombre de una lista y el navegador lo recuerda.

## Páginas

| URL | Para quién | Qué hace |
|---|---|---|
| `/` | Todo el equipo | **Tareo**: paso 1 elegir tu nombre de la lista y el rol (QA, Implementador, Producto, Developer, Soporte) → paso 2 cliente (+ descripción opcional) → paso 3 fecha, hora inicio y hora fin. Abajo, "Mis tareos" del mes con editar/eliminar. El nombre elegido se recuerda en el navegador. |
| `/personas` | Responsable (enlace oculto) | Cargar y mantener la lista de personas (nombre, rol por defecto, correo opcional). Nadie se registra por su cuenta. |
| `/clientes` | Responsable (enlace oculto) | Cargar y mantener la lista de clientes que se seleccionan en el paso 2. |
| `/reporte` | Responsable (enlace oculto) | Horas por persona, por cliente, por rol, matriz persona×cliente y detalle. Filtro por fechas, exportar CSV (abre en Excel), respaldo JSON e imprimir. |

Las páginas de administración no tienen enlace desde el tareo: se comparten por URL con quien corresponda (opcionalmente protegidas con `APP_PASSWORD`, ver abajo).

Reglas: la hora fin debe ser mayor a la de inicio; no se permiten tareos que se crucen en el mismo día para la misma persona; un cliente o persona con tareos no se puede eliminar (se desactiva).

## Correr en local

```bash
npm install
npm start          # http://localhost:4310 (cambia el puerto con PORT=xxxx)
# o con recarga automática:
npm run dev
```

Los datos quedan en `./data/` (configurable con `DATA_DIR`). Copia la carpeta y tienes el respaldo completo.

Pruebas: `npm test`.

## Publicar en Vercel (gratis)

1. Sube el proyecto a un repositorio (GitHub/GitLab/Bitbucket):
   ```bash
   git init && git add . && git commit -m "Tareo app"
   git remote add origin <url-del-repo> && git push -u origin main
   ```
2. En [vercel.com](https://vercel.com) → **Add New… → Project** → importa el repositorio. Vercel detecta *Express* automáticamente (Framework Preset: Express). Pulsa **Deploy**.
3. Crea el almacenamiento de archivos: en el proyecto → pestaña **Storage** → **Create Database → Blob** → nombre por ejemplo `tareo-db` → acceso **Private** (recomendado) → **Connect** al proyecto.
   Eso agrega sola la variable `BLOB_READ_WRITE_TOKEN` al proyecto.
   > Si creaste el store como *Public*, agrega la variable `BLOB_ACCESS=public` en Settings → Environment Variables.
4. (Opcional) Settings → Environment Variables → `APP_PASSWORD=<clave compartida>` para que solo el equipo pueda entrar (se pide una vez por navegador).
5. **Deployments → Redeploy** para que la función tome las variables nuevas. Listo: la URL `https://<proyecto>.vercel.app` ya guarda los datos en el Blob Store.

También sirve con la CLI: `npx vercel` (preview) y `npx vercel --prod`.

### Comprobar que la base de datos quedó conectada

Abre `https://<tu-app>.vercel.app/api/health`:

- `"almacenamiento": "vercel-blob"` → correcto, los datos se guardan en el Blob Store.
- `"almacenamiento": "sin-configurar"` (HTTP 503) → la función no ve `BLOB_READ_WRITE_TOKEN`. Revisa en Vercel:
  1. **Storage** → el store debe mostrar tu proyecto en *Connected Projects* (si no, **Connect Project**).
  2. **Settings → Environment Variables** → debe existir `BLOB_READ_WRITE_TOKEN` para *Production* (y Preview).
  3. **Deployments → ⋯ → Redeploy**: las variables solo se aplican a deploys nuevos.

Si ves `ENOENT ... mkdir '/var/task/data'` en una versión anterior de la app, es el mismo problema: sin token, intentó usar la carpeta local (de solo lectura en Vercel).

### ¿Cuánto cuesta?

Nada dentro del plan Hobby: incluye 5 GB de almacenamiento Blob, 100 000 operaciones simples y 10 000 operaciones avanzadas al mes. Esta app hace **una operación avanzada por cada guardado** (crear/editar/eliminar) y una simple por lectura; con 5 personas y dos meses de uso se está muy por debajo. Si se alcanzara el límite, Vercel bloquea Blob hasta el siguiente ciclo, pero **no cobra**.

### Al terminar los 2 meses

1. En la pestaña **Reporte** → **Respaldo JSON** (o `GET /api/exportar`) para descargar toda la base de datos.
2. Borra el Blob Store (Storage → … → Delete) y el proyecto en Vercel.

## Estructura

```
app.js              Entrada (Express). Vercel lo detecta; en local escucha en PORT.
src/db.js           Capa de almacenamiento: archivos locales o Vercel Blob (misma API).
src/store.js        Reglas de negocio: catálogos, tareos, validaciones, reportes, CSV.
src/routes.js       API HTTP bajo /api.
public/             Frontend: index.html (/), personas/, clientes/, reporte/ + styles.css + app.js.
data/               Base de datos local (JSON). Ignorada por git.
tests/              Pruebas (node --test).
```

## Base de datos (archivos)

| Archivo | Contenido |
|---|---|
| `personas.json` | `[{ id, nombre, rol, email, activo, creadoEn }]` |
| `clientes.json` | `[{ id, nombre, activo, creadoEn }]` |
| `tareos/<personaId>.json` | `[{ id, personaId, rol, clienteId, descripcion, fecha, inicio, fin, horas, … }]` |

Cada tareo guarda además los nombres de persona y cliente al momento de crearlo, así el archivo es legible por sí solo. Un archivo por persona evita que dos usuarios se pisen al escribir; en Vercel Blob además se usa escritura condicional por ETag con reintentos.

## API

| Método y ruta | Descripción |
|---|---|
| `GET /api/config` | Roles disponibles, si requiere contraseña, modo de almacenamiento |
| `GET /api/catalogos` | Personas y clientes |
| `GET/POST /api/personas`, `PUT/DELETE /api/personas/:id` | Igual para `/api/clientes` |
| `GET /api/tareos?personaId=&desde=&hasta=&clienteId=` | Lista de tareos |
| `POST /api/tareos` · `PUT /api/tareos/:id` · `DELETE /api/tareos/:id?personaId=` | Crear, editar, eliminar |
| `GET /api/reporte?desde=&hasta=` | Reporte agregado (JSON) |
| `GET /api/reporte.csv?desde=&hasta=&tipo=detalle\|resumen` | Reporte en CSV |
| `GET /api/exportar` | Respaldo completo (JSON) |

Si `APP_PASSWORD` está definida, todas las rutas (salvo `/api/config` y `/api/health`) exigen la cabecera `x-app-password`.

## Variables de entorno

| Variable | Uso |
|---|---|
| `PORT` | Puerto local (por defecto 4310) |
| `DATA_DIR` | Carpeta de los JSON en modo local (por defecto `./data`) |
| `APP_PASSWORD` | Contraseña compartida opcional |
| `BLOB_READ_WRITE_TOKEN` | La agrega Vercel al conectar el Blob Store; activa el modo nube |
| `BLOB_ACCESS` | `private` (por defecto) o `public`, según cómo se creó el store |
| `BLOB_PREFIX` | Carpeta dentro del store (por defecto `tareo-db`) |
