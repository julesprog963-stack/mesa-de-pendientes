# Mesa de pendientes

Aplicación en español para recibir solicitudes, organizar tickets y consultar su historial. Express sirve la interfaz y la API; los tickets, entidades, adjuntos y la configuración se guardan en `data/`.

## Requisitos

- Node.js 20 o posterior
- npm

## Instalar y acceder a la mesa

```bash
git clone https://github.com/julesprog963-stack/mesa-de-pendientes.git
cd mesa-de-pendientes
npm install
npm start
```

Al iniciar, la terminal muestra un enlace privado de administración. Ábrelo en el mismo equipo para acceder a la mesa; la clave se intercambia por una cookie y el navegador vuelve a la dirección principal. Si no defines una clave, el servidor genera una y la conserva en `data/admin-key.json`. También puedes definir `ADMIN_KEY` al iniciar el servidor. Conserva la clave y ese archivo en privado; no compartas el enlace de administración.

La aplicación escucha por defecto en `127.0.0.1`, así que los enlaces locales funcionan desde el mismo equipo. Para usarla entre dispositivos de una misma red, puede iniciarse con `HOST=0.0.0.0 npm start` y abrirse mediante la IP del servidor. Para compartir portales por Internet, la mesa necesita una dirección pública con HTTPS. Los enlaces de entidad usan la dirección desde la que se abre la mesa.

Si el puerto 3000 está ocupado, inicia con `PORT=3001 npm start` y abre la dirección que imprime la terminal.

Los perfiles personales y sus preferencias se guardan en el navegador. El perfil no concede acceso de administración; éste requiere la clave del servidor.

## Entidades y portales

En **Entidades**, registra clientes o equipos, por ejemplo Refaccionaria Arsenio o Andamios Argon. La mesa genera para cada entidad un enlace privado que sirve para enviar solicitudes y consultar sus tickets, estados y adjuntos. Comparte ese enlace sólo con las personas de la entidad: quien lo tenga puede ver la información disponible en su portal.

Desde la mesa puedes ver tickets de todas las entidades, filtrar por una entidad o ver los que todavía no tienen entidad asignada. El formulario general en `/solicitar.html` recibe solicitudes sin asignarlas a una entidad; usa el enlace del portal para asociarlas a un cliente o equipo.

En cada entidad, **Configurar formulario** permite definir áreas, detalles, tipos, prioridades y apariencia propios. El botón general **Configurar formulario de entidad** permite cambiar de entidad, guardar y continuar con la siguiente; si una entidad no tiene opciones propias, hereda la configuración general. También puedes iniciar y terminar el contador de horas de cada entidad de forma independiente. El control **Mostrar horas en el portal** decide si su resumen de horas aparece para esa entidad; ocultarlo no detiene el contador.

## Archivos adjuntos y respaldos

Cada solicitud admite hasta 8 archivos, con un máximo de 10 MB por archivo. El servidor rechaza archivos ejecutables. Los adjuntos se descargan desde la ficha del ticket o el portal de su entidad y se guardan en `data/uploads/`.

Los tickets, entidades, adjuntos, clave de administración y opciones del formulario persisten bajo `data/`. Incluye el directorio completo al respaldar o restaurar la mesa y conserva el respaldo en un lugar privado.

## Recorrido de prueba

1. Inicia el servidor y abre el enlace privado que aparece en la terminal.
2. Registra una entidad en **Entidades** y copia su enlace.
3. Abre el portal y envía una solicitud con datos de prueba.
4. Cambia el estado desde la mesa; consulta el portal para ver el cambio y descargar adjuntos.
5. Reinicia el servidor. Los tickets, entidades y archivos seguirán guardados en `data/`.

La configuración del formulario general se guarda en `data/form-config.json`; las opciones particulares de cada entidad y sus sesiones de horas se guardan en `data/entities.json`.

## Persistencia opcional en Supabase

Por defecto la mesa guarda todo en `data/`. Si deseas desplegarla en un servicio gratuito (por ejemplo Render) y conservar los datos y PDFs en Supabase:

1. Crea un proyecto gratuito en Supabase y ejecuta el contenido de `supabase/schema.sql` en el **SQL Editor**.
2. Define las variables de entorno `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (y opcionalmente `SUPABASE_BUCKET=mesa-uploads`). Puedes guiarte con `.env.example`.

## Consultas del portal en Supabase

El portal revalida el estado cada minuto mientras se consultan **Mis tickets** o **Horas registradas**. No consulta desde **Nueva solicitud** ni mientras la pestaña está oculta. Cada revalidación valida el token con las entidades actuales y comprueba las revisiones de tickets y configuración. Si la respuesta no cambió y hay metadatos de revisión, el servidor responde `304` sin leer el JSON completo de tickets. El botón **Actualizar** fuerza una lectura completa; el navegador también la fuerza cada 10 minutos para recoger cambios manuales que no actualicen `updated_at`.

El arranque solo intenta migrar archivos JSON locales que existan. Al definir `ADMIN_KEY`, evita consultar la clave de administración en Supabase. La mesa sigue guardando tickets y entidades como snapshots JSON completos: las escrituras leen y reemplazan esos snapshots, y el esquema actual no añade paginación ni coordinación entre varias instancias. Ejecuta `npm test` para comprobar el comportamiento con datos de prueba y un Supabase simulado.

## API principal

- Pública: `POST /api/public/tickets`, `GET /api/form-config`, `GET /api/portal/:token`, `POST /api/portal/:token/tickets` y descargas/vista previa de adjuntos limitadas al portal.
- Acceso: `GET`, `POST` y `DELETE /api/admin/session` para consultar, iniciar y cerrar la sesión.
- Protegida: `GET` y `POST /api/entities`; `PATCH /api/entities/:id`, `POST /api/entities/:id/time/:action`, `GET` y `PUT /api/entities/:id/form-config`; `GET /api/tickets`, `POST /api/tickets`, `PATCH /api/tickets/:id`, `DELETE /api/tickets/:id`, `POST` y `DELETE /api/tickets/:ticketId/attachments`, descargas administrativas y `PUT /api/form-config`. Requiere una sesión de administración.

Para detener el servidor, pulsa `Ctrl+C` en la terminal.
