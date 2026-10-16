"""Indicadores objetivos del texto calculados localmente (sin IA)."""
import re

_WORD = re.compile(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+")
_SENT_SPLIT = re.compile(r"(?<=[.!?…])[\"»”’)]*\s+|\n+")
_VOWELS = "aeiouáéíóúüy"

_ES_STOP = {"de", "la", "que", "el", "en", "y", "los", "se", "del", "las", "por", "un", "para", "con", "una", "su", "al", "es", "lo", "como"}
_EN_STOP = {"the", "of", "and", "to", "in", "is", "that", "for", "it", "on", "with", "as", "was", "by", "are", "this", "be"}

# Expresiones de atribución de fuentes
ATTRIBUTION = {
    "es": r"\b(según|de acuerdo con|afirm[óa]|declar[óa]|señal[óa]|explic[óa]|asegur[óa]|inform[óa]|"
          r"datos de(l)?|informe|estudio|encuesta|estadística|INE|Eurostat|OCDE|FMI|BOE|fuentes? de)\b",
    "en": r"\b(according to|said|stated|reported|told|data from|report|study|survey|statistics|sources?)\b",
}
# Términos absolutos o de certeza retórica
ABSOLUTES = {
    "es": r"\b(siempre|nunca|jamás|todos|todas|nadie|nada|sin duda|evidentemente|obviamente|indudablemente|"
          r"absolutamente|totalmente|completamente|cualquiera sabe|es indiscutible)\b",
    "en": r"\b(always|never|everyone|nobody|nothing|undoubtedly|obviously|clearly|absolutely|totally|unquestionably)\b",
}
# Lenguaje emocional / sensacionalista
LOADED = {
    "es": r"\b(escándalo\w*|vergüenza|vergonzos\w+|brutal\w*|catastróf\w+|catástrofe|desastr\w+|indignant\w*|"
          r"bochorn\w+|terribl\w+|histór\w+|demoledor\w*|ruina|caos|traición|traidor\w*|mentir\w*|mentiros\w+|"
          r"ataque|asalto|infame|lamentabl\w+|sectari\w+|radical\w*|golpe|dictadura|fascis\w+|comunis\w+)\b",
    "en": r"\b(scandal\w*|shameful|outrage\w*|disaster\w*|catastroph\w+|chaos|betray\w*|liar\w*|lies|"
          r"attack\w*|disgrace\w*|radical\w*|extremist\w*|horrific|devastating|shocking)\b",
}
HEDGES = {
    "es": r"\b(quizá(s)?|tal vez|posiblemente|probablemente|parece|podría|al parecer|presuntamente|aparentemente)\b",
    "en": r"\b(perhaps|maybe|possibly|probably|seems|might|could|allegedly|apparently)\b",
}
FIRST_PERSON = {
    "es": r"\b(yo|creo|pienso|opino|me parece|considero|nosotros|nuestr[oa]s?)\b",
    "en": r"\b(I|I think|I believe|in my opinion|we|our)\b",
}


def detect_language(text: str) -> str:
    words = [w.lower() for w in _WORD.findall(text[:5000])]
    es = sum(w in _ES_STOP for w in words)
    en = sum(w in _EN_STOP for w in words)
    return "es" if es >= en else "en"


def _syllables(word: str) -> int:
    word = word.lower()
    groups = re.findall(rf"[{_VOWELS}]+", word)
    return max(1, len(groups))


def _per_1000(count: int, words: int) -> float:
    return round(count * 1000 / words, 1) if words else 0.0


def compute(text: str, links: list) -> dict:
    lang = detect_language(text)
    words = _WORD.findall(text)
    n_words = len(words)
    sentences = [s for s in _SENT_SPLIT.split(text) if len(s.split()) > 2] or [text]
    n_sent = len(sentences)
    syll = sum(_syllables(w) for w in words)

    if n_words:
        if lang == "es":  # Fernández-Huerta
            readability = 206.84 - 60 * (syll / n_words) - 1.02 * (n_words / n_sent)
        else:  # Flesch Reading Ease
            readability = 206.835 - 84.6 * (syll / n_words) - 1.015 * (n_words / n_sent)
    else:
        readability = 0
    readability = max(0, min(100, round(readability, 1)))
    if readability >= 70:
        level = "Fácil"
    elif readability >= 60:
        level = "Normal"
    elif readability >= 50:
        level = "Algo difícil"
    elif readability >= 30:
        level = "Difícil"
    else:
        level = "Muy difícil"

    def count(pat):
        return len(re.findall(pat, text, re.I))

    numbers = len(re.findall(r"\b\d+(?:[.,]\d+)*\s*(?:%|por ciento|percent|millones|millions|mil|euros|€|\$)?", text))
    quotes = len(re.findall(r"«[^»]{8,}»|“[^”]{8,}”|\"[^\"]{8,}\"", text))
    loaded_hits = re.findall(LOADED[lang], text, re.I)
    loaded_top = {}
    for w in loaded_hits:
        loaded_top[w.lower()] = loaded_top.get(w.lower(), 0) + 1

    return {
        "idioma": "Español" if lang == "es" else "Inglés",
        "palabras": n_words,
        "frases": n_sent,
        "minutos_lectura": max(1, round(n_words / 220)),
        "palabras_por_frase": round(n_words / n_sent, 1) if n_sent else 0,
        "legibilidad": readability,
        "legibilidad_nivel": level,
        "legibilidad_indice": "Fernández-Huerta" if lang == "es" else "Flesch",
        "cifras": numbers,
        "cifras_por_1000": _per_1000(numbers, n_words),
        "citas_textuales": quotes,
        "atribuciones": count(ATTRIBUTION[lang]),
        "enlaces_externos": len(links),
        "absolutos": count(ABSOLUTES[lang]),
        "matizadores": count(HEDGES[lang]),
        "primera_persona": count(FIRST_PERSON[lang]),
        "lenguaje_cargado": len(loaded_hits),
        "lenguaje_cargado_por_1000": _per_1000(len(loaded_hits), n_words),
        "lenguaje_cargado_ejemplos": sorted(loaded_top, key=loaded_top.get, reverse=True)[:8],
        "exclamaciones": text.count("!"),
        # Textos muy cortos suelen indicar muro de pago o extracción parcial
        "posible_texto_parcial": n_words < 400,
    }
