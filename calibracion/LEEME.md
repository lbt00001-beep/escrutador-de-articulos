# Banco de calibración

Comprueba que las notas **separan** el buen periodismo de la desinformación y que son **estables** al repetir el análisis. Sin esta prueba, cualquier rúbrica es solo la opinión de quien la diseña.

- `banco.json`: textos y objetivos.
  - Grupo `alta`: artículos de medios de referencia. Se asume calidad profesional, no perfección.
  - Grupo `baja`: **textos sintéticos escritos para estas pruebas, con falsedades deliberadas y comprobables** (carpeta `textos/`, prefijo `sintetico-`). No son noticias reales y no deben difundirse como tales.
- `python scripts/calibrar.py` ejecuta el banco con el modelo por defecto y guarda el informe en `resultados/`.
  - `--modelo google/gemini-2.5-flash-lite` calibra otro modelo.
  - `--repetir 3 --solo innerarity-conservadores` mide la estabilidad de un texto.
  - `--sin-web` abarata la prueba (la fiabilidad será menos precisa).
  - `--reusar resultados/<archivo>.json` recalcula las notas de una ejecución anterior sin volver a llamar a la IA (útil al ajustar pesos en `app/scoring.py`).

Coste aproximado con Claude Haiku 5.5 y búsqueda web: 0,04 $ por texto (unos 0,65 $ el banco completo).
