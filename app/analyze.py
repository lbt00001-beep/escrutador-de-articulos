"""Análisis del artículo con un LLM vía OpenRouter y cálculo de la nota final."""
import json
import re
from datetime import date

import httpx

from .config import OPENROUTER_URL, MAX_ARTICLE_CHARS, get_api_key

VERDICTS = ["Correcto", "Mayormente correcto", "Parcialmente correcto", "Engañoso",
            "Incorrecto", "No verificable", "Opinión"]

# Valor numérico de cada veredicto para la nota de exactitud (None = no puntúa)
VERDICT_VALUE = {"Correcto": 10, "Mayormente correcto": 8, "Parcialmente correcto": 5,
                 "Engañoso": 2.5, "Incorrecto": 0, "No verificable": None, "Opinión": None}

SOURCE_TYPES = ["Estadística u organismo oficial", "Estudio científico o académico", "Informe de organización",
                "Medio de comunicación", "Experto o testimonio", "Documento legal o judicial",
                "Declaración de parte interesada", "Elaboración propia del autor", "Sin fuente"]

# Criterios de la rúbrica: clave -> (nombre, peso, descripción)
CRITERIA = {
    "respaldo_factual": ("Respaldo factual", 0.20, "¿Aporta datos y fuentes identificables para sus afirmaciones?"),
    "exactitud": ("Exactitud", 0.25, "¿Los datos y afirmaciones verificables son correctos?"),
    "rigor_logico": ("Rigor argumental", 0.15, "¿Las conclusiones se siguen de las premisas, sin falacias?"),
    "contexto": ("Contexto y omisiones", 0.10, "¿Ofrece el contexto necesario o omite información relevante?"),
    "equilibrio": ("Equilibrio de perspectivas", 0.10, "¿Recoge o reconoce puntos de vista distintos?"),
    "transparencia": ("Hechos vs. opinión", 0.10, "¿Distingue claramente lo que es hecho de lo que es opinión?"),
    "lenguaje": ("Neutralidad del lenguaje", 0.10, "¿Evita el lenguaje emocional, sensacionalista o descalificador?"),
}


def _str(desc=""):
    return {"type": "string", "description": desc} if desc else {"type": "string"}


def _obj(props: dict):
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def _arr(items):
    return {"type": "array", "items": items}


_verdict = {"type": "string", "enum": VERDICTS}
_idea = _obj({"idea": _str("Idea formulada en una frase"),
              "veredicto": _verdict,
              "justificacion": _str("Por qué recibe ese veredicto, en 1-2 frases")})

SCHEMA = _obj({
    "titulo_inferido": _str("Título del artículo"),
    "resumen": _str("Resumen neutral en 2-3 frases"),
    "tipo_texto": {"type": "string", "enum": ["Noticia", "Opinión / columna", "Análisis", "Reportaje",
                                               "Entrevista", "Editorial", "Divulgación", "Comunicado / propaganda", "Otro"]},
    "tesis": _str("Tesis o mensaje central que el autor quiere transmitir"),
    "datos_del_autor": _arr(_obj({
        "dato": _str("Dato, cifra o hecho en que se apoya el autor"),
        "fuente_citada": _str("Fuente que menciona el autor, o 'Sin fuente'"),
        "tipo_fuente": {"type": "string", "enum": SOURCE_TYPES},
        "fragmento": _str("Cita literal breve del artículo (máx. 25 palabras)"),
    })),
    "verificacion": _arr(_obj({
        "afirmacion": _str("Afirmación verificable del artículo"),
        "veredicto": _verdict,
        "evidencia": _str("Datos concretos que confirman o refutan la afirmación, con cifras y fechas"),
        "fuentes": _arr(_obj({"titulo": _str(), "url": _str("URL real consultada o vacío si no hay")})),
    })),
    "ideas_principales": _arr(_obj({
        "idea": _str("Idea principal en una frase"),
        "veredicto": _verdict,
        "justificacion": _str("Por qué recibe ese veredicto, en 1-2 frases"),
        "secundarias": _arr(_idea),
    })),
    "falacias_y_sesgos": _arr(_obj({
        "tipo": _str("Nombre de la falacia o sesgo (p. ej. hombre de paja, generalización apresurada, cherry picking)"),
        "fragmento": _str("Cita literal breve"),
        "explicacion": _str(),
    })),
    "omisiones": _arr(_str("Contexto o dato relevante que el artículo omite")),
    "perspectivas": _obj({"presentes": _arr(_str()), "ausentes": _arr(_str())}),
    "criterios": _obj({k: _obj({"puntuacion": {"type": "number", "description": "0 a 10"},
                                "justificacion": _str("1-2 frases")}) for k in CRITERIA}),
    "fortalezas": _arr(_str()),
    "debilidades": _arr(_str()),
    "valoracion_global": _str("Valoración final razonada en 3-4 frases"),
})

