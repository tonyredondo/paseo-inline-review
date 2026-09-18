# paseo-inline-review

Plugin de [Paseo](https://paseo.sh) para comentar las respuestas del agente inline y enviarlas como review.

## Qué hace

- Reemplaza cada respuesta del agente en el timeline por una vista por párrafos: toca un párrafo para añadirle un comentario anclado debajo del texto.
- Añade una pill "Review (n)" en el composer de cada agente que abre el panel del plugin.
- El panel lista los comentarios (editables y eliminables), permite una nota general, y ofrece:
  - **Copiar al composer**: copia el review formateado (citas + comentarios) al portapapeles para pegarlo en el textbox del mensaje.
  - **Enviar al agente**: envía el review directamente al agente vía SDK.
  - **Limpiar**: descarta los comentarios del agente.

## Instalación

```bash
paseo plugin add tony-redondo_ddog/paseo-inline-review
```

o desde un checkout local:

```bash
paseo plugin install /ruta/a/paseo-inline-review
```

## Desarrollo

```bash
npm install
npm run typecheck
paseo plugin reload inline-review
paseo plugin logs inline-review
```

Requiere Paseo >= 0.8.0 con plugins habilitados en el daemon (`Settings → Plugins → Enable plugins` o `pluginsEnabled: true` en el config del daemon).
