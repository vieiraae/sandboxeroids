"""Sandbox manager — thin wrapper around the Azure Container Apps Sandbox SDK.

Uses DefaultAzureCredential, which picks up the local Azure CLI login (`az login`).
No simulation / fallback — real sandboxes only.

Requires the caller to have the 'Container Apps SandboxGroup Data Owner' role on
the configured resource group. Assign once:

    az role assignment create \
      --assignee $(az ad signed-in-user show --query id -o tsv) \
      --role "Container Apps SandboxGroup Data Owner" \
      --scope /subscriptions/<sub>/resourceGroups/<rg>
"""
from __future__ import annotations

import logging
import os
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger("sandbox_manager")

# Icon families we have SVGs for in public/icons/. Real disk image names from the
# service are mapped to one of these at startup via _classify_disk().
ICON_FAMILIES = ["ubuntu", "python", "nodejs", "dotnet", "githubcopilot", "typescript"]
TIERS = {
    "XS": {"cpu": "250m",  "memory": "512Mi"},
    "S":  {"cpu": "500m",  "memory": "1024Mi"},
    "M":  {"cpu": "1000m", "memory": "2048Mi"},
    "L":  {"cpu": "2000m", "memory": "4096Mi"},
}

POPULAR_COMMANDS = [
    "uname -a",
    "uptime",
    "whoami",
    "ls -la /",
    "df -h",
    "free -m",
    "cat /etc/os-release",
    "ps aux | head -20",
    "echo 'Hello from sandbox!' > /tmp/hello.txt && cat /tmp/hello.txt",
    "for i in 1 2 3; do echo \"ping $i\"; done",
    "python3 -c 'import sys; print(sys.version)'",
    "node -v 2>/dev/null || echo node not installed",
    "dotnet --version 2>/dev/null || echo dotnet not installed",
]

# Cute, geeky callsigns. Picked at random and combined with the disk image for the
# sandbox's friendly name (e.g. "nova-py", "rogue-ubu", "vector-net").
_CALLSIGNS = [
    "nova", "rogue", "vector", "comet", "pulsar", "quark", "orbit", "lumen",
    "neutron", "photon", "warp", "atlas", "echo", "cipher", "drift", "halo",
    "saber", "vortex", "zenith", "raven", "specter", "tachyon", "ion", "flux",
]
_DISK_SHORT = {
    "ubuntu": "ubu", "python": "py", "nodejs": "node",
    "dotnet": "net", "githubcopilot": "gh", "typescript": "ts",
}

def _classify_disk(real_name: str) -> Optional[str]:
    """Map a real disk-image name to one of our icon families, or None if no match."""
    n = real_name.lower()
    if "ubuntu" in n or "debian" in n: return "ubuntu"
    if "python" in n: return "python"
    if "node" in n or "javascript" in n: return "nodejs"
    if "dotnet" in n or "csharp" in n or ".net" in n or "aspnet" in n: return "dotnet"
    if "copilot" in n or "github" in n: return "githubcopilot"
    if "typescript" in n or "deno" in n: return "typescript"
    return None

def _short_name(family: str, tier: str) -> str:
    return f"{random.choice(_CALLSIGNS)}-{_DISK_SHORT.get(family, family[:3])}-{tier.lower()}"


@dataclass
class SandboxRecord:
    id: str
    real_id: str
    name: str
    state: str  # Creating | Running | Stopping | Stopped | Resuming | Deleting | Deleted
    disk: str       # real disk image name (e.g. 'ubuntu-22.04')
    family: str     # icon family (one of ICON_FAMILIES)
    tier: str
    created_at: float
    last_active_at: float = 0.0  # last time it entered Running; used to compute auto-suspend countdown
    create_latency_ms: float = 0.0
    cpu_pct: float = 0.0
    mem_pct: float = 0.0
    disk_pct: float = 0.0
    labels: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "real_id": self.real_id,
            "name": self.name,
            "state": self.state,
            "disk": self.disk,
            "family": self.family,
            "tier": self.tier,
            "cpu": self.cpu_pct,
            "memory": self.mem_pct,
            "disk_usage": self.disk_pct,
            "created_at": self.created_at,
            "last_active_at": self.last_active_at,
            "create_latency_ms": self.create_latency_ms,
            "labels": self.labels,
        }


