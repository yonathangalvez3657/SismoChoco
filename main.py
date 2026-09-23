from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import json
import os
import numpy as np
from datetime import datetime, timezone, timedelta
import random
from sklearn.cluster import DBSCAN

# Zona Horaria Oficial de Colombia: America/Bogota (UTC-5)
COLOMBIA_TZ = timezone(timedelta(hours=-5))

def get_now_colombia() -> datetime:
    """Retorna la fecha y hora oficial de Colombia (UTC-5) independiente de la región del servidor."""
    return datetime.now(COLOMBIA_TZ)

app = FastAPI(
    title="SismoChocó API — Backend Analítico (RtD)",
    description="Motor analítico y de agrupamiento espacio-temporal para la plataforma interactiva de visualización de acumulación de tensión sísmica en el departamento del Chocó (Universidad de Caldas - Maestría en Diseño y Creación Interactiva)",
    version="2.0.0"
)

# Configuración de Orígenes Permitidos (CORS Seguro)
raw_origins = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = [o.strip() for o in raw_origins.split(",") if o.strip()] if raw_origins != "*" else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Middleware de Cabeceras de Seguridad HTTP (OWASP Best Practices)
@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

from fastapi.staticfiles import StaticFiles
from supabase import create_client, Client
from fastapi import Header, HTTPException, status

GEOJSON_PATH = "sismicidad_choco_consolidado.geojson"
ADMIN_SECRET_TOKEN = os.getenv("ADMIN_SECRET_TOKEN", "sismochoco_secure_admin_2026")

def resolve_file_path(relative_path: str) -> str:
    """Resuelve la ruta de un archivo tanto si la app corre en la raíz como dentro de app/."""
    candidates = [
        os.path.join(os.path.dirname(__file__), relative_path),
        os.path.join(os.path.dirname(__file__), "app", relative_path),
        os.path.join(os.getcwd(), relative_path),
        os.path.join(os.getcwd(), "app", relative_path)
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

# Variables de Entorno Seguras con Fallback
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ukqjtulsbzabadvgfybh.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcWp0dWxzYnphYmFkdmdmeWJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTI1MzYxNSwiZXhwIjoyMTA0ODI5NjE1fQ.NNZTb2ic2OnLkzE0qqsc9m0E08nv4-jFvozQJh-hsrM")

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
except Exception:
    supabase = None

# Caché en memoria para evitar latencia de base de datos
SISMOS_CACHE = None

@app.get("/api/health")
def healthcheck():
    """Endpoint de monitoreo del estado de la plataforma."""
    count = len(SISMOS_CACHE.get("features", [])) if SISMOS_CACHE else 0
    return {
        "status": "ok",
        "service": "SismoChocó API",
        "timestamp": get_now_colombia().isoformat(),
        "timezone": "America/Bogota (UTC-5)",
        "total_eventos": count
    }

@app.on_event("startup")
def load_data_from_supabase():
    global SISMOS_CACHE
    actual_geojson = resolve_file_path(GEOJSON_PATH)
    if not supabase:
        print("Advertencia: No se pudo conectar a Supabase. Usando catálogo local.")
        if os.path.exists(actual_geojson):
            with open(actual_geojson, 'r', encoding='utf-8') as f:
                SISMOS_CACHE = json.load(f)
        return
        
    print("Descargando catálogo desde Supabase...")
    all_rows = []
    page_size = 1000
    try:
        for i in range(20): # Límite seguro de 20k registros
            res = supabase.table("sismos").select("*").range(i*page_size, (i+1)*page_size - 1).execute()
            data = res.data
            if not data:
                break
            all_rows.extend(data)
    except Exception as e:
        print(f"Error descargando datos de Supabase: {e}. Usando fallback local.")
        if os.path.exists(GEOJSON_PATH):
            with open(GEOJSON_PATH, 'r', encoding='utf-8') as f:
                SISMOS_CACHE = json.load(f)
        return
        
    print(f"Éxito: {len(all_rows)} registros descargados desde la nube.")
    
    # Transformar a FeatureCollection
    features = []
    for row in all_rows:
        geom = row.pop("ubicacion", None)
        if not geom: continue
        
        # Extraemos el año para el slider
        anio = 2024
        try:
            anio = int(str(row.get("fecha"))[:4])
        except:
            pass
            
        row["anio"] = anio
        
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": row
        })
        
    SISMOS_CACHE = {
        "type": "FeatureCollection",
        "features": features
    }

