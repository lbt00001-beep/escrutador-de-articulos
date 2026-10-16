"""Análisis del artículo con un LLM vía OpenRouter (criterios v2).

Método: 1) clasificar las afirmaciones (hecho / interpretación / valoración / recurso retórico /
predicción); 2) verificar solo los hechos; 3) evaluar la calidad con todos los criterios; las notas
las calcula app/scoring.py según el género."""
import json
import re
from datetime import date

import httpx

from .config import OPENROUTER_URL, MAX_ARTICLE_CHARS, get_api_key
from .scoring import FACT_VERDICTS, GENRES, QUALITY_CRITERIA, RUBRICS, score

CRITERIA_VERSION = 2

CLAIM_CLASSES = ["Hecho", "Interpretación", "Valoración", "Recurso retórico", "Predicción"]
OPINION_VERDICTS = ["Opinión bien fundamentada", "Opinión discutible", "Opinión sin fundamento"]
# Las ideas pueden ser hechos (se verifican) u opiniones (se valora su fundamento)
IDEA_VERDICTS = FACT_VERDICTS + OPINION_VERDICTS
CONFIDENCE = ["alta", "media", "baja"]

SOURCE_TYPES = ["Estadística u organismo oficial", "Estudio científico o académico", "Informe de organización",
                "Medio de comunicación", "Experto o testimonio", "Documento legal o judicial",
                "Declaración de parte interesada", "Elaboración propia del autor", "Sin fuente"]


def _str(desc=""):
    return {"type": "string", "description": desc} if desc else {"type": "string"}


def _enum(values, desc=""):
    d = {"type": "string", "enum": values}
    if desc:
        d["description"] = desc
    return d


def _obj(props: dict):
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def _arr(items):
    return {"type": "array", "items": items}


_bool = {"type": "boolean"}
_idea = _obj({"idea": _str("Idea formulada en una frase"),
              "veredicto": _enum(IDEA_VERDICTS),
              "justificacion": _str("Por qué recibe ese veredicto, en 1-2 frases")})

SCHEMA = _obj({
    "titulo_inferido": _str("Título del artículo"),
    "genero": _enum(GENRES, "Género periodístico del texto"),
    "resumen": _str("Resumen neutral en 2-3 frases"),
    "tesis": _str("Tesis o mensaje central que el autor quiere transmitir"),
    "afirmaciones": _arr(_obj({
        "texto": _str("Afirmación del artículo, parafraseada en una frase"),
        "clase": _enum(CLAIM_CLASSES),
        "central": {"type": "boolean", "description": "true si sostiene la tesis del artículo"},
    })),
    "datos_del_autor": _arr(_obj({
        "dato": _str("Dato, cifra o hecho en que se apoya el autor"),
        "fuente_citada": _str("Fuente que menciona el autor, o 'Sin fuente'"),
        "tipo_fuente": _enum(SOURCE_TYPES),
        "fragmento": _str("Cita literal breve del artículo (máx. 25 palabras)"),
    })),
    "verificacion": _arr(_obj({
        "afirmacion": _str("Afirmación de clase Hecho"),
        "central": _bool,
        "veredicto": _enum(FACT_VERDICTS),
        "confianza": _enum(CONFIDENCE, "Seguridad del veredicto según la evidencia encontrada"),
        "evidencia": _str("Datos concretos que confirman o refutan la afirmación, con cifras y fechas"),
        "fuentes": _arr(_obj({"titulo": _str(), "url": _str("URL real consultada o vacío si no hay")})),
    })),
    "ideas_principales": _arr(_obj({
        "idea": _str("Idea principal en una frase"),
        "veredicto": _enum(IDEA_VERDICTS),
        "justificacion": _str("Por qué recibe ese veredicto, en 1-2 frases"),
        "secundarias": _arr(_idea),
    })),
    "falacias_y_sesgos": _arr(_obj({
        "tipo": _str("Nombre de la falacia o sesgo"),
        "fragmento": _str("Cita literal breve"),
        "explicacion": _str(),
        "confianza": _enum(["alta", "media"]),
    })),
    "omisiones": _arr(_obj({"omision": _str("Contexto o dato relevante que el artículo omite"),
                            "relevancia": _enum(["alta", "media"])})),
    "perspectivas": _obj({"presentes": _arr(_str()), "ausentes": _arr(_str())}),
    "criterios": _obj({k: _obj({"puntuacion": {"type": "number", "description": "0 a 10"},
                                "justificacion": _str("1-2 frases")}) for k in QUALITY_CRITERIA}),
    "fortalezas": _arr(_str()),
    "debilidades": _arr(_str()),
    "valoracion_global": _str("Valoración final razonada en 3-4 frases, empezando por lo mejor del texto"),
})

