"""Arranque local: python run.py [puerto] [--public]

--public simula la versión web (cada visitante usa su clave y su historial en el navegador)."""
import os
import sys

import uvicorn

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--public"]
    if "--public" in sys.argv:
        os.environ["ESCRUTADOR_PUBLIC"] = "1"
    from app.config import PORT
    port = int(args[0]) if args else PORT
    print(f"Escrutador de Artículos en http://localhost:{port}")
    uvicorn.run("app.main:app", host="127.0.0.1", port=port)