@app.get("/api/sismos")
def get_sismos():
    if SISMOS_CACHE:
        return SISMOS_CACHE
    
    # Fallback local
    if not os.path.exists(GEOJSON_PATH):
        return {"error": "Caché vacío y archivo local no encontrado."}
    with open(GEOJSON_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def verify_admin_token(x_admin_token: str = Header(None)):
    """Verifica autenticación para endpoints administrativos."""
    expected_token = os.getenv("ADMIN_SECRET_TOKEN", "sismochoco_secure_admin_2026")
    # Si estamos en localhost/dev o se proporciona el token válido
    if x_admin_token != expected_token and os.getenv("ENVIRONMENT") == "production":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Acceso denegado: Token de autorización administrativa inválido o no suministrado."
        )

@app.get("/api/sismos/reload")
@app.post("/api/sismos/reload")
def reload_sismos(x_admin_token: str = Header(None)):
    """Recarga el catálogo sísmico en memoria desde Supabase o archivo consolidado."""
    verify_admin_token(x_admin_token)
    load_data_from_supabase()
    count = len(SISMOS_CACHE.get("features", [])) if SISMOS_CACHE else 0
    return {"status": "ok", "message": "Catálogo sísmico recargado", "total_eventos": count}

@app.get("/api/sismos/sync")
@app.post("/api/sismos/sync")
def sync_sismos(x_admin_token: str = Header(None)):
    """Sincroniza el catálogo en vivo consultando USGS y EMSC y recarga la memoria."""
    verify_admin_token(x_admin_token)
    try:
        from sync_catalogo import sync_catalogo_live
        res = sync_catalogo_live()
        load_data_from_supabase()
        return {"status": "ok", "resultado": res}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/fallas")
def get_fallas():
    fallas_path = resolve_file_path(os.path.join("data", "fallas.geojson"))
    if not os.path.exists(fallas_path):
        return {"features": []}
    with open(fallas_path, 'r', encoding='utf-8') as f:
        return json.load(f)

@app.get("/api/municipios_nsr10")
def get_municipios_nsr10():
    """Retorna los parámetros oficiales NSR-10 y geotecnia de 67 municipios (Chocó, Risaralda, Caldas, Valle del Cauca)."""
    path = resolve_file_path(os.path.join("data", "municipios_choco_nsr10.json"))
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

@app.get("/api/infraestructura")
def get_infraestructura():
    """Retorna la red de infraestructura crítica (vías primarias, navegación fluvial, hospitales y aeropuertos)."""
    path = resolve_file_path(os.path.join("data", "vias_infraestructura.geojson"))
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"type": "FeatureCollection", "features": []}


from fastapi import WebSocket, WebSocketDisconnect
import asyncio
import random

@app.websocket("/ws/live_sgc")
async def websocket_live_sgc(websocket: WebSocket):
    """Túnel de WebSockets para transmitir sismos en tiempo real simulando SGC Live en Hora de Colombia (UTC-5)."""
    await websocket.accept()
    try:
        # Enviar historial inicial (mock) con hora oficial de Colombia (UTC-5)
        now_col = get_now_colombia()
        historial = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": { "type": "Point", "coordinates": [-76.5, 4.8, -35000] },
                    "properties": {
                        "fecha": now_col.strftime('%Y-%m-%d %H:%M'), "anio": now_col.year,
                        "magnitud": 4.1, "profundidad": 35.0, "municipio": "Nóvita - Chocó (SGC Live Inicial - Hora Colombia)"
                    }
                }
            ]
        }
        await websocket.send_json(historial)
        
        # Bucle de transmisión en tiempo real
        while True:
            await asyncio.sleep(random.randint(4, 10))
            cur_col = get_now_colombia()
            nuevo_sismo = {
                "type": "FeatureCollection",
                "features": [{
                    "type": "Feature",
                    "geometry": { "type": "Point", "coordinates": [-76.5 + random.uniform(-1, 1), 5.5 + random.uniform(-1, 1), -random.randint(10, 100)*1000] },
                    "properties": {
                        "fecha": cur_col.strftime('%Y-%m-%d %H:%M:%S'),
                        "anio": cur_col.year,
                        "magnitud": round(random.uniform(2.5, 5.5), 1),
                        "profundidad": round(random.uniform(10.0, 100.0), 1),
                        "municipio": "SGC Live (WebSocket Push - Hora Colombia)"
                    }
                }]
            }
            await websocket.send_json(nuevo_sismo)
    except WebSocketDisconnect:
        print("Cliente desconectado del satélite SGC Live")