class SandboxManager:
    """Sync wrapper. Methods are blocking — call from threadpool via run_in_executor."""

    def __init__(self):
        self.subscription_id = os.getenv("ACA_SUBSCRIPTION_ID", "").strip()
        self.resource_group  = os.getenv("ACA_RESOURCE_GROUP", "sandboxeroids-rg").strip()
        self.sandbox_group   = os.getenv("ACA_SANDBOX_GROUP", "sandboxeroids").strip()
        self.region          = os.getenv("ACA_REGION", "eastus2").strip()

        # Lifecycle policy values (seconds). 0 disables that policy.
        self.auto_suspend_seconds = int(os.getenv("ACA_AUTO_SUSPEND_SECONDS", "20"))
        self.auto_suspend_mode    = os.getenv("ACA_AUTO_SUSPEND_MODE", "Memory").strip()
        self.auto_delete_seconds  = int(os.getenv("ACA_AUTO_DELETE_SECONDS", "600"))

        # Optional allowlist of public disk image names to use (comma-separated).
        # If empty, use everything the service exposes that has a matching icon.
        self._disk_allowlist = {
            n.strip() for n in os.getenv("ACA_DISK_IMAGES", "").split(",") if n.strip()
        }

        if not self.subscription_id:
            raise RuntimeError(
                "ACA_SUBSCRIPTION_ID is required. Set it in .env "
                "(get with: az account show --query id -o tsv)."
            )

        self._records: dict[str, SandboxRecord] = {}
        self._handles: dict[str, Any] = {}
        self._latencies: list[float] = []
        self._logs: list[dict] = []
        self._client = None
        self._mgmt = None
        self._cred = None
        self._disk_images: list[str] = []  # real names from list_public_disk_images()

        self._log("system", f"sub={self.subscription_id[:8]}… rg={self.resource_group} group={self.sandbox_group} region={self.region}")

    def _log(self, source: str, message: str):
        entry = {"ts": time.time(), "source": source, "message": message}
        self._logs.append(entry)
        if len(self._logs) > 500:
            self._logs = self._logs[-500:]
        log.info("[%s] %s", source, message)

    def logs(self, since: float = 0.0) -> list[dict]:
        return [e for e in self._logs if e["ts"] > since]

    def avg_latency_ms(self) -> float:
        return sum(self._latencies) / len(self._latencies) if self._latencies else 0.0

    def ensure_ready(self):
        """Idempotent: ensure RG + sandbox group exist, init data-plane client."""
        if self._client is not None:
            return
        from azure.identity import DefaultAzureCredential
        from azure.mgmt.resource import ResourceManagementClient
        from azure.containerapps.sandbox import (
            SandboxGroupClient,
            SandboxGroupManagementClient,
            endpoint_for_region,
        )

        self._cred = DefaultAzureCredential()

        rc = ResourceManagementClient(self._cred, self.subscription_id)
        rc.resource_groups.create_or_update(self.resource_group, {"location": self.region})
        self._log("system", f"resource group {self.resource_group} ready")

        self._mgmt = SandboxGroupManagementClient(
            self._cred,
            subscription_id=self.subscription_id,
            resource_group=self.resource_group,
        )
        try:
            self._mgmt.get_group(self.sandbox_group)
            self._log("system", f"sandbox group {self.sandbox_group} exists")
        except Exception:
            self._mgmt.create_group(self.sandbox_group, location=self.region)
            self._log("system", f"created sandbox group {self.sandbox_group}")

        self._client = SandboxGroupClient(
            endpoint_for_region(self.region),
            self._cred,
            subscription_id=self.subscription_id,
            resource_group=self.resource_group,
            sandbox_group=self.sandbox_group,
        )
        self._log("system", "data-plane client ready")

        # Discover real public disk image names so we don't 400 on create.
        # Filter to only those that map to an icon family we have an SVG for.
        try:
            all_names = []
            for img in self._client.list_public_disk_images():
                n = getattr(img, "name", None) or getattr(img, "id", None)
                if n:
                    all_names.append(str(n))
            kept, skipped_no_icon = [], []
            for n in all_names:
                if self._disk_allowlist and n not in self._disk_allowlist:
                    continue  # intentional allowlist filter — not noteworthy
                if _classify_disk(n) is not None:
                    kept.append(n)
                else:
                    skipped_no_icon.append(n)
            self._disk_images = kept
            if self._disk_allowlist:
                missing = self._disk_allowlist - set(all_names)
                if missing:
                    self._log("error", f"ACA_DISK_IMAGES not found in group: {', '.join(sorted(missing))}")
            if kept:
                self._log("system", f"using disk images ({len(kept)}): {', '.join(kept)}")
            else:
                self._log("error", "no public disk images matched our icon families")
            if skipped_no_icon:
                self._log("system", f"skipped (no icon): {', '.join(skipped_no_icon)}")
        except Exception as e:
            self._log("error", f"list_public_disk_images: {e}")

    def create(self, disk: Optional[str] = None, tier: Optional[str] = None) -> SandboxRecord:
        self.ensure_ready()
        if not self._disk_images:
            raise RuntimeError("No public disk images available in this sandbox group / region.")
        disk = disk or random.choice(self._disk_images)
        tier = tier or random.choice(list(TIERS.keys()))
        family = _classify_disk(disk) or "ubuntu"
        opts = TIERS[tier]
        local_id = f"sbx-{uuid.uuid4().hex[:8]}"
        name = _short_name(family, tier)
        rec = SandboxRecord(
            id=local_id, real_id="", name=name, state="Creating",
            disk=disk, family=family, tier=tier, created_at=time.time(),
            labels={
                "game": "sandboxeroids",
                "tier": tier,
                "disk": disk,
                "family": family,
                "name": name,
            },
        )
        self._records[local_id] = rec
        self._log("create", f"spawning {name} ({tier} {disk}) → {local_id}")
        t0 = time.time()
        try:
            sb = self._client.begin_create_sandbox(
                disk=disk, cpu=opts["cpu"], memory=opts["memory"], labels=rec.labels,
            ).result()
        except Exception as e:
            self._log("error", f"create {local_id}: {e}")
            rec.state = "Deleted"
            raise

        rec.real_id = getattr(sb, "id", "") or getattr(sb, "name", "") or ""
        rec.state = "Running"
        rec.last_active_at = time.time()
        self._handles[local_id] = sb
        dt = (time.time() - t0) * 1000
        rec.create_latency_ms = dt
        self._latencies.append(dt)
        if len(self._latencies) > 50:
            self._latencies = self._latencies[-50:]
        self._log("create", f"{name} ({local_id}) Running in {dt:.0f}ms (id={rec.real_id[:12] or 'n/a'})")

        # Apply configured lifecycle policies (values from env).
        susp_s = self.auto_suspend_seconds
        del_s  = self.auto_delete_seconds
        try:
            from azure.containerapps.sandbox import (
                LifecyclePolicy, AutoSuspendPolicy, AutoDeletePolicy,
            )
            policy = LifecyclePolicy(
                auto_suspend=AutoSuspendPolicy(
                    enabled=susp_s > 0,
                    interval=max(susp_s, 1),
                    mode=self.auto_suspend_mode,
                ),
                auto_delete=AutoDeletePolicy(
                    enabled=del_s > 0,
                    delete_interval_seconds=max(del_s, 1),
                ),
            )
            applied = sb.set_lifecycle_policy(policy)
            asp = getattr(applied, "auto_suspend", None)
            adp = getattr(applied, "auto_delete", None)
            self._log(
                "lifecycle",
                f"{local_id} policies set · "
                f"suspend(enabled={getattr(asp,'enabled',None)}, interval={getattr(asp,'interval',None)}, mode={getattr(asp,'mode',None)}) · "
                f"delete(enabled={getattr(adp,'enabled',None)}, interval={getattr(adp,'delete_interval_seconds',None)})",
            )
        except Exception as e:
            self._log("error", f"lifecycle policy {local_id}: {type(e).__name__}: {e}")
        return rec

    def _svc_state(self, h) -> Optional[str]:
        """Best-effort live state from the service.

        Returns None on transient failure, or the literal "NotFound" if the
        service reports the sandbox is gone (404). Callers should treat
        "NotFound" as terminal and reconcile to Deleted.
        """
        try:
            info = h.get()
            return getattr(info, "state", None)
        except Exception as e:
            msg = str(e)
            if "404" in msg or "NotFound" in msg or "SandboxNotFound" in msg:
                return "NotFound"
            return None

    def _mark_gone(self, sid: str, rec: "SandboxRecord", reason: str = "gone") -> None:
        rec.state = "Deleted"
        self._handles.pop(sid, None)
        self._log("lifecycle", f"{sid} {reason} (reconciled to Deleted)")

    def stop(self, sid: str):
        rec = self._records.get(sid)
        h = self._handles.get(sid)
        if not rec or not h or rec.state in ("Deleting", "Deleted"):
            return
        # Check the live service state first — local 'Running' can be stale
        # (e.g. the service auto-suspended after the policy interval).
        live = self._svc_state(h)
        if live == "NotFound":
            self._mark_gone(sid, rec, reason="not found on stop")
            return
        if live and live != "Running":
            # Already not Running — reconcile our local state and skip the call.
            if live in ("Suspended", "Idle", "Stopped"):
                rec.state = "Stopped"
                self._log("lifecycle", f"{sid} already {live} (no stop needed)")
            else:
                rec.state = live
                self._log("lifecycle", f"{sid} in {live}, stop skipped")
            return
        prev_state = rec.state
        rec.state = "Stopping"
        self._log("lifecycle", f"{sid} → Stopping")
        try:
            h.stop()
            # Don't flip to Stopped here — wait for refresh_stats to observe
            # the service-side state. The polling loop is whitelisted to leave
            # 'Stopping' alone until the service reports Suspended/Idle/Stopped.
        except Exception as e:
            msg = str(e)
            if "404" in msg or "NotFound" in msg or "SandboxNotFound" in msg:
                self._mark_gone(sid, rec, reason="vanished during stop")
            elif "SandboxNotRunning" in msg or "is not in Running state" in msg or "409" in msg:
                # Race: service moved out of Running between our check and the call.
                rec.state = "Stopped"
                self._log("lifecycle", f"{sid} race: already not Running, reconciled to Stopped")
            else:
                self._log("error", f"stop {sid}: {e}")
                rec.state = prev_state  # rollback on failure

    def resume(self, sid: str):
        rec = self._records.get(sid)
        h = self._handles.get(sid)
        if not rec or not h or rec.state in ("Deleting", "Deleted", "Running"):
            return
        live = self._svc_state(h)
        if live == "NotFound":
            self._mark_gone(sid, rec, reason="not found on resume")
            return
        if live == "Running":
            rec.state = "Running"
            rec.last_active_at = time.time()
            self._log("lifecycle", f"{sid} already Running (no resume needed)")
            return
        if live and live not in ("Stopped", "Suspended", "Idle"):
            rec.state = live
            self._log("lifecycle", f"{sid} in {live}, resume skipped")
            return
        prev_state = rec.state
        rec.state = "Resuming"
        self._log("lifecycle", f"{sid} → Resuming")
        try:
            h.resume()
            # Wait for service-side confirmation via refresh_stats.
        except Exception as e:
            msg = str(e)
            if "404" in msg or "NotFound" in msg or "SandboxNotFound" in msg:
                self._mark_gone(sid, rec, reason="vanished during resume")
                return
            if "409" in msg or "Conflict" in msg:
                # Race: service may already be Running or transitioning.
                live2 = self._svc_state(h)
                if live2 == "Running":
                    rec.state = "Running"
                    rec.last_active_at = time.time()
                    self._log("lifecycle", f"{sid} race: already Running, reconciled")
                    return
            self._log("error", f"resume {sid}: {e}")
            rec.state = prev_state  # rollback

    def delete(self, sid: str):
        rec = self._records.get(sid)
        if not rec or rec.state == "Deleted":
            return
        # Already in-flight — don't spawn another delete.
        if rec.state == "Deleting":
            return
        h = self._handles.get(sid)
        # Mark Deleted immediately so the card disappears from the UI right away.
        # The list() filter drops Deleted records, and refresh_stats already
        # handles a 404 (out-of-band gone) gracefully. We fire the SDK delete
        # in a background thread; we don't need to wait for it.
        rec.state = "Deleted"
        self._handles.pop(sid, None)
        self._log("lifecycle", f"{sid} → Deleting 💥")
        if not h:
            return
        import threading
        def _bg():
            try:
                h.delete()
            except Exception as e:
                msg = str(e)
                # 404 / NotFound: already gone. Anything else: log but don't resurrect.
                if "404" not in msg and "NotFound" not in msg and "ResourceNotFound" not in msg:
                    self._log("error", f"delete {sid}: {e}")
        threading.Thread(target=_bg, daemon=True, name=f"delete-{sid}").start()

    def list(self) -> list[SandboxRecord]:
        return [r for r in self._records.values() if r.state != "Deleted"]

    def get(self, sid: str) -> Optional[SandboxRecord]:
        return self._records.get(sid)

    def refresh_stats(self):
        for rec in list(self._records.values()):
            h = self._handles.get(rec.id)
            if not h or rec.state in ("Deleting", "Deleted"):
                continue
            # Sync state from service — picks up auto-suspend / auto-delete / external delete.
            try:
                info = h.get()
                svc_state = getattr(info, "state", None)
                if svc_state and svc_state != rec.state:
                    # When user asked to stop, trust the local 'Stopping' state
                    # until the service confirms a non-Running state.
                    if rec.state == "Stopping":
                        if svc_state in ("Suspended", "Idle", "Stopped"):
                            rec.state = "Stopped"
                            self._log("lifecycle", f"{rec.id} → Stopped")
                    elif rec.state == "Resuming":
                        if svc_state == "Running":
                            rec.state = "Running"
                            rec.last_active_at = time.time()
                            self._log("lifecycle", f"{rec.id} → Running")
                    elif svc_state in ("Suspended", "Idle") and rec.state == "Running":
                        rec.state = "Stopped"
                        self._log("lifecycle", f"{rec.id} auto-suspended by service")
                    elif svc_state == "Running" and rec.state == "Stopped":
                        rec.state = "Running"
                        rec.last_active_at = time.time()
                        self._log("lifecycle", f"{rec.id} resumed by service")
                    elif svc_state in ("Deleting", "Deleted"):
                        rec.state = svc_state
                        self._log("lifecycle", f"{rec.id} deleted (external)")
                        self._handles.pop(rec.id, None)
                        continue
            except Exception as e:
                # 404 / NotFound means it was deleted out-of-band (portal, CLI, auto-delete).
                msg = str(e).lower()
                if "notfound" in msg or "not found" in msg or "404" in msg or "resourcenotfound" in msg:
                    rec.state = "Deleted"
                    self._log("lifecycle", f"{rec.id} gone (deleted externally)")
                    self._handles.pop(rec.id, None)
                    continue
                # otherwise just skip this round
            if rec.state != "Running":
                continue
            try:
                s = h.get_stats()
                # CPU: nano-cores against the sandbox's allocated cores → percentage.
                cpu = getattr(s, "cpu", None)
                nano = getattr(cpu, "usage_nano_cores", None) if cpu else None
                cpu_raw = TIERS.get(rec.tier, {}).get("cpu", "1")
                if isinstance(cpu_raw, str) and cpu_raw.endswith("m"):
                    cores = float(cpu_raw[:-1]) / 1000.0
                else:
                    cores = float(cpu_raw)
                cores = cores or 1.0
                rec.cpu_pct = max(0.0, min(100.0, (nano or 0) / (cores * 1e9) * 100.0))
                # Memory: used_bytes / total_bytes.
                mem = getattr(s, "memory", None)
                used = getattr(mem, "used_bytes", None) if mem else None
                total = getattr(mem, "total_bytes", None) if mem else None
                rec.mem_pct = max(0.0, min(100.0, (used / total * 100.0) if used and total else 0.0))
                # Storage (formerly 'disk'): used / total.
                st = getattr(s, "storage", None)
                used_s = getattr(st, "used_bytes", None) if st else None
                total_s = getattr(st, "total_bytes", None) if st else None
                rec.disk_pct = max(0.0, min(100.0, (used_s / total_s * 100.0) if used_s and total_s else 0.0))
            except Exception as e:
                msg = str(e)
                # Race: service auto-suspended between get() and get_stats(). Reconcile silently.
                if "SandboxNotRunning" in msg or "GlobalSandboxNotRunning" in msg or "is not in Running state" in msg or "409" in msg:
                    rec.state = "Stopped"
                    rec.cpu_pct = rec.mem_pct = rec.disk_pct = 0.0
                    self._log("lifecycle", f"{rec.id} auto-suspended (observed during stats)")
                elif "404" in msg or "NotFound" in msg:
                    rec.state = "Deleted"
                    self._handles.pop(rec.id, None)
                    self._log("lifecycle", f"{rec.id} gone (observed during stats)")
                else:
                    self._log("error", f"stats {rec.id}: {e}")

    def sync_existing(self):
        """Discover sandboxes that already exist in the sandbox group (e.g. on startup)."""
        self.ensure_ready()
        try:
            found = 0
            tracked_ids = {r.real_id for r in self._records.values() if r.real_id}
            tracked_names = {r.name for r in self._records.values()}
            tracked_label_names = {
                r.labels.get("name") for r in self._records.values() if r.labels.get("name")
            }
            for s in self._client.list_sandboxes():
                real_id = getattr(s, "id", None) or getattr(s, "name", None)
                if not real_id:
                    continue
                labels = getattr(s, "labels", {}) or {}
                # Only show sandboxes that belong to this game.
                if labels.get("game") != "sandboxeroids":
                    continue
                label_name = labels.get("name")
                svc_name = getattr(s, "name", None)
                # skip if already tracked by real id, by stored name, or by labels.name
                if real_id in tracked_ids:
                    continue
                if svc_name and svc_name in tracked_ids:
                    continue
                if label_name and (label_name in tracked_names or label_name in tracked_label_names):
                    # adopt: backfill real_id on the existing record so future syncs match
                    for r in self._records.values():
                        if r.labels.get("name") == label_name or r.name == label_name:
                            if not r.real_id:
                                r.real_id = real_id
                                if r.id not in self._handles:
                                    try:
                                        self._handles[r.id] = self._client.get_sandbox_client(real_id)
                                    except Exception:
                                        pass
                            break
                    continue
                labels = getattr(s, "labels", {}) or {}
                disk = labels.get("disk") or "ubuntu"
                tier = labels.get("tier") or "M"
                family = labels.get("family") or _classify_disk(disk) or "ubuntu"
                name = labels.get("name") or real_id[:12]
                local_id = f"sbx-{uuid.uuid4().hex[:8]}"
                rec = SandboxRecord(
                    id=local_id, real_id=real_id, name=name,
                    state=str(getattr(s, "state", "Running")),
                    disk=disk, family=family, tier=tier, created_at=time.time(),
                    labels=dict(labels),
                )
                self._records[local_id] = rec
                try:
                    self._handles[local_id] = self._client.get_sandbox_client(real_id)
                except Exception:
                    pass
                found += 1
            if found:
                self._log("system", f"adopted {found} existing sandboxes from group")
        except Exception as e:
            self._log("error", f"sync_existing: {e}")

    def exec(self, sid: str, cmd: str) -> dict:
        h = self._handles.get(sid)
        if not h:
            return {"exit_code": -1, "stdout": "", "stderr": "sandbox not found"}
        self._log("exec", f"{sid} $ {cmd}")
        try:
            r = h.exec(cmd)
            res = {
                "exit_code": getattr(r, "exit_code", 0),
                "stdout": getattr(r, "stdout", "") or "",
                "stderr": getattr(r, "stderr", "") or "",
            }
            preview = res["stdout"][:80].replace("\n", " ⏎ ")
            self._log("exec", f"{sid} ⇒ exit {res['exit_code']} {preview}")
            return res
        except Exception as e:
            self._log("error", f"exec {sid}: {e}")
            return {"exit_code": -1, "stdout": "", "stderr": str(e)}

    def list_files(self, sid: str, path: str = "/") -> list[dict]:
        h = self._handles.get(sid)
        if not h:
            return []
        try:
            r = h.list_files(path)
            # SDK returns a DirListing(.entries: list[FileInfo]); older shapes may
            # already be iterable or a plain list of dicts.
            entries = getattr(r, "entries", None)
            if entries is None:
                entries = r if isinstance(r, (list, tuple)) else list(r)
            out = []
            for x in entries:
                if isinstance(x, dict):
                    out.append({
                        "path": x.get("path") or x.get("name", ""),
                        "size": x.get("size", 0) or 0,
                        "is_dir": x.get("is_directory", x.get("is_dir", False)),
                    })
                else:
                    out.append({
                        "path": getattr(x, "path", None) or getattr(x, "name", ""),
                        "size": getattr(x, "size", 0) or 0,
                        "is_dir": getattr(x, "is_directory", getattr(x, "is_dir", False)),
                    })
            return out
        except Exception as e:
            self._log("error", f"list_files {sid}: {e}")
            return []

    def read_file(self, sid: str, path: str) -> str:
        h = self._handles.get(sid)
        if not h:
            return ""
        try:
            data = h.read_file(path)
            if isinstance(data, bytes):
                try:
                    return data.decode()
                except UnicodeDecodeError:
                    return f"<binary {len(data)} bytes>"
            return str(data)
        except Exception as e:
            return f"<error: {e}>"

    def write_file(self, sid: str, path: str, content: str) -> bool:
        h = self._handles.get(sid)
        if not h:
            return False
        try:
            h.write_file(path, content)
            self._log("fs", f"{sid} wrote {path} ({len(content)} bytes)")
            return True
        except Exception as e:
            self._log("error", f"write_file {sid}: {e}")
            return False
