from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
import json
import os
import secrets
import asyncio
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

# Configuración de Orígenes Permitidos (CORS Seguro acorde a RFC/Fetch)
raw_origins = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = [o.strip() for o in raw_origins.split(",") if o.strip()] if raw_origins != "*" else ["*"]

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=(False if "*" in allowed_origins else True),
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
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

from supabase import create_client, Client

GEOJSON_PATH = "sismicidad_choco_consolidado.geojson"

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

# Variables de Entorno Seguras (sin secretos o URLs productivas codificadas)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
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
            global SISMOS_CACHE
            SISMOS_CACHE = None
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
    """Verifica autenticación en tiempo constante para endpoints administrativos."""
    expected_token = os.getenv("ADMIN_SECRET_TOKEN", "")
    if not expected_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Autenticación administrativa no configurada en el servidor."
        )
    if not secrets.compare_digest(x_admin_token or "", expected_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Acceso denegado: Token de autorización administrativa inválido o no suministrado."
        )

@app.post("/api/sismos/reload")
def reload_sismos(x_admin_token: str = Header(None)):
    """Recarga el catálogo sísmico en memoria desde Supabase o archivo consolidado."""
    verify_admin_token(x_admin_token)
    global SISMOS_CACHE
    SISMOS_CACHE = None
    load_data_from_supabase()
    count = len(SISMOS_CACHE.get("features", [])) if SISMOS_CACHE else 0
    return {"status": "ok", "message": "Catálogo sísmico recargado", "total_eventos": count}

@app.post("/api/sismos/sync")
def sync_sismos(x_admin_token: str = Header(None)):
    """Sincroniza el catálogo en vivo consultando USGS y EMSC y recarga la memoria."""
    verify_admin_token(x_admin_token)
    try:
        from sync_catalogo import sync_catalogo_live
        res = sync_catalogo_live()
        global SISMOS_CACHE
        SISMOS_CACHE = None
        load_data_from_supabase()
        return {"status": "ok", "resultado": res}
    except Exception as e:
        print(f"Error interno en sync_sismos: {e}")
        raise HTTPException(status_code=500, detail="Error interno al sincronizar el catálogo.")

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

def _build_live_feature(
    event_id: str,
    dt_utc: datetime,
    now_utc: datetime,
    lon: float,
    lat: float,
    depth: float,
    mag: float,
    municipio: str,
    fuente: str,
    rms: float,
    gap: float,
) -> dict:
    """Construye un GeoJSON Feature telemétrico normalizado en hora de Colombia (UTC-5)."""
    dt_col = dt_utc.astimezone(COLOMBIA_TZ)
    diff_hours = round(max(0.0, (now_utc - dt_utc).total_seconds() / 3600.0), 1)
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [lon, lat, -depth * 1000]
        },
        "properties": {
            "id": str(event_id),
            "fecha": dt_col.strftime("%Y-%m-%d %H:%M:%S"),
            "timestampMs": int(dt_utc.timestamp() * 1000),
            "diffHours": diff_hours,
            "esHoy": diff_hours <= 24.0,
            "anio": dt_col.year,
            "magnitud": round(float(mag), 1),
            "profundidad": round(float(depth), 1),
            "municipio": municipio,
            "fuente": fuente,
            "rms": float(rms),
            "gap": float(gap)
        }
    }


