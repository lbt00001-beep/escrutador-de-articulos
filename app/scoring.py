"""Notas de la versión 2: fiabilidad factual + calidad según el género, sin llamadas a la IA.

El modelo puntúa TODOS los criterios de calidad; aquí se eligen y ponderan los que exige cada
género. Así se puede re-evaluar un artículo como otro género sin volver a pagar el análisis."""

GENRES = ["Noticia", "Opinión / columna", "Editorial", "Análisis", "Reportaje", "Entrevista",
          "Divulgación", "Comunicado / propaganda", "Otro"]

# Criterios de calidad: clave -> (nombre, pregunta que responde)
QUALITY_CRITERIA = {
    "solidez_argumental": ("Solidez argumental",
                           "¿Las conclusiones se siguen de las premisas y el razonamiento resiste el escrutinio?"),
    "honestidad_intelectual": ("Honestidad intelectual",
                               "¿Es justo con los hechos y con el adversario: no tergiversa, no caricaturiza ni "
                               "oculta lo que debilita su tesis? (En una columna basta con no tergiversar; "
                               "reconocer objeciones suma, pero no es obligatorio.)"),
    "originalidad": ("Originalidad y aporte",
                     "¿Aporta una idea, un enfoque o una información que va más allá de lo obvio?"),
    "profundidad": ("Profundidad y trabajo propio",
                    "¿Profundiza con datos, ejemplos, documentación o trabajo de campo propio?"),
    "contexto": ("Contexto", "¿Da el contexto necesario para entender el asunto sin inducir a error?"),
    "atribucion_fuentes": ("Atribución de fuentes",
                           "¿Identifica con claridad de dónde salen los datos y las declaraciones?"),
    "equilibrio_voces": ("Equilibrio de voces",
                         "¿Recoge las voces relevantes, incluidas las de los afectados o aludidos?"),
    "neutralidad": ("Neutralidad del lenguaje",
                    "¿Usa un lenguaje descriptivo, sin adjetivación valorativa ni sensacionalismo?"),
    "respeto": ("Respeto en el debate",
                "¿Evita el insulto, la descalificación personal y el lenguaje deshumanizador? "
                "(La ironía y la crítica dura son legítimas.)"),
    "claridad_escritura": ("Claridad y escritura", "¿Está bien escrito, es claro y está bien estructurado?"),
}

# Rúbrica por género: pesos de calidad (suman 1) y peso de la fiabilidad factual en la nota global
_NEWS = {"peso_fiabilidad": 0.50, "criterios": {
    "atribucion_fuentes": 0.30, "equilibrio_voces": 0.20, "contexto": 0.20,
    "neutralidad": 0.15, "claridad_escritura": 0.15}}
_OPINION = {"peso_fiabilidad": 0.35, "criterios": {
    "solidez_argumental": 0.30, "honestidad_intelectual": 0.20, "originalidad": 0.20,
    "claridad_escritura": 0.15, "contexto": 0.10, "respeto": 0.05}}
_ANALYSIS = {"peso_fiabilidad": 0.45, "criterios": {
    "solidez_argumental": 0.25, "profundidad": 0.20, "atribucion_fuentes": 0.15,
    "contexto": 0.15, "claridad_escritura": 0.15, "honestidad_intelectual": 0.10}}
_REPORT = {"peso_fiabilidad": 0.45, "criterios": {
    "profundidad": 0.25, "atribucion_fuentes": 0.20, "equilibrio_voces": 0.15,
    "contexto": 0.15, "claridad_escritura": 0.15, "neutralidad": 0.10}}

RUBRICS = {
    "Noticia": _NEWS,
    "Opinión / columna": _OPINION,
    "Editorial": _OPINION,
    "Análisis": _ANALYSIS,
    "Divulgación": _ANALYSIS,
    "Reportaje": _REPORT,
    "Entrevista": _REPORT,
    "Comunicado / propaganda": _NEWS,
    "Otro": _NEWS,
}

# Veredictos de hechos y su valor para la fiabilidad (None = no puntúa)
FACT_VERDICTS = ["Correcto", "Mayormente correcto", "Parcialmente correcto", "Engañoso", "Incorrecto",
                 "No verificable"]
FACT_VALUE = {"Correcto": 10, "Mayormente correcto": 8, "Parcialmente correcto": 5, "Engañoso": 2.5,
              "Incorrecto": 0, "No verificable": None}
