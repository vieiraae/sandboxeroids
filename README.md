# 🚀 Sandboxeroids

A 2D space shooter where **every asteroid is a real Azure Container Apps sandbox**.
Shoot one → it goes from `Running` → `Stopping` / `Stopped` (you'll see it change
color). Hit it again before it auto-recovers → `Deleting` → 💥.

Built to make the [ACA sandbox lifecycle](https://github.com/microsoft/azure-container-apps/blob/main/docs/early/sandboxes-overview.md)
fun, visual, and a little geeky.

## Features

- **Fly a ship** (WASD / arrows, Shift to boost, Space to shoot).
- **AI dogfighters** that chase you and shoot back.
- **Asteroids = sandboxes**: size = tier (XS / S / M / L), icon = disk image
  (ubuntu, python, nodejs, dotnet, githubcopilot, typescript), color = lifecycle
  state.
- **Click** an asteroid → it becomes the inspector target. **Shift-click** or
  **double-click** → opens it in `sandboxes.azure.com`.
- **Left panel**: avg create latency, live logs, exec dropdown of popular
  commands, mini file-system browser (list / read / write).
- **Bottom panel**: live cards for every alive sandbox with CPU / mem / disk bars,
  with the state legend (Running / Stopping / Stopped / Deleting) on the right.
- **Warm pool**: backend keeps `WARM_POOL_SIZE` sandboxes alive so new asteroids
  spawn fast.
- **Race-safe lifecycle**: stop/resume/delete pre-check live state and reconcile
  on 404 / 409 from the service (auto-suspend, vanished, etc.).

## Prerequisites

1. **Azure CLI** — `az login`. The signed-in CLI credential is used directly;
   no client secret or principal id required.
2. The signed-in user must have the **Container Apps SandboxGroup Data Owner**
   role on the target resource group.

   PowerShell (Windows):
   ```powershell
   az role assignment create `
     --assignee (az ad signed-in-user show --query id -o tsv) `
     --role "Container Apps SandboxGroup Data Owner" `
     --scope "/subscriptions/<sub>/resourceGroups/<rg>"
   ```

   bash / zsh (macOS / Linux):
   ```bash
   az role assignment create \
     --assignee "$(az ad signed-in-user show --query id -o tsv)" \
     --role "Container Apps SandboxGroup Data Owner" \
     --scope "/subscriptions/<sub>/resourceGroups/<rg>"
   ```

## Configure

Copy `.env.example` → `.env`:

```env
ACA_SUBSCRIPTION_ID=<your-sub-id>      # az account show --query id -o tsv
ACA_RESOURCE_GROUP=sandboxeroids-rg
ACA_SANDBOX_GROUP=sandboxeroids
ACA_REGION=eastus2

# Warm pool — how many sandboxes to keep alive for instant asteroid spawn
WARM_POOL_SIZE=4

# Lifecycle policy (per sandbox). Set seconds to 0 to disable a policy.
ACA_AUTO_SUSPEND_SECONDS=120
ACA_AUTO_SUSPEND_MODE=Memory
ACA_AUTO_DELETE_SECONDS=600

# Player starting lives (HUD + reset)
STARTING_LIVES=6

# Public disk images to use (comma-separated). Leave empty to use every image
# in the sandbox group that has a matching icon family.
ACA_DISK_IMAGES=copilot, ubuntu, dotnet-10, python-3.14, node-24
```

The resource group and sandbox group are created automatically if they don't
exist.

## Run

Windows (PowerShell):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
cd backend
uvicorn main:app --reload --port 8000
```

macOS / Linux (bash / zsh):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
uvicorn main:app --reload --port 8000
```

Then open <http://localhost:8000>. The backend serves the static frontend at
`/`, so there's nothing else to start.

## Run inside a sandbox (inception)

Prefer not to run anything locally? The [`create-and-deploy.ipynb`](create-and-deploy.ipynb)
notebook walks through an **inception** pattern: it creates a sandbox group with a
system-assigned managed identity, grants it the required roles, boots an
orchestrator sandbox, and deploys this app *inside* that sandbox — authenticating
with the managed identity, **no secrets**. Click **Run All** to provision
everything and get a public URL to the running game.

## Layout

```
backend/
  main.py              FastAPI + WebSocket
  sandbox_manager.py   SDK wrapper (real Azure only)
  requirements.txt
frontend/
  index.html  style.css  game.js
public/icons/          SVGs whitened at load time for the asteroid badges
```
