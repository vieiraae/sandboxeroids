"""FastAPI server for Sandboxeroids.

Serves the static game UI and exposes a small API + WebSocket bridging the
Azure Container Apps Sandbox SDK.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# Silence verbose Azure SDK HTTP/auth logs — they flood the terminal and obscure lifecycle events.
for _noisy in (
    "azure.core.pipeline.policies.http_logging_policy",
    "azure.identity",
    "azure.identity._internal.decorators",
    "azure.identity._credentials.chained",
    "azure.identity._credentials.environment",
    "azure.identity._credentials.managed_identity",
    "azure.identity._credentials.azure_cli",
):
    logging.getLogger(_noisy).setLevel(logging.WARNING)
log = logging.getLogger("sandboxeroids")

from sandbox_manager import SandboxManager, ICON_FAMILIES, TIERS, POPULAR_COMMANDS  # noqa: E402

app = FastAPI(title="Sandboxeroids")
mgr = SandboxManager()
loop_ref: Optional[asyncio.AbstractEventLoop] = None
clients: set[WebSocket] = set()
warm_pool_enabled = True


# ---------- models ----------
class ExecReq(BaseModel):
    cmd: str


class WriteReq(BaseModel):
    path: str
    content: str


# ---------- helpers ----------
async def run_sync(fn, *args, **kwargs):
    return await asyncio.get_running_loop().run_in_executor(None, lambda: fn(*args, **kwargs))


async def broadcast(msg: dict):
    dead = []
    data = json.dumps(msg)
    for ws in list(clients):
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for d in dead:
        clients.discard(d)


# ---------- API ----------
@app.get("/api/config")
async def get_config():
    return {
        "subscription_id": mgr.subscription_id,
        "resource_group": mgr.resource_group,
        "sandbox_group": mgr.sandbox_group,
        "region": mgr.region,
        "disk_images": mgr._disk_images,
        "icon_families": ICON_FAMILIES,
        "tiers": list(TIERS.keys()),
        "popular_commands": POPULAR_COMMANDS,
        "warm_pool_enabled": warm_pool_enabled,
        "warm_pool_size": int(os.getenv("WARM_POOL_SIZE", "3")),
        "auto_suspend_seconds": mgr.auto_suspend_seconds,
        "auto_delete_seconds": mgr.auto_delete_seconds,
        "starting_lives": int(os.getenv("STARTING_LIVES", "6")),
    }


@app.post("/api/warm_pool/toggle")
async def toggle_warm_pool():
    global warm_pool_enabled
    warm_pool_enabled = not warm_pool_enabled
    mgr._log("system", f"warm pool {'enabled' if warm_pool_enabled else 'paused'}")
    return {"enabled": warm_pool_enabled}


@app.post("/api/sync")
async def sync_existing():
    await run_sync(mgr.sync_existing)
    await broadcast({
        "type": "stats",
        "sandboxes": [r.to_dict() for r in mgr.list()],
        "avg_latency_ms": mgr.avg_latency_ms(),
    })
    return {"count": len(mgr.list())}


@app.get("/api/sandboxes")
async def list_sandboxes():
    return {
        "sandboxes": [r.to_dict() for r in mgr.list()],
        "avg_latency_ms": mgr.avg_latency_ms(),
    }


@app.post("/api/sandboxes")
async def create_sandbox(disk: Optional[str] = None, tier: Optional[str] = None):
    rec = await run_sync(mgr.create, disk, tier)
    await broadcast({"type": "sandbox_created", "sandbox": rec.to_dict(), "avg_latency_ms": mgr.avg_latency_ms()})
    return rec.to_dict()


@app.post("/api/sandboxes/{sid}/stop")
async def stop_sandbox(sid: str):
    await run_sync(mgr.stop, sid)
    rec = mgr.get(sid)
    if rec:
        await broadcast({"type": "sandbox_updated", "sandbox": rec.to_dict()})
    return {"ok": True}


@app.post("/api/sandboxes/{sid}/resume")
async def resume_sandbox(sid: str):
    await run_sync(mgr.resume, sid)
    rec = mgr.get(sid)
    if rec:
        await broadcast({"type": "sandbox_updated", "sandbox": rec.to_dict()})
    return {"ok": True}


@app.delete("/api/sandboxes/{sid}")
async def delete_sandbox(sid: str):
    await run_sync(mgr.delete, sid)
    await broadcast({"type": "sandbox_deleted", "id": sid})
    return {"ok": True}


@app.post("/api/sandboxes/{sid}/exec")
async def exec_sandbox(sid: str, req: ExecReq):
    res = await run_sync(mgr.exec, sid, req.cmd)
    return res


@app.get("/api/sandboxes/{sid}/files")
async def list_files(sid: str, path: str = "/"):
    return {"files": await run_sync(mgr.list_files, sid, path)}


@app.get("/api/sandboxes/{sid}/files/read")
async def read_file_api(sid: str, path: str):
    return {"content": await run_sync(mgr.read_file, sid, path), "path": path}


@app.post("/api/sandboxes/{sid}/files/write")
async def write_file_api(sid: str, req: WriteReq):
    ok = await run_sync(mgr.write_file, sid, req.path, req.content)
    return {"ok": ok}


@app.get("/api/logs")
async def get_logs(since: float = 0.0):
    return {"logs": mgr.logs(since)}


@app.get("/api/sandbox_url/{sid}")
async def sandbox_url(sid: str):
    rec = mgr.get(sid)
    if not rec:
        raise HTTPException(404)
    real = rec.real_id or sid
    url = (f"https://sandboxes.azure.com/sandbox-groups/"
           f"{mgr.subscription_id}/{mgr.resource_group}/{mgr.sandbox_group}/sandboxes/{real}")
    return {"url": url}


# ---------- websocket ----------
@app.websocket("/ws")
async def ws(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        # initial snapshot
        await ws.send_text(json.dumps({
            "type": "snapshot",
            "sandboxes": [r.to_dict() for r in mgr.list()],
            "avg_latency_ms": mgr.avg_latency_ms(),
        }))
        while True:
            await ws.receive_text()  # keep-alive / ignore
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


# ---------- background loops ----------
async def stats_loop():
    last_log_ts = 0.0
    while True:
        try:
            await run_sync(mgr.refresh_stats)
            await broadcast({
                "type": "stats",
                "sandboxes": [r.to_dict() for r in mgr.list()],
                "avg_latency_ms": mgr.avg_latency_ms(),
            })
            new_logs = mgr.logs(last_log_ts)
            if new_logs:
                last_log_ts = new_logs[-1]["ts"]
                await broadcast({"type": "logs", "logs": new_logs})
        except Exception as e:
            log.exception("stats_loop: %s", e)
        await asyncio.sleep(1.5)


async def warm_pool_loop():
    """Keep at least WARM_POOL_SIZE Running sandboxes available."""
    target = int(os.getenv("WARM_POOL_SIZE", "3"))
    while True:
        try:
            if warm_pool_enabled:
                # Count both Running and idle/stopped sandboxes — they all count
                # toward the warm pool since they can resume in sub-seconds.
                alive = [r for r in mgr.list() if r.state in ("Running", "Idle", "Suspended", "Stopped", "Resuming", "Creating")]
                if len(alive) < target:
                    rec = await run_sync(mgr.create)
                    await broadcast({"type": "sandbox_created", "sandbox": rec.to_dict(),
                                     "avg_latency_ms": mgr.avg_latency_ms()})
        except Exception as e:
            log.exception("warm_pool: %s", e)
        await asyncio.sleep(2.0)


async def gc_loop():
    """Permanently drop records that finished Deleting after a grace period."""
    while True:
        cutoff = time.time() - 4.0
        for sid, rec in list(mgr._records.items()):
            if rec.state == "Deleted" and rec.created_at < cutoff:
                mgr._records.pop(sid, None)
        await asyncio.sleep(2.0)


@app.on_event("startup")
async def _startup():
    global loop_ref
    loop_ref = asyncio.get_running_loop()
    # Eagerly verify Azure connectivity so config issues surface at startup.
    try:
        await run_sync(mgr.ensure_ready)
        await run_sync(mgr.sync_existing)
    except Exception as e:
        log.error("Azure setup failed: %s", e)
        raise
    asyncio.create_task(stats_loop())
    asyncio.create_task(warm_pool_loop())
    asyncio.create_task(gc_loop())
    log.info("Sandboxeroids ready.")


# ---------- static frontend ----------
FRONTEND = ROOT / "frontend"
ICONS = ROOT / "public"

app.mount("/public", StaticFiles(directory=str(ICONS)), name="public")
app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")