SYSTEM_PROMPT = """Eres un editor jefe y verificador de datos con larga experiencia: conoces el método de \
Maldita, Newtral o Full Fact, pero también sabes qué hace grande una columna, un reportaje o una noticia. \
Evalúas con justicia: ni complaciente ni buscando defectos. Responde SIEMPRE en español.

MÉTODO (sigue los pasos en orden)

1. GÉNERO. Identifica el género ("genero"). Cada género tiene obligaciones distintas: una noticia debe \
atribuir fuentes y recoger voces; una columna de opinión es un argumento de parte y NO está obligada a citar \
fuentes ni a dar la palabra al adversario; un análisis debe razonar y documentar; un reportaje, aportar trabajo \
propio. Nunca penalices un texto por algo que su género no exige.

2. CLASIFICA antes de juzgar ("afirmaciones", hasta 20, las más relevantes). Cada afirmación es:
   - Hecho: comprobable con datos (cifras, fechas, sucesos, quién dijo qué).
   - Interpretación: lectura o explicación de hechos (causas, motivos, intenciones, significado).
   - Valoración: juicio de valor o preferencia.
   - Recurso retórico: hipérbole, ironía, metáfora o fórmula expresiva que no pretende ser literal \
     (p. ej. "el preámbulo más corto de todas las constituciones" dicho para subrayar su concisión).
   - Predicción: afirmación sobre el futuro.
   Marca "central" las que sostienen la tesis.

3. VERIFICA SOLO LOS HECHOS ("verificacion", hasta 12, priorizando los centrales). Contrasta con la búsqueda \
web y tu conocimiento. "evidencia" debe dar datos concretos. Pon en "fuentes" solo URLs reales consultadas; \
nunca inventes URLs. "confianza": alta si la evidencia es directa y clara; media si es indirecta; baja si \
dudas. Ten en cuenta la fecha de publicación. Veredictos: Correcto; Mayormente correcto (necesita un matiz); \
Parcialmente correcto (mezcla de cierto y erróneo); Engañoso (hecho cierto presentado de forma que induce a \
error); Incorrecto (falso); No verificable. No verifiques interpretaciones, valoraciones ni recursos retóricos: \
una intención atribuida al Gobierno o una hipérbole NO son hechos falsos ni "Engañoso".

4. IDEAS ("ideas_principales", 3-7, con 0-4 secundarias). Si la idea es un hecho, usa un veredicto de hecho. \
Si es opinión o interpretación, valora su fundamento: "Opinión bien fundamentada" (se apoya en hechos ciertos \
y un razonamiento sólido), "Opinión discutible" (defendible pero con apoyos débiles o saltos lógicos), \
"Opinión sin fundamento" (contradice los hechos o no ofrece base alguna).

5. RIGOR, con mesura:
   - "falacias_y_sesgos": solo las claras, con "confianza" alta o media. Una lista vacía es una respuesta \
     válida y frecuente en buenos textos. La ironía, la crítica dura o atribuir intenciones con argumentos no \
     son falacias por sí mismos.
   - "omisiones": solo las que cambiarían la conclusión de un lector informado, con su relevancia. No hay \
     cuota: todo texto deja cosas fuera y eso no es un defecto.

6. CALIDAD ("criterios"): puntúa de 0 a 10 TODOS estos criterios (la app elegirá los que exige el género):
{criteria}
   Escala, anclada en el oficio y no en un ideal teórico:
   - 9-10: excepcional, un texto de referencia en su género.
   - 7-8: el estándar profesional. Es la nota NORMAL de un texto competente publicado por un medio serio: \
bien escrito, con hechos correctos y un argumento o una información clara, aunque sea mejorable.
   - 5-6: flojo; cumple a medias, con carencias que un editor habría corregido.
   - 3-4: carencias graves (tergiversa, desinforma, no se sostiene).
   - 0-2: inaceptable (bulo, propaganda, insulto).
   No bajes de 7 a un texto profesional por lo que no podía abarcar en su extensión ni por no ser perfecto: \
justifica cada punto que quites con un defecto concreto del texto. Un 5 NO es neutro: significa «flojo».
   Si un criterio no aplica al género (p. ej. equilibrio de voces o profundidad en una columna breve), \
puntúalo por lo que el texto sí hace y dilo en la justificación; no lo hundas.

7. SÍNTESIS: "fortalezas" y "debilidades" con el mismo cuidado (empieza por las fortalezas); \
"valoracion_global" empezando por lo mejor del texto.

Si el texto parece incompleto (muro de pago, corte abrupto), evalúa solo lo que hay y dilo en el resumen.
Sé imparcial: el mismo rigor sea cual sea la orientación ideológica del texto.
Devuelve exclusivamente el JSON pedido."""


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
- URL: {article.get('url') or '(PDF o texto aportado por el usuario)'}

