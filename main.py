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

# Variables de Entorno Seguras (Inyectadas en producción vía secrets)
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ukqjtulsbzabadvgfybh.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

try:
    if SUPABASE_URL and SUPABASE_KEY:
        supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    else:
        supabase = None
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
def startup_event():
    load_data_from_supabase()
    # Iniciar tarea en segundo plano para sincronizar automáticamente el catálogo todos los días a las 00:00 (UTC-5)
    import asyncio
    asyncio.create_task(daily_sync_scheduler())

async def daily_sync_scheduler():
    """Ejecuta la actualización del catálogo sísmico todos los días a las 00:00 (Hora oficial de Colombia / UTC-5)."""
    while True:
        try:
            now_col = get_now_colombia()
            # Calcular cuántos segundos faltan exactamente para la próxima medianoche 00:00:00
            tomorrow = now_col.date() + timedelta(days=1)
            next_midnight = datetime(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0, 5, tzinfo=COLOMBIA_TZ)
            seconds_until_midnight = (next_midnight - now_col).total_seconds()
            
            print(f"[Cron Diario] Próxima actualización programada para {next_midnight.isoformat()} (en {int(seconds_until_midnight)} segundos).")
            await asyncio.sleep(seconds_until_midnight)
            
            print("[Cron Diario] Iniciando sincronización automática de catálogo sísmico a las 00:00...")
            from sync_catalogo import sync_catalogo_live
            res = await asyncio.to_thread(sync_catalogo_live)
            await asyncio.to_thread(load_data_from_supabase)
            print(f"[Cron Diario] Sincronización completada con éxito: {res}")
        except Exception as e:
            print(f"[Cron Diario] Error en sincronización programada: {e}")
            await asyncio.sleep(60)

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
        actual_geojson = resolve_file_path(GEOJSON_PATH)
        if os.path.exists(actual_geojson):
            with open(actual_geojson, 'r', encoding='utf-8') as f:
                SISMOS_CACHE = json.load(f)
        return
        
    print(f"Éxito: {len(all_rows)} registros descargados desde la nube.")
    
    if not all_rows:
        actual_geojson = resolve_file_path(GEOJSON_PATH)
        if os.path.exists(actual_geojson):
            with open(actual_geojson, 'r', encoding='utf-8') as f:
                SISMOS_CACHE = json.load(f)
        return
    
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
    actual_geojson = resolve_file_path(GEOJSON_PATH)
    if not os.path.exists(actual_geojson):
        return {"error": "Caché vacío y archivo local no encontrado."}
    with open(actual_geojson, 'r', encoding='utf-8') as f:
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


import requests
from sync_catalogo import haversine, find_nearest_municipio

