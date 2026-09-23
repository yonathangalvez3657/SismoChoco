# Sincronizador Automático de Catálogo Sísmico
# Fuentes: USGS Earthquake Hazards Program + EMSC European-Mediterranean Seismological Centre
import os
import json
import math
import requests
from datetime import datetime, timedelta

MUNICIPIOS_PATH = os.path.join(os.path.dirname(__file__), 'app', 'data', 'municipios_choco_nsr10.json')
GEOJSON_CONSOLIDADO = os.path.join(os.path.dirname(__file__), 'sismicidad_choco_consolidado.geojson')

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def find_nearest_municipio(lat, lon, municipios):
    best_m = None
    min_d = float('inf')
    for m in municipios:
        m_lng = m.get('lng', m.get('lon'))
        d = haversine(lat, lon, m['lat'], m_lng)
        if d < min_d:
            min_d = d
            best_m = m
    if best_m:
        return f"{best_m['nombre']} ({best_m['departamento']})"
    return 'Desconocido'

def sync_catalogo_live(start_date_str=None):
    """Consulta USGS y EMSC para descargar sismos recientes y consolidarlos."""
    if not os.path.exists(GEOJSON_CONSOLIDADO):
        return {'error': 'No existe el archivo sismicidad_choco_consolidado.geojson'}

    with open(GEOJSON_CONSOLIDADO, 'r', encoding='utf-8') as f:
        geojson_data = json.load(f)

    existing_features = geojson_data.get('features', [])
    
    if not start_date_str:
        # Detectar la fecha más reciente
        fechas = [f['properties']['fecha'] for f in existing_features if 'fecha' in f.get('properties', {})]
        if fechas:
            latest = max(fechas)[:10] # YYYY-MM-DD
            start_date_str = latest
        else:
            start_date_str = '2026-03-18'

    end_date_str = datetime.utcnow().strftime('%Y-%m-%dT23:59:59')
    
    # Bounding Box ampliado
    lat_min, lat_max = 3.0, 8.8
    lon_min, lon_max = -78.5, -74.5

    municipios = []
    if os.path.exists(MUNICIPIOS_PATH):
        with open(MUNICIPIOS_PATH, 'r', encoding='utf-8') as f:
            municipios = json.load(f)

    new_events = []
    
    # 1. Query USGS
    try:
        usgs_url = f'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime={start_date_str}&endtime={end_date_str}&minlatitude={lat_min}&maxlatitude={lat_max}&minlongitude={lon_min}&maxlongitude={lon_max}&minmagnitude=0'
        r = requests.get(usgs_url, timeout=15)
        if r.status_code == 200:
            usgs_data = r.json().get('features', [])
            for f in usgs_data:
                c = f['geometry']['coordinates']
                lon, lat, depth = c[0], c[1], c[2]
                props = f['properties']
                dt = datetime.utcfromtimestamp(props['time'] / 1000.0)
                new_events.append({
                    'source': 'USGS',
                    'id': f['id'],
                    'time_dt': dt,
                    'fecha': dt.strftime('%Y-%m-%d %H:%M:%S'),
                    'lat': round(lat, 4),
                    'lon': round(lon, 4),
                    'depth': round(depth, 2),
                    'mag': round(float(props['mag']), 1),
                    'rms': round(float(props.get('rms') or 0.0), 2),
                    'gap': round(float(props.get('gap') or 0.0), 1),
                    'municipio': find_nearest_municipio(lat, lon, municipios)
                })
    except Exception as e:
        print(f'Advertencia USGS: {e}')

    # 2. Query EMSC
    try:
        emsc_url = f'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&starttime={start_date_str}&endtime={end_date_str}&minlat={lat_min}&maxlat={lat_max}&minlon={lon_min}&maxlon={lon_max}'
        r = requests.get(emsc_url, timeout=15)
        if r.status_code == 200:
            emsc_data = r.json().get('features', [])
            for f in emsc_data:
                props = f['properties']
                lat, lon, depth = props['lat'], props['lon'], props['depth']
                time_str = props['time'][:19]
                dt = datetime.strptime(time_str, '%Y-%m-%dT%H:%M:%S')
                new_events.append({
                    'source': 'EMSC',
                    'id': props.get('unid', f.get('id', '')),
                    'time_dt': dt,
                    'fecha': dt.strftime('%Y-%m-%d %H:%M:%S'),
                    'lat': round(lat, 4),
                    'lon': round(lon, 4),
                    'depth': round(depth, 2),
                    'mag': round(float(props['mag']), 1),
                    'rms': 0.0,
                    'gap': 0.0,
                    'municipio': find_nearest_municipio(lat, lon, municipios)
                })
    except Exception as e:
        print(f'Advertencia EMSC: {e}')

    # Deduplicar
    existing_keys = set()
    for feat in existing_features:
        p = feat.get('properties', {})
        fecha = str(p.get('fecha', ''))[:16]
        c = feat.get('geometry', {}).get('coordinates', [0, 0])
        existing_keys.add((fecha, round(c[0], 2), round(c[1], 2)))

    added_features = []
    seen_in_batch = set()

    for ev in new_events:
        key = (ev['fecha'][:16], round(ev['lon'], 2), round(ev['lat'], 2))
        if key in existing_keys or key in seen_in_batch:
            continue
        seen_in_batch.add(key)
        
        feat = {
            'type': 'Feature',
            'geometry': {
                'type': 'Point',
                'coordinates': [ev['lon'], ev['lat'], -float(ev['depth']) * 1000]
            },
            'properties': {
                'fecha': ev['fecha'],
                'anio': ev['time_dt'].year,
                'magnitud': float(ev['mag']),
                'profundidad': float(ev['depth']),
                'rms': float(ev['rms']),
                'gap': float(ev['gap']),
                'error_lat': 0.0,
                'error_lon': 0.0,
                'error_prof': 0.0,
                'municipio': ev['municipio'],
                'fuente': ev['source']
            }
        }
        added_features.append(feat)

    if added_features:
        total = existing_features + added_features
        with open(GEOJSON_CONSOLIDADO, 'w', encoding='utf-8') as f:
            json.dump({'type': 'FeatureCollection', 'features': total}, f, ensure_ascii=False)

    return {
        'nuevos_agregados': len(added_features),
        'total_consolidado': len(existing_features) + len(added_features),
        'desde': start_date_str,
        'hasta': end_date_str
    }