INDICADORES OBJETIVOS (cálculo automático, solo orientativos)
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
        "HTTP-Referer": "https://escrutador.mbainative.com",
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
        web_results: int = 8, genero: str | None = None) -> dict:
    api_key = api_key or get_api_key()
    if not api_key:
        raise AnalysisError("No hay clave de OpenRouter. Abre ⚙ Ajustes y pega tu clave "
                            "(se obtiene en https://openrouter.ai/keys).")
    criteria_txt = "\n".join(f"   · {k} ({name}): {q}" for k, (name, q) in QUALITY_CRITERIA.items())
    system = SYSTEM_PROMPT.format(criteria=criteria_txt)
    if genero in GENRES:
        system += f"\n\nEl usuario indica que el género del texto es «{genero}»: úsalo en \"genero\"."
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
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
        # Algunos modelos fallan con el modo JSON forzado; el prompt ya pide JSON
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
        "criterios_version": CRITERIA_VERSION,
    }
    _normalize(result)
    if genero in GENRES:
        result["genero"] = genero
    result["puntuacion"] = score(result)
    return result


def _key(s) -> str:
    s = str(s or "").lower()
    for a, b in zip("áéíóúñ", "aeioun"):
        s = s.replace(a, b)
    return re.sub(r"[^a-z]", "", s)


def _closest(value, options: list, default: str) -> str:
    """Ajusta un valor libre al catálogo cerrado (p. ej. 'correcta' -> 'Correcto')."""
    k = _key(value)
    if not k:
        return default
    for v in options:
        if _key(v) == k:
            return v

    def common_prefix(a, b):
        n = 0
        while n < min(len(a), len(b)) and a[n] == b[n]:
            n += 1
        return n

    best = max(options, key=lambda o: common_prefix(k, _key(o)))
    return best if common_prefix(k, _key(best)) >= 5 else default


def _fix_idea_verdict(value) -> str:
    # Compatibilidad: el veredicto genérico "Opinión" de la v1 pasa a "Opinión discutible"
    if _key(value) == "opinion":
        return "Opinión discutible"
    return _closest(value, IDEA_VERDICTS, "No verificable")


def _as_bool(v) -> bool:
    return v is True or str(v).lower() in ("true", "sí", "si", "1")


def _normalize(result: dict) -> None:
    """Garantiza tipos y claves para que la interfaz nunca reciba estructuras incompletas."""
    for k in ("afirmaciones", "datos_del_autor", "verificacion", "ideas_principales", "falacias_y_sesgos",
              "omisiones", "fortalezas", "debilidades"):
        if not isinstance(result.get(k), list):
            result[k] = []
    for k in ("titulo_inferido", "resumen", "tesis", "valoracion_global"):
        result[k] = str(result.get(k) or "")
    result["genero"] = _closest(result.get("genero") or result.get("tipo_texto"), GENRES, "Otro")
    result["tipo_texto"] = result["genero"]  # nombre de la v1, usado por el historial
    if not isinstance(result.get("perspectivas"), dict):
        result["perspectivas"] = {}
    if not isinstance(result.get("criterios"), dict):
        result["criterios"] = {}
    for a in result["afirmaciones"]:
        a["clase"] = _closest(a.get("clase"), CLAIM_CLASSES, "Interpretación")
        a["central"] = _as_bool(a.get("central"))
    for d in result["datos_del_autor"]:
        if d.get("tipo_fuente") not in SOURCE_TYPES:
            d["tipo_fuente"] = "Sin fuente" if "sin fuente" in str(d.get("fuente_citada", "")).lower() else "Otro"
    for item in result["verificacion"]:
        item["veredicto"] = _closest(item.get("veredicto"), FACT_VERDICTS, "No verificable")
        item["confianza"] = _closest(item.get("confianza"), CONFIDENCE, "media")
        item["central"] = _as_bool(item.get("central"))
        if not isinstance(item.get("fuentes"), list):
            item["fuentes"] = []
    for idea in result["ideas_principales"]:
        idea["veredicto"] = _fix_idea_verdict(idea.get("veredicto"))
        if not isinstance(idea.get("secundarias"), list):
            idea["secundarias"] = []
        for s in idea["secundarias"]:
            s["veredicto"] = _fix_idea_verdict(s.get("veredicto"))
    for f in result["falacias_y_sesgos"]:
        f["confianza"] = _closest(f.get("confianza"), ["alta", "media"], "media")
    # Las omisiones pueden llegar como texto suelto (v1) o como objeto (v2)
    result["omisiones"] = [o if isinstance(o, dict) else {"omision": str(o), "relevancia": "media"}
                           for o in result["omisiones"]]
    for o in result["omisiones"]:
        o["relevancia"] = _closest(o.get("relevancia"), ["alta", "media"], "media")


def rescore(result: dict, genero: str) -> dict:
    """Re-evalúa un análisis v2 como otro género sin llamar a la IA."""
    if (result.get("_meta") or {}).get("criterios_version") != CRITERIA_VERSION:
        raise AnalysisError("Este análisis se hizo con los criterios antiguos: vuelve a analizarlo para "
                            "poder evaluarlo por género.")
    if genero not in RUBRICS:
        raise AnalysisError("Género no válido.")
    return score(result, genero)