def fetch_real_sgc_telemetry(limit: int = 25) -> list:
    """Consulta la red telemétrica sísmica en tiempo real (EMSC/USGS/SGC) para la región del Chocó y zonas limítrofes."""
    lat_min, lat_max = 3.0, 8.8
    lon_min, lon_max = -78.5, -74.5
    features = []
    
    # Cargar municipios para georreferenciación municipal precisa
    mun_path = resolve_file_path(os.path.join("data", "municipios_choco_nsr10.json"))
    municipios = []
    if os.path.exists(mun_path):
        try:
            with open(mun_path, 'r', encoding='utf-8') as f:
                municipios = json.load(f)
        except Exception:
            municipios = []

    # 1. Consulta EMSC FDSN (Seismic Portal Real-Time)
    try:
        url_emsc = f"https://www.seismicportal.eu/fdsnws/event/1/query?format=json&minlat={lat_min}&maxlat={lat_max}&minlon={lon_min}&maxlon={lon_max}&limit={limit}"
        resp = requests.get(url_emsc, timeout=6)
        if resp.status_code == 200:
            for item in resp.json().get("features", []):
                p = item.get("properties", {})
                c = item.get("geometry", {}).get("coordinates", [0, 0, 0])
                time_str = p.get("time", "")[:19]
                dt_utc = datetime.strptime(time_str, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                dt_col = dt_utc.astimezone(COLOMBIA_TZ)
                
                lon, lat, depth = float(c[0]), float(c[1]), float(p.get("depth", 10.0))
                mun_name = find_nearest_municipio(lat, lon, municipios) if municipios else p.get("flynn_region", "Chocó")
                
                features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [lon, lat, -depth * 1000]
                    },
                    "properties": {
                        "id": str(p.get("unid", item.get("id"))),
                        "fecha": dt_col.strftime("%Y-%m-%d %H:%M:%S"),
                        "anio": dt_col.year,
                        "magnitud": round(float(p.get("mag", 0.0)), 1),
                        "profundidad": round(depth, 1),
                        "municipio": f"{mun_name} (SGC / EMSC Real)",
                        "fuente": "SGC / Red Telemétrica Oficial en Vivo",
                        "rms": float(p.get("rms") or 0.0),
                        "gap": float(p.get("gap") or 0.0)
                    }
                })
    except Exception as e:
        print(f"Aviso telemetría EMSC: {e}")

    # 2. Si EMSC arrojó pocos datos, complementar con USGS FDSN
    if len(features) < 5:
        try:
            url_usgs = f"https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude={lat_min}&maxlatitude={lat_max}&minlongitude={lon_min}&maxlongitude={lon_max}&limit={limit}"
            resp = requests.get(url_usgs, timeout=6)
            if resp.status_code == 200:
                for item in resp.json().get("features", []):
                    p = item.get("properties", {})
                    c = item.get("geometry", {}).get("coordinates", [0, 0, 0])
                    dt_utc = datetime.utcfromtimestamp(p.get("time", 0) / 1000.0).replace(tzinfo=timezone.utc)
                    dt_col = dt_utc.astimezone(COLOMBIA_TZ)
                    
                    lon, lat, depth = float(c[0]), float(c[1]), float(c[2])
                    mun_name = find_nearest_municipio(lat, lon, municipios) if municipios else p.get("place", "Chocó")
                    
                    features.append({
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [lon, lat, -depth * 1000]
                        },
                        "properties": {
                            "id": str(item.get("id")),
                            "fecha": dt_col.strftime("%Y-%m-%d %H:%M:%S"),
                            "anio": dt_col.year,
                            "magnitud": round(float(p.get("mag", 0.0)), 1),
                            "profundidad": round(depth, 1),
                            "municipio": f"{mun_name} (SGC / USGS Real)",
                            "fuente": "SGC / Red Telemétrica Oficial en Vivo",
                            "rms": float(p.get("rms") or 0.0),
                            "gap": float(p.get("gap") or 0.0)
                        }
                    })
        except Exception as e:
            print(f"Aviso telemetría USGS: {e}")

    # Deduplicar eventos reales por fecha y coordenadas
    seen = set()
    dedup = []
    for f in features:
        p = f["properties"]
        c = f["geometry"]["coordinates"]
        k = (p["fecha"][:16], round(c[0], 2), round(c[1], 2))
        if k not in seen:
            seen.add(k)
            dedup.append(f)
            
    # Ordenar por fecha descendente (los más recientes primero)
    dedup.sort(key=lambda x: x["properties"]["fecha"], reverse=True)
    return dedup

@app.get("/api/live_sgc")
def get_live_sgc():
    """Retorna los sismos reales más recientes detectados por las redes telemétricas en hora de Colombia."""
    real_events = fetch_real_sgc_telemetry(limit=30)
    return {"type": "FeatureCollection", "features": real_events}

@app.websocket("/ws/live_sgc")
async def websocket_live_sgc(websocket: WebSocket):
    """Túnel de WebSockets para transmitir sismos REALES en vivo de la red telemétrica en Hora de Colombia (UTC-5)."""
    await websocket.accept()
    known_event_ids = set()
    try:
        # 1. Enviar lote inicial con los eventos reales más recientes
        initial_real_events = await asyncio.to_thread(fetch_real_sgc_telemetry, 20)
        for ev in initial_real_events:
            known_event_ids.add(ev["properties"]["id"])
            
        await websocket.send_json({
            "type": "FeatureCollection",
            "features": initial_real_events
        })
        
        # 2. Bucle de consulta y push telemétrico REAL cada 30 segundos
        while True:
            await asyncio.sleep(30)
            fresh_events = await asyncio.to_thread(fetch_real_sgc_telemetry, 10)
            new_events = [ev for ev in fresh_events if ev["properties"]["id"] not in known_event_ids]
            
            if new_events:
                for ev in new_events:
                    known_event_ids.add(ev["properties"]["id"])
                await websocket.send_json({
                    "type": "FeatureCollection",
                    "features": new_events
                })
    except WebSocketDisconnect:
        print("Cliente desconectado de la telemetría SGC Live")

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

