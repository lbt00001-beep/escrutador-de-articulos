"""Pruebas de las notas v2 (sin IA): python -m unittest discover tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import analyze, scoring  # noqa: E402


def crit(value):
    return {k: {"puntuacion": value, "justificacion": ""} for k in scoring.QUALITY_CRITERIA}


def fact(veredicto, central=False, confianza="alta"):
    return {"afirmacion": "x", "veredicto": veredicto, "central": central, "confianza": confianza}


class ReliabilityTests(unittest.TestCase):
    def test_no_facts_gives_none_and_global_equals_quality(self):
        r = {"genero": "Opinión / columna", "verificacion": [], "criterios": crit(8)}
        p = scoring.score(r)
        self.assertIsNone(p["fiabilidad"]["nota"])
        self.assertEqual(p["nota"], 8.0)

    def test_low_confidence_does_not_count(self):
        con = scoring.reliability([fact("Correcto"), fact("Incorrecto", confianza="baja")])
        sin = scoring.reliability([fact("Correcto")])
        self.assertEqual(con["nota"], sin["nota"])

    def test_central_facts_weigh_double(self):
        central_ok = scoring.reliability([fact("Correcto", central=True), fact("Incorrecto")])["nota"]
        central_ko = scoring.reliability([fact("Correcto"), fact("Incorrecto", central=True)])["nota"]
        self.assertGreater(central_ok, central_ko)

    def test_smoothing_dampens_single_verdict_but_not_many(self):
        one_error = scoring.reliability([fact("Incorrecto")])["nota"]
        many_errors = scoring.reliability([fact("Incorrecto", central=True)] * 5)["nota"]
        self.assertGreater(one_error, 3.0)   # un solo veredicto no hunde la nota a 0
        self.assertLess(many_errors, 1.0)    # una pauta de falsedades sí

    def test_unverifiable_is_ignored(self):
        self.assertEqual(scoring.reliability([fact("Correcto"), fact("No verificable")])["hechos_contados"], 1)


class GenreTests(unittest.TestCase):
    def test_rubric_weights_sum_one(self):
        for g, r in scoring.RUBRICS.items():
            self.assertAlmostEqual(sum(r["criterios"].values()), 1.0, places=6, msg=g)

    def test_column_not_penalized_for_sources_or_balance(self):
        c = crit(8)
        c["atribucion_fuentes"]["puntuacion"] = 2
        c["equilibrio_voces"]["puntuacion"] = 2
        r = {"genero": "Opinión / columna", "verificacion": [fact("Correcto")], "criterios": c}
        self.assertEqual(scoring.score(r)["calidad"]["nota"], 8.0)
        self.assertEqual(scoring.score(r, "Noticia")["calidad"]["nota"], 5.0)

    def test_rescore_changes_rubric_not_facts(self):
        r = {"genero": "Noticia", "verificacion": [fact("Correcto")], "criterios": crit(6),
             "_meta": {"criterios_version": 2}}
        p = analyze.rescore(r, "Opinión / columna")
        self.assertEqual(p["genero"], "Opinión / columna")
        self.assertEqual(p["genero_detectado"], "Noticia")
        self.assertEqual(p["fiabilidad"]["nota"], scoring.score(r)["fiabilidad"]["nota"])


class CapTests(unittest.TestCase):
    def test_central_high_confidence_falsehood_caps_at_5(self):
        r = {"genero": "Noticia", "criterios": crit(10),
             "verificacion": [fact("Incorrecto", central=True)] + [fact("Correcto")] * 8}
        p = scoring.score(r)
        self.assertEqual(p["nota"], 5.0)
        self.assertTrue(p["limite"])

    def test_non_central_or_medium_confidence_does_not_cap(self):
        r = {"genero": "Noticia", "criterios": crit(10),
             "verificacion": [fact("Incorrecto", confianza="media", central=True)] + [fact("Correcto")] * 8}
        self.assertGreater(scoring.score(r)["nota"], 5.0)


class NormalizeTests(unittest.TestCase):
    def test_verdict_variants(self):
        self.assertEqual(analyze._closest("correcta", scoring.FACT_VERDICTS, "?"), "Correcto")
        self.assertEqual(analyze._closest("Incorrecta", scoring.FACT_VERDICTS, "?"), "Incorrecto")
        self.assertEqual(analyze._closest("parcialmente correcta", scoring.FACT_VERDICTS, "?"), "Parcialmente correcto")
        self.assertEqual(analyze._fix_idea_verdict("Opinión"), "Opinión discutible")
        self.assertEqual(analyze._fix_idea_verdict("opinion sin fundamento"), "Opinión sin fundamento")

    def test_normalize_fills_shapes(self):
        r = {"genero": "columna de opinión", "omisiones": ["algo"],
             "verificacion": [{"veredicto": "falso", "confianza": "ALTA", "central": "true"}]}
        analyze._normalize(r)
        self.assertEqual(r["omisiones"][0]["omision"], "algo")
        self.assertEqual(r["verificacion"][0]["confianza"], "alta")
        self.assertTrue(r["verificacion"][0]["central"])


if __name__ == "__main__":
    unittest.main()