SYSTEM_PROMPT = """Eres un verificador de datos (fact-checker) y analista de medios profesional, riguroso e imparcial, \
con el método de organizaciones como Maldita, Newtral, Full Fact o la IFCN.

Tu tarea es escrutar el artículo que te da el usuario. Reglas:
- Responde SIEMPRE en español, aunque el artículo esté en otro idioma.
- Sé imparcial: aplica el mismo rigor sea cual sea la orientación ideológica del texto. Evalúa la calidad \
  epistémica, no si estás de acuerdo con la opinión.
- "datos_del_autor": enumera TODOS los datos, cifras, estudios, declaraciones o hechos que el autor usa como \
  apoyo (hasta 15), indicando qué fuente cita. Si no cita ninguna, "Sin fuente". Si el artículo no se apoya en \
  datos, devuelve la lista vacía.
- "verificacion": selecciona las afirmaciones verificables más relevantes (hasta 12) y contrástalas con los \
  resultados de búsqueda web y tu conocimiento. En "evidencia" da los datos concretos (cifras, fechas, organismos) \
  que la confirman o la refutan. Incluye en "fuentes" solo URLs reales que hayas consultado en la búsqueda; \
  nunca inventes URLs. Si no puedes contrastarla con seguridad, usa "No verificable".
- "ideas_principales": entre 3 y 7 ideas principales, cada una con sus ideas secundarias (0-4). Cada idea lleva \
  un veredicto: los hechos se califican de "Correcto" a "Incorrecto"; los juicios de valor o predicciones, \
  "Opinión" (si una opinión se apoya en un dato falso, califícala según ese dato).
- Veredictos: Correcto (preciso y con contexto suficiente); Mayormente correcto (preciso pero necesita matiz); \
  Parcialmente correcto (mezcla elementos ciertos y erróneos); Engañoso (datos ciertos presentados de forma \
  que inducen a error o sin contexto clave); Incorrecto (falso); No verificable; Opinión.
- Ten en cuenta la fecha de publicación: un dato correcto en su momento no es incorrecto porque haya cambiado \
  después (menciónalo en la evidencia).
- "criterios": puntúa de 0 a 10 cada criterio con una justificación breve:
{criteria}
  Si el texto es de opinión, no lo penalices por opinar, sino por presentar opiniones como hechos o por \
  apoyarse en datos falsos o sin respaldo.
- Si el texto parece incompleto (muro de pago, corte abrupto, título que anuncia algo que el texto no llega a \
  desarrollar), evalúa solo lo que hay, dilo en el resumen y no califiques como "Engañoso" una idea por el mero \
  hecho de que su desarrollo no aparezca.
- Usa los indicadores objetivos que te doy (calculados automáticamente) como apoyo, no como verdad absoluta.
- Devuelve exclusivamente el JSON pedido."""


class AnalysisError(Exception):
    pass


def _build_user_prompt(article: dict, metrics: dict) -> str:
    text = article["text"]
    truncated = len(text) > MAX_ARTICLE_CHARS
    text = text[:MAX_ARTICLE_CHARS]
    links = "\n".join(f"- {l['text'] or '(enlace)'}: {l['url']}" for l in article.get("links", [])[:25]) or "(ninguno)"
    return f"""Fecha de hoy: {date.today().isoformat()}

METADATOS
- Título: {article.get('title') or '(desconocido)'}
- Autor: {article.get('author') or '(desconocido)'}
- Medio / origen: {article.get('source') or '(desconocido)'}
- Fecha de publicación: {article.get('date') or '(desconocida)'}
- URL: {article.get('url') or '(PDF subido por el usuario)'}

INDICADORES OBJETIVOS (cálculo automático)
{json.dumps(metrics, ensure_ascii=False)}

ENLACES EXTERNOS QUE CITA EL ARTÍCULO
{links}

TEXTO DEL ARTÍCULO{' (truncado)' if truncated else ''}
\"\"\"
{text}
\"\"\""""


def _parse_json(content: str) -> dict:
    content = content.strip()
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        start, end = content.find("{"), content.rfind("}")
        if start >= 0 and end > start:
            return json.loads(content[start:end + 1])
        raise