# Solo cuentan los veredictos con confianza suficiente; las dudas no hunden la nota
CONFIDENCE_WEIGHT = {"alta": 1.0, "media": 0.6, "baja": 0.0}
CENTRAL_WEIGHT = 2.0
# Suavizado bayesiano: con pocos hechos verificados, un solo veredicto no debe llevar la nota a un
# extremo. Equivale a sumar PRIOR_WEIGHT hechos «neutros» de valor PRIOR_VALUE. Con muchos hechos
# (p. ej. un bulo con cinco falsedades centrales) el suavizado apenas influye.
PRIOR_VALUE = 6.0
PRIOR_WEIGHT = 1.5


def _label_quality(n):
    if n is None:
        return ""
    return ("Excelente" if n >= 8.5 else "Notable" if n >= 7 else "Correcto" if n >= 5.5
            else "Mejorable" if n >= 4 else "Deficiente")


def _label_reliability(n):
    if n is None:
        return "Sin hechos verificables"
    return ("Hechos sólidos" if n >= 8.5 else "Mayormente fiable" if n >= 7 else "Con errores" if n >= 5
            else "Poco fiable" if n >= 3 else "No fiable")


def reliability(verificacion: list) -> dict:
    """Media ponderada de los hechos contrastados: los centrales pesan el doble y los de confianza
    baja no cuentan. Devuelve nota None si no hay hechos verificables con confianza suficiente."""
    total_w = total = 0.0
    counted = 0
    for v in verificacion or []:
        value = FACT_VALUE.get(v.get("veredicto"))
        w = CONFIDENCE_WEIGHT.get(v.get("confianza"), 0.6) * (CENTRAL_WEIGHT if v.get("central") else 1.0)
        if value is None or w == 0:
            continue
        total += value * w
        total_w += w
        counted += 1
    nota = round((total + PRIOR_VALUE * PRIOR_WEIGHT) / (total_w + PRIOR_WEIGHT), 1) if total_w else None
    return {"nota": nota, "etiqueta": _label_reliability(nota), "hechos_contados": counted,
            "hechos_verificados": len(verificacion or []), "peso_evidencia": round(total_w, 1)}


def quality(criterios: dict, genero: str) -> dict:
    rubric = RUBRICS.get(genero, _NEWS)
    breakdown, total = [], 0.0
    for key, weight in rubric["criterios"].items():
        name, question = QUALITY_CRITERIA[key]
        c = (criterios or {}).get(key) or {}
        try:
            value = max(0.0, min(10.0, float(c.get("puntuacion"))))
        except (TypeError, ValueError):
            value = 5.0
        total += value * weight
        breakdown.append({"clave": key, "nombre": name, "peso": weight, "descripcion": question,
                          "puntuacion": round(value, 1), "justificacion": c.get("justificacion", "")})
    nota = round(total, 1)
    return {"nota": nota, "etiqueta": _label_quality(nota), "desglose": breakdown}


def score(result: dict, genero: str | None = None) -> dict:
    """Puntuación v2. `genero` permite re-evaluar como otro género (si no, el detectado)."""
    detected = result.get("genero") if result.get("genero") in GENRES else "Otro"
    genero = genero if genero in GENRES else detected
    rubric = RUBRICS.get(genero, _NEWS)

    fiab = reliability(result.get("verificacion"))
    cal = quality(result.get("criterios"), genero)
    w = rubric["peso_fiabilidad"]
    total = cal["nota"] if fiab["nota"] is None else w * fiab["nota"] + (1 - w) * cal["nota"]

    # Solo una falsedad central y de confianza alta limita la nota; las interpretaciones nunca
    graves = [v for v in result.get("verificacion") or []
              if v.get("veredicto") == "Incorrecto" and v.get("central") and v.get("confianza") == "alta"]
    cap, reason = 10.0, ""
    if len(graves) >= 2:
        cap, reason = 4.0, "Contiene varias falsedades centrales comprobadas (nota máxima 4)."
    elif graves:
        cap, reason = 5.0, "Una afirmación central es falsa con evidencia sólida (nota máxima 5)."
    if total <= cap:
        reason = ""
    final = round(min(total, cap), 1)

    return {
        "version": 2,
        "genero": genero,
        "genero_detectado": detected,
        "nota": final,
        "etiqueta": _label_quality(final),
        "fiabilidad": fiab,
        "calidad": cal,
        "peso_fiabilidad": w if fiab["nota"] is not None else 0.0,
        "limite": reason,
        "nota_sin_limite": round(total, 1),
        # Compatibilidad con el historial y la exportación de la v1
        "desglose": cal["desglose"],
    }
