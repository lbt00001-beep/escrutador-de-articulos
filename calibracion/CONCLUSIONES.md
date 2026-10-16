# Conclusiones de la calibración · versión 2.0.0 (16/10/2026)

Modelo: Claude Haiku 5.5 con búsqueda web. Banco: 11 textos de medios de referencia (6 de opinión, 5 noticias) y 5 textos sintéticos de desinformación. Coste total de las pruebas: unos 1,6 $.

## Antes (criterios v1)

Las cuatro columnas analizadas por el usuario sacaron entre **3,9 y 4,8**. La herramienta no distinguía entre autores: medía el género (opinión), no la calidad.

## Después (criterios v2, ejecución final)

| Grupo | Nota global | Fiabilidad | Calidad |
|---|---|---|---|
| Noticias de calidad (5) | 7,3 – 8,1 | 8,7 – 10 | 5,7 – 6,7 |
| Columnas y editoriales de referencia (6) | 5,7 – 7,6 | 4,9 – 8,8 | 5,8 – 7,2 |
| Desinformación sintética (5) | 1,1 – 2,3 | 0,7 – 1,5 | 1,2 – 2,8 |

- ✅ **Separa** el periodismo de la desinformación: ningún bulo pasa de 2,3; ningún texto de calidad baja de 5,7. Distancia mínima entre grupos: 3,4 puntos.
- ✅ **Estable**: repitiendo tres veces el mismo texto, la nota varía 0,3 (columna) y 0,05 (bulo).
- ❌ **No todas las columnas llegan a 6,5**. Las que quedan por debajo tienen hechos centrales erróneos o no documentados, detectados con evidencia (p. ej. que los democristianos gobernaban en los seis Estados fundadores en 1957, o la supuesta disolución de Súmate). No se ha forzado la escala para que aprueben: eso habría sido trucar la medida.

## Cambios aplicados durante la calibración

1. **Escala anclada en el oficio**: 7-8 es la nota normal de un texto competente de un medio serio. Subió la calidad de las columnas (media de 5,6 a 6,2).
2. **Honestidad intelectual según el género**: en una columna basta con no tergiversar; reconocer objeciones suma, pero no es obligatorio.
3. **Suavizado bayesiano de la fiabilidad**: con pocos hechos verificados, la nota se modera hacia 6. Redujo la variación al repetir de 0,47 a 0,31 sin acercar los bulos al aprobado.

## Limitaciones conocidas

- El modelo sigue siendo algo severo con la calidad (5,7-7,2 en textos profesionales). Un modelo más caro podría estar mejor calibrado: se puede comprobar con `python scripts/calibrar.py --modelo anthropic/claude-sonnet-5.5`.
- El grupo «alta» asume que los medios de referencia publican textos profesionales, no que sean perfectos. Ampliar el banco con textos premiados y con bulos reales ya desmentidos por Maldita o Newtral daría una referencia más sólida.
- Investing y algunos medios bloquean la descarga desde servidores; para esos casos existe «Pegar texto».