def _call(payload: dict, api_key: str) -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Escrutador de Articulos",
    }
    with httpx.Client(timeout=httpx.Timeout(300, connect=20)) as client:
        resp = client.post(OPENROUTER_URL, json=payload, headers=headers)
    if resp.status_code == 401:
        raise AnalysisError("OpenRouter (401): la clave no es válida o ha sido revocada. Revísala en ⚙ Ajustes.")
    if resp.status_code == 402:
        raise AnalysisError("OpenRouter (402): tu cuenta no tiene saldo suficiente. "
                            "Añade créditos en https://openrouter.ai/credits.")
    if resp.status_code != 200:
        try:
            err = resp.json().get("error", {})
            msg = err.get("message", resp.text)
            raw = (err.get("metadata") or {}).get("raw")
            if raw:
                try:
                    msg += " — " + json.loads(raw)["error"]["message"]
                except (ValueError, KeyError, TypeError):
                    msg += " — " + str(raw)[:300]
        except ValueError:
            msg = resp.text
        raise AnalysisError(f"OpenRouter ({resp.status_code}): {msg[:400]}")
    data = resp.json()
    if "error" in data:
        raise AnalysisError(f"OpenRouter: {data['error'].get('message', data['error'])}")
    return data


def run(article: dict, metrics: dict, model: str, web_search: bool = True, api_key: str = "",
        web_results: int = 8) -> dict:
    api_key = api_key or get_api_key()
    if not api_key:
        raise AnalysisError("No hay clave de OpenRouter. Abre ⚙ Ajustes y pega tu clave "
                            "(se obtiene en https://openrouter.ai/keys).")
    criteria_txt = "\n".join(f"  · {k} ({name}): {desc}" for k, (name, _, desc) in CRITERIA.items())
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT.format(criteria=criteria_txt)},
            {"role": "user", "content": _build_user_prompt(article, metrics)},
        ],
        "temperature": 0.1,
        # El razonamiento interno cuenta dentro de max_tokens: se acota para dejar sitio al JSON
        "max_tokens": 32000,
        "reasoning": {"max_tokens": 6000},
        # El esquema es demasiado grande para la gramática estricta de algunos proveedores,
        # así que se usa modo JSON con el esquema en el prompt y se normaliza la respuesta.
        "response_format": {"type": "json_object"},
        "usage": {"include": True},
    }
    payload["messages"][0]["content"] += ("\n\nEsquema JSON obligatorio (todas las claves son obligatorias):\n"
                                          + json.dumps(SCHEMA, ensure_ascii=False, separators=(",", ":")))
    if re.match(r"google/gemini-[3-9]", model):
        payload.pop("response_format")  # Gemini 3.x devuelve error con el modo JSON forzado
    if web_search:
        payload["plugins"] = [{"id": "web", "max_results": web_results}]

    def attempt(p):
        d = _call(p, api_key)
        msg = d["choices"][0]["message"]
        try:
            return d, msg, _parse_json(msg.get("content") or "")
        except (json.JSONDecodeError, TypeError):
            raise AnalysisError(f"El modelo no devolvió un JSON válido "
                                f"(finish_reason={d['choices'][0].get('finish_reason')}).")

    try:
        data, message, result = attempt(payload)
    except AnalysisError as first_error:
        # Algunos modelos (p. ej. Gemini 3.x) fallan con el modo JSON forzado; el prompt ya pide JSON
        # y _parse_json lo extrae, así que se reintenta una vez sin response_format.
        if "(401)" in str(first_error) or "(402)" in str(first_error):
            raise
        retry = {k: v for k, v in payload.items() if k != "response_format"}
        try:
            data, message, result = attempt(retry)
        except AnalysisError as e:
            raise AnalysisError(f"{e} Prueba otro modelo en ⚙ Ajustes.")

    citations = []
    for ann in message.get("annotations") or []:
        c = ann.get("url_citation") or {}
        if c.get("url") and c["url"] not in [x["url"] for x in citations]:
            citations.append({"url": c["url"], "titulo": c.get("title") or c["url"]})

    usage = data.get("usage") or {}
    result["_meta"] = {
        "modelo": data.get("model", model),
        "busqueda_web": web_search,
        "fuentes_web": citations,
        "tokens_entrada": usage.get("prompt_tokens"),
        "tokens_salida": usage.get("completion_tokens"),
        "coste_usd": usage.get("cost"),
    }
    _normalize(result)
    result["puntuacion"] = score(result)
    return result


