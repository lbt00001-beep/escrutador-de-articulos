# Escrutador de Artículos · versión 2.1.0

Analiza un artículo periodístico (URL, PDF o texto pegado) y entrega un informe de calidad con nota de 0 a 10: datos en los que se apoya el autor, contraste de esos datos con fuentes externas, ideas principales y secundarias calificadas, falacias, omisiones y una valoración final razonada.

*By Luis Benedicto Tuzón with Claude Opus 5.5 · versión 2.1.0 · 2026*

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
- **Archivo PDF**. Si es un PDF escaneado (sin texto seleccionable), se reconoce el texto con **OCR en el navegador** (pdf.js + tesseract.js, en español, hasta 15 páginas): el PDF no sale del equipo del usuario.
- **Pegar texto**: para artículos de pago o webs que bloquean todo; se copia el texto desde el navegador.
- **Varios artículos (lote)**: enlaces (uno por línea) y/o varios PDF, hasta 30. Se analizan de dos en dos, se guardan en el historial y al terminar se muestra una tabla con las notas, un **informe conjunto** imprimible en PDF y su versión en Markdown. Antes de empezar se indica el coste estimado.

**Modo rápido**: cribado con Gemini 2.5 Flash Lite y sin búsqueda web (~0,005 $ y ~20 s por artículo). Los hechos se comprueban solo con el conocimiento del modelo, que no puede dar confianza alta a datos recientes; el informe lo advierte. Útil para lotes; para verificar de verdad, el análisis completo.

**Comparar**: en el Historial se marcan dos análisis y se muestran lado a lado (notas, criterios de calidad, hechos verificados, fortalezas, debilidades y acciones editoriales).

**Acciones editoriales**: tres cambios concretos que pediría un editor para mejorar el texto, adaptados al género.

Estas funciones proceden del antiguo *Radar de Calidad Periodística*, integrado en esta app en la versión 2.1.0 con la metodología del Escrutador (verificación de hechos y rúbricas por género).

El informe empieza con el **texto original** completo tal como se ha extraído (desplegable en pantalla, íntegro al imprimir y en el Markdown), para poder contrastar el análisis con la fuente.

Si el texto leído es muy corto (< 400 palabras), el informe avisa de que puede estar incompleto.

## Qué hace

1. **Extracción** (sin IA): `trafilatura` saca el cuerpo, título, autor, fecha, medio y enlaces externos; `PyMuPDF` hace lo mismo con PDFs.
2. **Indicadores objetivos** (sin IA): legibilidad (Fernández-Huerta / Flesch), palabras por frase, densidad de cifras, citas textuales, atribuciones de fuentes, enlaces, lenguaje cargado, absolutos, matizadores y marcas de primera persona.
3. **Análisis con IA** (OpenRouter, salida JSON + búsqueda web para contrastar), con el método de los criterios v2:
   1. **Género**: noticia, opinión/columna, editorial, análisis, reportaje, entrevista, divulgación o comunicado. Lo detecta la IA y el usuario puede fijarlo.
   2. **Clasificación previa** de las afirmaciones en *hecho, interpretación, valoración, recurso retórico* o *predicción*, marcando las centrales. Una hipérbole o una intención atribuida no se verifican como si fueran hechos.
   3. **Contraste solo de los hechos**, con veredicto (*Correcto, Mayormente correcto, Parcialmente correcto, Engañoso, Incorrecto, No verificable*), **confianza** (alta/media/baja), evidencia y enlaces a las fuentes consultadas.
   4. **Ideas principales y secundarias**, cada una seguida de su calificación en azul oscuro: los hechos por su exactitud y las opiniones por su fundamento (*Opinión bien fundamentada, discutible, sin fundamento*).
   5. **Rigor con mesura**: solo falacias claras (con confianza) y omisiones que cambiarían la conclusión. No hay cuota: una lista vacía es una respuesta válida.
   6. **Calidad**: el modelo puntúa diez criterios con una escala anclada (9-10 referencia del género, 7-8 lo esperable en un medio serio, 5-6 correcto con carencias…), empezando por las fortalezas.
4. **Dos notas y una global**, calculadas en Python (`app/scoring.py`), sin IA:
   - **Fiabilidad factual**: media de los hechos verificados (Correcto 10, Mayormente 8, Parcialmente 5, Engañoso 2,5, Incorrecto 0). Los hechos centrales pesan el doble y los de confianza baja no cuentan. Si no hay hechos verificables, no se calcula.
   - **Calidad según el género**, con estas rúbricas:

| Criterio | Noticia | Opinión / Editorial | Análisis / Divulgación | Reportaje / Entrevista |
|---|---|---|---|---|
| Atribución de fuentes | 30 % | — | 15 % | 20 % |
| Equilibrio de voces | 20 % | — | — | 15 % |
| Contexto | 20 % | 10 % | 15 % | 15 % |
| Neutralidad del lenguaje | 15 % | — | — | 10 % |
| Claridad y escritura | 15 % | 15 % | 15 % | 15 % |
| Solidez argumental | — | 30 % | 25 % | — |
| Honestidad intelectual | — | 20 % | 10 % | — |
| Originalidad y aporte | — | 20 % | — | — |
| Profundidad y trabajo propio | — | — | 20 % | 25 % |
| Respeto en el debate | — | 5 % | — | — |
| **Peso de la fiabilidad en la nota global** | 50 % | 35 % | 45 % | 45 % |

   - **Límite**: solo una falsedad *central* y con *confianza alta* limita la nota global a 5 (dos o más, a 4). Las interpretaciones nunca la limitan.
   - En el informe se puede cambiar el género para ver cómo se valoraría con otra rúbrica: se recalcula al instante, sin volver a pagar el análisis.

Los indicadores objetivos son descriptivos y no entran en la nota (una prosa culta da una legibilidad baja sin ser peor).

### Calibración

`calibracion/` contiene un banco de prueba con textos de medios de referencia y textos sintéticos de desinformación, y `scripts/calibrar.py` comprueba que las notas separan ambos grupos y son estables al repetir. Ver `calibracion/LEEME.md` y los informes en `calibracion/resultados/`.

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
app/analyze.py   prompt, esquema JSON y llamada a OpenRouter (criterios v2)
app/scoring.py   notas de fiabilidad y calidad por género (sin IA)
scripts/calibrar.py  banco de calibración
tests/           pruebas de las notas: python -m unittest discover tests
app/main.py      API FastAPI: ajustes, análisis e historial (modo local y público)
api/index.py     punto de entrada para Vercel
static/          interfaz (HTML, CSS, JS)
```