@app.get("/api/ml_clusters")
def get_ml_clusters():
    """Detecta clústeres espaciales densos (Seismic Gaps) usando DBSCAN (Cloud-Cache)."""
    global SISMOS_CACHE
    actual_geojson = resolve_file_path(GEOJSON_PATH)
    if not SISMOS_CACHE:
        if os.path.exists(actual_geojson):
            with open(actual_geojson, 'r', encoding='utf-8') as f:
                SISMOS_CACHE = json.load(f)
        else:
            return {"features": []}
    
    try:
        from sklearn.cluster import DBSCAN
        import numpy as np
    except ImportError:
        return {"features": []}
        
    puntos_raw = []
    mags_raw = []
    municipios_raw = []
    prof_raw = []
    fechas_raw = []
    for f in SISMOS_CACHE.get("features", []):
        m = f["properties"].get("magnitud", 0)
        if m >= 4.0:
            coords = f["geometry"]["coordinates"]
            puntos_raw.append([coords[0], coords[1]]) # [lon, lat]
            mags_raw.append(m)
            municipios_raw.append(f["properties"].get("municipio", "Chocó"))
            prof_raw.append(f["properties"].get("profundidad", 0))
            fechas_raw.append(f["properties"].get("fecha", ""))
            
    if not puntos_raw:
        return {"features": []}
        
    coords_np = np.array(puntos_raw)
    # Haversine requiere [latitud, longitud] en radianes
    coords_lat_lon_rad = np.radians(coords_np[:, [1, 0]])
    
    # Radio de 15 km expresado en radianes terrestres (R_tierra = 6371 km)
    eps_rad = 15.0 / 6371.0
    clustering = DBSCAN(eps=eps_rad, min_samples=8, metric='haversine').fit(coords_lat_lon_rad)
    
    ml_features = []
    for idx, label in enumerate(clustering.labels_):
        if label != -1: 
            ml_features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [float(coords_np[idx][0]), float(coords_np[idx][1]), 0]},
                "properties": {
                    "cluster_id": int(label),
                    "magnitud": float(mags_raw[idx]),
                    "municipio": str(municipios_raw[idx]).replace('_', ' '),
                    "profundidad": float(prof_raw[idx]),
                    "fecha": str(fechas_raw[idx])
                }
            })
            
    return {"type": "FeatureCollection", "features": ml_features}

@app.get("/api/openquake_mock")
def get_openquake_mock():
    """Retorna los resultados Genuinos de OpenQuake calculados en el M3."""
    file_path = resolve_file_path(os.path.join('data', 'oq_resultados.geojson'))
    if os.path.exists(file_path):
        with open(file_path, 'r') as f:
            data = json.load(f)
            for feature in data.get('features', []):
                feature['properties']['retorno'] = 475
            return data
    return {"type": "FeatureCollection", "features": []}

# Montaje de la aplicación web estática para producción unificada (Procfile / Hosting)
# Si main.py está dentro de app/, el directorio estático es el mismo directorio de main.py
if os.path.exists(os.path.join(os.path.dirname(__file__), "index.html")):
    STATIC_DIR = os.path.dirname(__file__)
else:
    STATIC_DIR = os.path.join(os.path.dirname(__file__), "app")

if os.path.exists(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="frontend")

