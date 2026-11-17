import math
import os
import sys
import pytest
from fastapi.testclient import TestClient

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

import main as backend  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(backend.app) as c:
        yield c


def test_app_metadata_and_health(client):
    assert backend.app.version == "2.0.0"
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["total_eventos"] >= 13756
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    assert res.headers.get("X-Frame-Options") == "SAMEORIGIN"


def test_sismos_catalog_clean_and_gzip(client):
    health = client.get("/api/health").json()
    res = client.get("/api/sismos", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers.get("Content-Encoding") == "gzip"
    data = res.json()
    feats = data.get("features", [])
    assert len(feats) >= 13756
    assert len(feats) == health["total_eventos"]
    sigs = set()
    for feat in feats:
        props = feat["properties"]
        coords = feat["geometry"]["coordinates"]
        mag = props.get("magnitud")
        depth = props.get("profundidad")
        assert isinstance(mag, (int, float)) and math.isfinite(mag)
        assert isinstance(depth, (int, float)) and math.isfinite(depth)
        sigs.add((props.get("fecha"), round(coords[0], 5), round(coords[1], 5), mag, depth))
    assert len(sigs) == len(feats)


def test_public_geodata_endpoints_and_static_assets(client):
    fallas = client.get("/api/fallas")
    assert fallas.status_code == 200
    assert len(fallas.json().get("features", [])) >= 10

    muns = client.get("/api/municipios_nsr10")
    assert muns.status_code == 200
    mun_list = muns.json()
    assert len(mun_list) == 67
    choco_muns = [m for m in mun_list if m.get("departamento") == "Chocó"]
    assert len(choco_muns) == 31
    assert all(isinstance(m.get("categoria_ley617"), str) and m["categoria_ley617"] for m in mun_list)
    assert all(isinstance(m.get("aislamiento_modal"), bool) for m in mun_list)

    infra = client.get("/api/infraestructura")
    assert infra.status_code == 200
    infra_feats = infra.json().get("features", [])
    assert len(infra_feats) == 37
    tipos = {f["properties"].get("tipo") for f in infra_feats}
    assert {"vial", "fluvial", "maritimo", "puerto", "hospital", "aeropuerto"}.issubset(tipos)

    clusters = client.get("/api/ml_clusters")
    assert clusters.status_code == 200
    c_feats = clusters.json().get("features", [])
    assert len(c_feats) >= 175
    assert all(f["properties"]["cluster_id"] != -1 and f["properties"]["magnitud"] >= 4.0 for f in c_feats)
    fallback_clusters = client.get("/data/ml_clusters_fallback.json")
    assert fallback_clusters.status_code == 200
    assert len(fallback_clusters.json().get("features", [])) == 175

    oq = client.get("/api/openquake_mock")
    assert oq.status_code == 200
    oq_body = oq.json()
    assert "modelo_nota" in oq_body
    assert oq_body["features"][0]["properties"]["retorno"] == 475

    for static_path in [
        "/data/choco_base_offline.geojson",
        "/data/ml_clusters_fallback.json",
        "/sw.js",
        "/manifest.json",
    ]:
        r = client.get(static_path)
        assert r.status_code == 200, f"Missing static asset {static_path}"


from datetime import datetime, timezone
from unittest.mock import patch


def test_live_sgc_window_and_metadata(client):
    now_utc = datetime.now(timezone.utc)
    sample_feat = backend._build_live_feature(
        event_id="evt-test-1",
        dt_utc=now_utc,
        now_utc=now_utc,
        lon=-76.66,
        lat=5.69,
        depth=18.5,
        mag=4.2,
        municipio="Quibdó (Chocó) · EMSC FDSN",
        fuente="EMSC FDSN Real-Time",
        rms=0.3,
        gap=90.0,
    )
    assert sample_feat["properties"]["esHoy"] is True
    assert sample_feat["properties"]["diffHours"] == 0.0

    with patch.object(backend, "fetch_real_sgc_telemetry", return_value=[sample_feat]):
        res = client.get("/api/live_sgc")
        assert res.status_code == 200
        body = res.json()
        assert body["ventana_dias"] == 14
        assert body["eventos_24h"] == 1
        assert body["eventos_ventana"] == 1
        assert body["ultimo_evento_fecha"] == sample_feat["properties"]["fecha"]
        assert "consultado_utc5" in body and "fuente_nota" in body


def test_admin_endpoints_fail_closed_without_secret_or_on_get(client):
    assert client.get("/api/sismos/reload").status_code in (404, 405)
    assert client.get("/api/sismos/sync").status_code in (404, 405)
    old_secret = os.environ.pop("ADMIN_SECRET_TOKEN", None)
    try:
        assert client.post("/api/sismos/reload").status_code == 503
        os.environ["ADMIN_SECRET_TOKEN"] = "ci-secret-token"
        assert client.post("/api/sismos/reload", headers={"x-admin-token": "wrong"}).status_code == 401
        res_ok = client.post("/api/sismos/reload", headers={"x-admin-token": "ci-secret-token"})
        assert res_ok.status_code == 200
    finally:
        if old_secret is None:
            os.environ.pop("ADMIN_SECRET_TOKEN", None)
        else:
            os.environ["ADMIN_SECRET_TOKEN"] = old_secret
