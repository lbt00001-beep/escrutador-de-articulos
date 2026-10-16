# Escrutador de Artículos · v1.4.0

Analiza un artículo periodístico (URL, PDF o texto pegado) y entrega un informe de calidad con nota de 0 a 10: datos en los que se apoya el autor, contraste de esos datos con fuentes externas, ideas principales y secundarias calificadas, falacias, omisiones y una valoración final razonada.

*By Luis Benedicto Tuzón with Claude Opus 5.5 · 2026 · v1.4.0*

## Versión web

Disponible en [mbainative.com/aplicaciones](https://mbainative.com/aplicaciones). En la web cada visitante usa **su propia clave de OpenRouter**: se guarda solo en su navegador y viaja con cada análisis; el servidor no almacena claves, ajustes ni historial (el historial también vive en el navegador, últimos 25 análisis). Los PDF están limitados a 4 MB por el límite de Vercel; para documentos mayores, usa «Pegar texto».

Despliegue: Vercel desde este repositorio, que lo detecta como FastAPI y redespliega con cada push a `main` (https://escrutador-de-articulos.vercel.app). No uses reescrituras en `vercel.json`: Vercel pasaría a FastAPI la ruta reescrita y todas las páginas darían 404. El modo público se activa solo en Vercel o con `ESCRUTADOR_PUBLIC=1`; en local se prueba con `python run.py 8013 --public`.

## Uso local (Windows)

Doble clic en **`EJECUTAR.bat`**. La primera vez crea el entorno virtual e instala las dependencias; después abre `http://localhost:8010`. En otros sistemas: `pip install -r requirements.txt` y `python run.py`.

## Clave de OpenRouter (⚙ Ajustes)

La app usa modelos de IA a través de [OpenRouter](https://openrouter.ai). Cualquier usuario puede configurar la suya:

1. Crea una clave en [openrouter.ai/keys](https://openrouter.ai/keys) y añade saldo.
2. En la app, pulsa **⚙ Ajustes**, pega la clave y pulsa **Probar clave** (muestra si es válida y el gasto acumulado).
3. Pulsa **Guardar**. En local se guarda en `data/settings.json` (excluido de git); en la web, en el navegador.

Si no hay clave, la app abre Ajustes automáticamente al arrancar. En local, orden de búsqueda: Ajustes → variable `OPENROUTER_API_KEY` → archivo indicado en `OPENROUTER_KEY_FILE` → `Documentos/Openrouter.txt` del usuario → `openrouter_key.txt` en esta carpeta.

En Ajustes también se elige el modelo por defecto (o cualquier ID del catálogo de OpenRouter, con autocompletado), si se contrasta con búsqueda web y cuántos resultados web se consultan.

## Entrada del artículo

- **Enlace web**: descarga imitando la huella TLS de un navegador real (`curl_cffi`; si el antibot bloquea una huella, prueba Chrome, Safari, Chrome Android y Safari iOS por orden), lo que evita los 403/401 que muchos medios devuelven a clientes automáticos aunque la página se lea sin JavaScript (FT, WSJ, Washington Post, Investing…). Si la web sigue bloqueando o solo entrega el gancho de un muro de pago, se intenta la última copia de **archive.org**.
- **Archivo PDF**.
- **Pegar texto**: para artículos de pago o webs que bloquean todo; se copia el texto desde el navegador.

El informe empieza con el **texto original** completo tal como se ha extraído (desplegable en pantalla, íntegro al imprimir y en el Markdown), para poder contrastar el análisis con la fuente.

Si el texto leído es muy corto (< 400 palabras), el informe avisa de que puede estar incompleto.

## Qué hace

1. **Extracción** (sin IA): `trafilatura` saca el cuerpo, título, autor, fecha, medio y enlaces externos; `PyMuPDF` hace lo mismo con PDFs.
2. **Indicadores objetivos** (sin IA): legibilidad (Fernández-Huerta / Flesch), palabras por frase, densidad de cifras, citas textuales, atribuciones de fuentes, enlaces, lenguaje cargado, absolutos, matizadores y marcas de primera persona.
3. **Análisis con IA** (OpenRouter, salida JSON + búsqueda web para contrastar):
   - **Datos del autor**: cifras, estudios y declaraciones en que se apoya, con la fuente citada (o «Sin fuente»).
   - **Contraste**: afirmaciones verificables con veredicto, evidencia concreta y enlaces a las fuentes consultadas.
   - **Ideas principales y secundarias**, cada una seguida de su calificación en azul oscuro: *Correcto, Mayormente correcto, Parcialmente correcto, Engañoso, Incorrecto, No verificable, Opinión*.
   - **Rigor**: falacias y sesgos, contexto omitido, perspectivas presentes y ausentes.
4. **Nota 0-10** calculada en Python como media ponderada de 7 criterios:

| Criterio | Peso |
|---|---|
| Respaldo factual | 20 % |
| Exactitud (calculada a partir de los veredictos del contraste) | 25 % |
| Rigor argumental | 15 % |
| Contexto y omisiones | 10 % |
| Equilibrio de perspectivas | 10 % |
| Hechos vs. opinión | 10 % |
| Neutralidad del lenguaje | 10 % |

   Límites: si una idea principal es incorrecta o engañosa, la nota máxima es 5; con dos o más afirmaciones incorrectas, 6,5.

Los análisis se guardan en `data/historial/` y se pueden reabrir desde **Historial**. Cada informe se exporta a Markdown o a PDF (botón PDF → «Guardar como PDF»); el archivo se llama «Autor - Título - Medio - Fecha», p. ej. `Daniel Innerarity - Nostalgia de los conservadores - EL PAÍS - 2026-10-15.pdf`.

## Modelos (precio por millón de tokens, entrada / salida)

| Modelo | Precio | Comentario |
|---|---|---|
| Claude Haiku 5.5 (por defecto) | $0,10 / $0,50 | El contraste más completo y con URLs concretas. ≈0,04 $ por análisis con búsqueda web |
| Gemini 2.5 Flash Lite | $0,10 / $0,40 | El más barato: ≈0,012 $ por análisis con búsqueda web |
| Gemini 3.5 Flash Lite | $0,30 / $2,50 | Rápido (≈17 s); verificación más escueta y fuentes más genéricas |
| Gemini 3.8 Flash | $0,75 / $3,75 | Gemini más capaz |
| GPT-6 Luna | $0,10 / $0,50 | Alternativa de OpenAI |
| DeepSeek V4.1 Flash | $0,02 / $0,72 | Entrada casi gratis |
| Claude Sonnet 5.5 | $2 / $10 | Máxima calidad para artículos complejos |

La lista está en `app/config.py`. Si un modelo falla con el modo JSON forzado de OpenRouter (como Gemini 3.x), la app reintenta automáticamente sin él.

## Estructura

```
app/config.py    versión, ajustes, clave, modelos
app/extract.py   extracción de URL (curl_cffi + archive.org), PDF y texto pegado
app/metrics.py   indicadores objetivos
app/analyze.py   prompt, esquema JSON, llamada a OpenRouter y nota final
app/main.py      API FastAPI: ajustes, análisis e historial (modo local y público)
api/index.py     punto de entrada para Vercel
static/          interfaz (HTML, CSS, JS)
```
