// Punto de entrada del monolito. Vercel detecta este archivo (Express) y lo despliega
// como una sola función; en local se ejecuta con `npm start`.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import api, { manejarErrores } from './src/routes.js';
import { MODO, DATA_DIR } from './src/db.js';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use('/api', api);
// En Vercel los estáticos de public/ se sirven por CDN y esta línea se ignora.
app.use(express.static(path.join(raiz, 'public'), { extensions: ['html'] }));
app.use((req, res) => res.status(404).send('No encontrado'));
app.use(manejarErrores);

export default app;

const ejecutadoDirecto = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ejecutadoDirecto) {
  const puerto = Number(process.env.PORT) || 4310;
  app.listen(puerto, () => {
    console.log(`Tareo app en http://localhost:${puerto}  (almacenamiento: ${MODO}${MODO === 'archivos' ? ` en ${DATA_DIR}` : ''})`);
  });
}