def fetch_real_sgc_telemetry(limit: int = 30, days_window: int = 14) -> list:
    """Consulta en vivo sin caché las APIs FDSN de EMSC y USGS en la ventana temporal reciente."""
    lat_min, lat_max = 3.0, 8.8
    lon_min, lon_max = -78.5, -74.5
    features = []
    now_utc = datetime.now(timezone.utc)
    start_iso = (now_utc - timedelta(days=days_window)).strftime("%Y-%m-%dT%H:%M:%S")

    mun_path = resolve_file_path(os.path.join("data", "municipios_choco_nsr10.json"))
    municipios = []
    if os.path.exists(mun_path):
        try:
            with open(mun_path, 'r', encoding='utf-8') as f:
                municipios = json.load(f)
        except Exception:
            municipios = []

    # 1. Consulta EMSC FDSN acotada a ventana temporal
    try:
        url_emsc = (
            "https://www.seismicportal.eu/fdsnws/event/1/query?format=json"
            f"&starttime={start_iso}&minlat={lat_min}&maxlat={lat_max}"
            f"&minlon={lon_min}&maxlon={lon_max}&limit={limit}"
        )
        resp = requests.get(url_emsc, timeout=6)
        if resp.status_code == 200:
            for item in resp.json().get("features", []):
                p = item.get("properties", {})
                c = item.get("geometry", {}).get("coordinates", [0, 0, 0])
                dt_utc = datetime.strptime(p.get("time", "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                lon, lat = float(c[0]), float(c[1])
                raw_depth = p.get("depth")
                depth = float(raw_depth if raw_depth is not None else 10.0)
                mun_name = find_nearest_municipio(lat, lon, municipios) if municipios else p.get("flynn_region", "Chocó")
                features.append(_build_live_feature(
                    event_id=p.get("unid", item.get("id")),
                    dt_utc=dt_utc,
                    now_utc=now_utc,
                    lon=lon,
                    lat=lat,
                    depth=depth,
                    mag=p.get("mag") or 0.0,
                    municipio=f"{mun_name} · EMSC FDSN",
                    fuente="EMSC FDSN Real-Time (European-Mediterranean Seismological Centre)",
                    rms=p.get("rms") or 0.0,
                    gap=p.get("gap") or 0.0,
                ))
    except Exception as e:
        print(f"Aviso telemetría EMSC: {e}")

    # 2. Consulta paralela USGS FDSN acotada a la misma ventana temporal
    try:
        url_usgs = (
            "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson"
            f"&starttime={start_iso}&minlatitude={lat_min}&maxlatitude={lat_max}"
            f"&minlongitude={lon_min}&maxlongitude={lon_max}&limit={limit}"
        )
        resp = requests.get(url_usgs, timeout=6)
        if resp.status_code == 200:
            for item in resp.json().get("features", []):
                p = item.get("properties", {})
                c = item.get("geometry", {}).get("coordinates", [0, 0, 0])
                dt_utc = datetime.fromtimestamp(p.get("time", 0) / 1000.0, tz=timezone.utc)
                lon, lat = float(c[0]), float(c[1])
                depth = float(c[2] if c[2] is not None else 10.0)
                mun_name = find_nearest_municipio(lat, lon, municipios) if municipios else p.get("place", "Chocó")
                features.append(_build_live_feature(
                    event_id=item.get("id"),
                    dt_utc=dt_utc,
                    now_utc=now_utc,
                    lon=lon,
                    lat=lat,
                    depth=depth,
                    mag=p.get("mag") or 0.0,
                    municipio=f"{mun_name} · USGS FDSN",
                    fuente="USGS FDSN Real-Time (U.S. Geological Survey)",
                    rms=p.get("rms") or 0.0,
                    gap=p.get("gap") or 0.0,
                ))
    except Exception as e:
        print(f"Aviso telemetría USGS: {e}")

    seen = set()
    dedup = []
    for f in features:
        p = f["properties"]
        c = f["geometry"]["coordinates"]
        k = (p["fecha"][:16], round(c[0], 2), round(c[1], 2))
        if k not in seen:
            seen.add(k)
            dedup.append(f)

    dedup.sort(key=lambda x: x["properties"]["fecha"], reverse=True)
    return dedup


@app.get("/api/live_sgc")
def get_live_sgc():
    """Retorna sismos reales recientes en ventana móvil de 14 días (sin caché previa)."""
    days_window = 14
    real_events = fetch_real_sgc_telemetry(limit=30, days_window=days_window)
    now_col = datetime.now(COLOMBIA_TZ)
    eventos_24h = sum(1 for f in real_events if f.get("properties", {}).get("esHoy"))
    ultimo_fecha = real_events[0]["properties"]["fecha"] if real_events else None
    return {
        "type": "FeatureCollection",
        "features": real_events,
        "ventana_dias": days_window,
        "eventos_24h": eventos_24h,
        "eventos_ventana": len(real_events),
        "ultimo_evento_fecha": ultimo_fecha,
        "consultado_utc5": now_col.strftime("%Y-%m-%d %H:%M:%S"),
        "fuente_nota": (
            "Consulta FDSN en vivo sin caché (EMSC/USGS, ventana móvil 14d, principalmente M≥3.5); "
            "el SGC no expone feed público FDSN de eventos (404)."
        ),
    }

@app.websocket("/ws/live_sgc")
async def websocket_live_sgc(websocket: WebSocket):
    """Túnel de WebSockets para transmitir sismos reales de feeds FDSN en Hora de Colombia (UTC-5)."""
    origin = websocket.headers.get("origin")
    if "*" not in allowed_origins and origin not in allowed_origins:
        await websocket.close(code=1008)
        return
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
    """Detecta clústeres espaciales densos mediante DBSCAN (Haversine 15 km, M>=4.0) con fallback estático."""
    global SISMOS_CACHE
    actual_geojson = resolve_file_path(GEOJSON_PATH)
    if not SISMOS_CACHE:
        if os.path.exists(actual_geojson):
            with open(actual_geojson, 'r', encoding='utf-8') as f:
                SISMOS_CACHE = json.load(f)
        else:
            fb_path = resolve_file_path(os.path.join("data", "ml_clusters_fallback.json"))
            if os.path.exists(fb_path):
                with open(fb_path, 'r', encoding='utf-8') as fb:
                    return json.load(fb)
            return {"features": []}
    
    try:
        from sklearn.cluster import DBSCAN
        import numpy as np
    except ImportError:
        fb_path = resolve_file_path(os.path.join("data", "ml_clusters_fallback.json"))
        if os.path.exists(fb_path):
            with open(fb_path, 'r', encoding='utf-8') as fb:
                return json.load(fb)
        return {"features": []}
        
    puntos_raw = []
    mags_raw = []
    municipios_raw = []
    prof_raw = []
    fechas_raw = []
    for f in SISMOS_CACHE.get("features", []):
        m = f["properties"].get("magnitud", 0)
        if m is not None and m >= 4.0:
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
            
    return {
        "type": "FeatureCollection",
        "algoritmo": "DBSCAN (Haversine eps=15 km, min_samples=8, M>=4.0)",
        "features": ml_features
    }

@app.get("/api/openquake_mock")
def get_openquake_mock():
    """Retorna la malla demostrativa simplificada de OpenQuake (fuente rectilínea + BooreAtkinson2008, no oficial)."""
    file_path = resolve_file_path(os.path.join('data', 'oq_resultados.geojson'))
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            data['modelo_nota'] = 'Escenario demostrativo simplificado (BooreAtkinson2008 sobre fuente rectilínea); no sustituye el Modelo Nacional de Amenaza Sísmica del SGC.'
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