def _fix_verdict(value) -> str:
    """Ajusta un veredicto libre al catálogo cerrado (p. ej. 'correcta' -> 'Correcto')."""
    def key(s):
        s = str(s or "").lower()
        for a, b in zip("áéíóúñ", "aeioun"):
            s = s.replace(a, b)
        return re.sub(r"[^a-z]", "", s)[:9]
    k = key(value)
    for v in VERDICTS:
        if key(v) == k:
            return v
    for v in VERDICTS:
        if k and (key(v).startswith(k[:5]) or k.startswith(key(v)[:5])):
            return v
    return "No verificable"


def _normalize(result: dict) -> None:
    """Garantiza tipos y claves para que la interfaz nunca reciba estructuras incompletas."""
    for k in ("datos_del_autor", "verificacion", "ideas_principales", "falacias_y_sesgos",
              "omisiones", "fortalezas", "debilidades"):
        if not isinstance(result.get(k), list):
            result[k] = []
    for k in ("titulo_inferido", "resumen", "tipo_texto", "tesis", "valoracion_global"):
        result[k] = str(result.get(k) or "")
    if not isinstance(result.get("perspectivas"), dict):
        result["perspectivas"] = {}
    if not isinstance(result.get("criterios"), dict):
        result["criterios"] = {}
    for d in result["datos_del_autor"]:
        if d.get("tipo_fuente") not in SOURCE_TYPES:
            d["tipo_fuente"] = "Sin fuente" if "sin fuente" in str(d.get("fuente_citada", "")).lower() else "Otro"
    for item in result["verificacion"]:
        item["veredicto"] = _fix_verdict(item.get("veredicto"))
        if not isinstance(item.get("fuentes"), list):
            item["fuentes"] = []
    for idea in result["ideas_principales"]:
        idea["veredicto"] = _fix_verdict(idea.get("veredicto"))
        if not isinstance(idea.get("secundarias"), list):
            idea["secundarias"] = []
        for s in idea["secundarias"]:
            s["veredicto"] = _fix_verdict(s.get("veredicto"))


def score(result: dict) -> dict:
    """Nota final 0-10 como media ponderada de la rúbrica.

    La exactitud no se toma del modelo si hay afirmaciones contrastadas: se calcula a partir
    de los veredictos de la verificación, para que la nota sea trazable."""
    crit = result.get("criterios") or {}
    verdict_vals = [VERDICT_VALUE[v["veredicto"]] for v in result.get("verificacion", [])
                    if VERDICT_VALUE.get(v.get("veredicto")) is not None]
    breakdown = []
    total = 0.0
    for key, (name, weight, desc) in CRITERIA.items():
        c = crit.get(key) or {}
        try:
            value = float(c.get("puntuacion", 5))
        except (TypeError, ValueError):
            value = 5.0
        just = c.get("justificacion", "")
        origin = "Evaluación del modelo"
        if key == "exactitud" and verdict_vals:
            value = sum(verdict_vals) / len(verdict_vals)
            origin = f"Calculado a partir de {len(verdict_vals)} afirmaciones verificadas"
        value = max(0.0, min(10.0, value))
        total += value * weight
        breakdown.append({"clave": key, "nombre": name, "peso": weight, "descripcion": desc,
                          "puntuacion": round(value, 1), "justificacion": just, "origen": origin})

    # Una afirmación falsa o engañosa central limita la nota máxima
    cap, cap_reason = 10.0, ""
    falsos = sum(1 for v in result.get("verificacion", []) if v.get("veredicto") == "Incorrecto")
    principales_falsas = sum(1 for i in result.get("ideas_principales", [])
                             if i.get("veredicto") in ("Incorrecto", "Engañoso"))
    if principales_falsas:
        cap, cap_reason = 5.0, "Hay ideas principales calificadas como incorrectas o engañosas (nota máxima 5)."
    elif falsos >= 2:
        cap, cap_reason = 6.5, "Contiene varias afirmaciones incorrectas (nota máxima 6,5)."
    if total <= cap:
        cap_reason = ""  # el límite no cambia la nota: no se muestra
    final = min(total, cap)

    if final >= 8.5:
        label = "Excelente"
    elif final >= 7:
        label = "Fiable"
    elif final >= 5.5:
        label = "Aceptable con reservas"
    elif final >= 4:
        label = "Deficiente"
    else:
        label = "Poco fiable"
    return {"nota": round(final, 1), "etiqueta": label, "desglose": breakdown,
            "limite": cap_reason, "nota_sin_limite": round(total, 1)}
