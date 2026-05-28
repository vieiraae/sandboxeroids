// Sandboxeroids — main game loop.
// Asteroids ARE Azure Container Apps sandboxes. Their color = lifecycle state.
// Shooting moves the lifecycle: Running → Stopping → Stopped → (recovers if left alone, else Deleting → boom).

const ICON_FAMILIES = ["ubuntu", "python", "nodejs", "dotnet", "githubcopilot", "typescript"];
const TIER_RADIUS = { XS: 22, S: 32, M: 44, L: 60 };
const STATE_COLOR = {
  Creating:  "#60a5fa",
  Running:   "#34d399",
  Stopping:  "#fbbf24",
  Stopped:   "#fb923c",
  Resuming:  "#60a5fa",
  Deleting:  "#f87171",
  Deleted:   "#444",
};

// ------- icon loading (whitened SVGs) -------
const iconImages = {};
function whitenImageToCanvas(img) {
  // Returns an offscreen canvas with the image's alpha mask filled in white.
  // Works for both vector SVGs and embedded rasters (e.g. dotnet.svg has a base64 PNG).
  const w = img.naturalWidth || 64;
  const h = img.naturalHeight || 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d');
  cctx.drawImage(img, 0, 0, w, h);
  cctx.globalCompositeOperation = 'source-in';
  cctx.fillStyle = '#ffffff';
  cctx.fillRect(0, 0, w, h);
  return c;
}
async function loadIcons() {
  await Promise.all(ICON_FAMILIES.map(async name => {
    try {
      const txt = await fetch(`/public/icons/${name}.svg`).then(r => r.text());
      // force every fill/stroke to white (works for true vector SVGs)
      const white = txt
        .replace(/fill\s*=\s*"(?!none)[^"]*"/gi, 'fill="#ffffff"')
        .replace(/stroke\s*=\s*"(?!none)[^"]*"/gi, 'stroke="#ffffff"')
        .replace(/fill:[^;"]+/gi, 'fill:#ffffff')
        .replace(/stroke:[^;"]+/gi, 'stroke:#ffffff');
      const finalSvg = /fill=/.test(white) ? white : white.replace('<svg', '<svg fill="#ffffff"');
      const blob = new Blob([finalSvg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      // Fallback for icons that wrap an embedded raster (no SVG fill/stroke to recolor):
      // composite alpha → white onto an offscreen canvas so they render as white silhouettes.
      iconImages[name] = whitenImageToCanvas(img);
    } catch (e) { console.warn("icon", name, e); }
  }));
}

// ------- canvas setup -------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;
function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = W = Math.floor(r.width * devicePixelRatio);
  canvas.height = H = Math.floor(r.height * devicePixelRatio);
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  W = r.width; H = r.height;
}
window.addEventListener('resize', resize);

// ------- input -------
const keys = new Set();
window.addEventListener('keydown', e => {
  keys.add(e.key.toLowerCase());
  if (e.key === ' ') { e.preventDefault(); if (overlay.classList.contains('hidden')) firePlayer(); else hideOverlay(); }
});
window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

// ------- state -------
const stars = Array.from({ length: 220 }, () => ({
  x: Math.random(), y: Math.random(), z: Math.random() * 0.8 + 0.2,
}));

const player = {
  x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI/2,
  alive: true, cooldown: 0, lives: 6, score: 0, wave: 1,
  invuln: 0,
};
const bullets = []; // {x,y,vx,vy,life,from:'player'|'enemy'}
const enemies = []; // AI ships
const particles = []; // explosions / engine trails
const asteroids = new Map(); // sandbox_id -> asteroid sprite
let selectedId = null; // retained only for the on-canvas selection ring after a card hover
let config = null;
let avgLatency = 0;

// ------- websocket -------
let ws;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      msg.sandboxes.forEach(upsertSandbox);
      avgLatency = msg.avg_latency_ms;
    } else if (msg.type === 'stats') {
      msg.sandboxes.forEach(upsertSandbox);
      // remove asteroids whose sandbox vanished
      const live = new Set(msg.sandboxes.map(s => s.id));
      for (const id of asteroids.keys()) {
        if (!live.has(id) && asteroids.get(id).sandbox.state !== 'Deleting') {
          asteroids.delete(id);
        }
      }
      avgLatency = msg.avg_latency_ms;
      renderSandboxList();
      updateMetrics();
    } else if (msg.type === 'sandbox_created') {
      upsertSandbox(msg.sandbox);
      avgLatency = msg.avg_latency_ms;
      addLog({ source: 'create', message: `🆕 ${msg.sandbox.name || msg.sandbox.id} · ${msg.sandbox.tier} · ${msg.sandbox.disk}` });
    } else if (msg.type === 'sandbox_updated') {
      upsertSandbox(msg.sandbox);
    } else if (msg.type === 'sandbox_deleted') {
      // explosion already triggered locally; do final cleanup
      const a = asteroids.get(msg.id);
      if (a) { explode(a.x, a.y, a.r, '#f87171'); asteroids.delete(msg.id); }
    } else if (msg.type === 'logs') {
      msg.logs.forEach(addLog);
    }
  };
  ws.onclose = () => setTimeout(connectWS, 1000);
}

function upsertSandbox(s) {
  let a = asteroids.get(s.id);
  if (!a) {
    const r = TIER_RADIUS[s.tier] || 30;
    // spawn somewhere off-center, away from player
    let x, y, tries = 0;
    do {
      x = Math.random() * W;
      y = Math.random() * H;
      tries++;
    } while (tries < 20 && Math.hypot(x - W/2, y - H/2) < 180);
    a = {
      id: s.id,
      x, y, r,
      vx: (Math.random() - 0.5) * 30,
      vy: (Math.random() - 0.5) * 30,
      spin: (Math.random() - 0.5) * 0.6,
      rot: Math.random() * Math.PI * 2,
      sandbox: s,
      damageState: 0, // 0=running, 1=stopping/stopped, 2=deleting
      lastHit: 0,
      shape: makeAsteroidShape(r),
    };
    asteroids.set(s.id, a);
  } else {
    a.sandbox = s;
  }
}

function makeAsteroidShape(r) {
  const n = 10 + Math.floor(Math.random() * 5);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const rr = r * (0.78 + Math.random() * 0.35);
    pts.push({ x: Math.cos(ang) * rr, y: Math.sin(ang) * rr });
  }
  return pts;
}

// ------- api helpers -------
async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function spawnSandbox(disk) {
  try {
    const q = disk ? `?disk=${encodeURIComponent(disk)}` : '';
    await api(`/api/sandboxes${q}`, { method: 'POST' });
  } catch (e) { console.warn(e); }
}

async function hitSandbox(sid) {
  const a = asteroids.get(sid);
  if (!a) return;
  const now = performance.now();
  a.lastHit = now;
  if (a.damageState === 0) {
    a.damageState = 1;
    await api(`/api/sandboxes/${sid}/stop`, { method: 'POST' }).catch(() => {});
    // schedule auto-recovery if not hit again within 3.5s
    setTimeout(() => {
      const cur = asteroids.get(sid);
      if (!cur) return;
      if (cur.damageState === 1 && performance.now() - cur.lastHit > 3000) {
        cur.damageState = 0;
        api(`/api/sandboxes/${sid}/resume`, { method: 'POST' }).catch(() => {});
      }
    }, 3500);
  } else if (a.damageState === 1) {
    a.damageState = 2;
    player.score += 100 + (TIER_RADIUS[a.sandbox.tier] || 30);
    await api(`/api/sandboxes/${sid}`, { method: 'DELETE' }).catch(() => {});
    // explode visually and remove locally after a beat
    explode(a.x, a.y, a.r, '#f87171');
    setTimeout(() => asteroids.delete(sid), 400);
  }
  updateMetrics();
}

// ------- shooting / collisions -------
function firePlayer() {
  if (!player.alive || player.cooldown > 0) return;
  const sp = 520;
  bullets.push({
    x: player.x + Math.cos(player.angle) * 20,
    y: player.y + Math.sin(player.angle) * 20,
    vx: Math.cos(player.angle) * sp + player.vx,
    vy: Math.sin(player.angle) * sp + player.vy,
    life: 1.3, from: 'player',
  });
  player.cooldown = 0.16;
}

function fireEnemy(e) {
  const sp = 320;
  const ang = Math.atan2(player.y - e.y, player.x - e.x);
  bullets.push({
    x: e.x + Math.cos(ang) * 16, y: e.y + Math.sin(ang) * 16,
    vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
    life: 1.6, from: 'enemy',
  });
}

// ------- enemy AI -------
function spawnEnemy() {
  const side = Math.floor(Math.random() * 4);
  const x = side === 0 ? -30 : side === 1 ? W + 30 : Math.random() * W;
  const y = side === 2 ? -30 : side === 3 ? H + 30 : Math.random() * H;
  enemies.push({
    x, y, vx: 0, vy: 0, angle: 0, hp: 2, cooldown: 1.5,
    color: ['#a78bfa', '#f472b6', '#60a5fa'][Math.floor(Math.random() * 3)],
  });
}

// ------- explosions -------
function explode(x, y, r, color) {
  for (let i = 0; i < 30; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 60 + Math.random() * 220;
    particles.push({
      x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      life: 0.6 + Math.random() * 0.5, color,
    });
  }
}

// ------- game loop -------
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  update(dt);
  draw();
  requestAnimationFrame(loop);
}

function update(dt) {
  // stars
  // (just drawn — parallax based on player velocity)

  // player
  if (player.alive) {
    const thrust = 240, turn = 3.6;
    if (keys.has('a') || keys.has('arrowleft')) player.angle -= turn * dt;
    if (keys.has('d') || keys.has('arrowright')) player.angle += turn * dt;
    const accel = (keys.has('w') || keys.has('arrowup')) ? thrust : 0;
    const boost = keys.has('shift') ? 1.8 : 1;
    player.vx += Math.cos(player.angle) * accel * boost * dt;
    player.vy += Math.sin(player.angle) * accel * boost * dt;
    // drag
    player.vx *= 0.992; player.vy *= 0.992;
    player.x += player.vx * dt; player.y += player.vy * dt;
    // wrap
    if (player.x < 0) player.x += W; if (player.x > W) player.x -= W;
    if (player.y < 0) player.y += H; if (player.y > H) player.y -= H;
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.invuln = Math.max(0, player.invuln - dt);

    // engine particles
    if (accel) {
      particles.push({
        x: player.x - Math.cos(player.angle) * 14,
        y: player.y - Math.sin(player.angle) * 14,
        vx: -Math.cos(player.angle) * 60 + (Math.random()-0.5)*40,
        vy: -Math.sin(player.angle) * 60 + (Math.random()-0.5)*40,
        life: 0.35, color: boost > 1 ? '#a78bfa' : '#5eead4',
      });
    }
  }

  // bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || b.x < -20 || b.x > W+20 || b.y < -20 || b.y > H+20) {
      bullets.splice(i, 1); continue;
    }
    if (b.from === 'player') {
      // vs asteroids
      for (const a of asteroids.values()) {
        if (a.sandbox.state === 'Deleting' || a.sandbox.state === 'Deleted') continue;
        if (Math.hypot(b.x - a.x, b.y - a.y) < a.r) {
          bullets.splice(i, 1);
          explode(b.x, b.y, 6, '#fde68a');
          hitSandbox(a.id);
          break;
        }
      }
      // vs enemies
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        if (Math.hypot(b.x - e.x, b.y - e.y) < 16) {
          e.hp -= 1;
          explode(b.x, b.y, 6, '#fde68a');
          bullets.splice(i, 1);
          if (e.hp <= 0) {
            explode(e.x, e.y, 22, e.color);
            enemies.splice(j, 1);
            player.score += 250;
          }
          break;
        }
      }
    } else if (b.from === 'enemy' && player.alive && player.invuln <= 0) {
      if (Math.hypot(b.x - player.x, b.y - player.y) < 14) {
        bullets.splice(i, 1);
        damagePlayer();
      }
    }
  }

  // enemies AI
  for (const e of enemies) {
    const dx = player.x - e.x, dy = player.y - e.y;
    const dist = Math.hypot(dx, dy);
    e.angle = Math.atan2(dy, dx);
    const desired = Math.max(0, Math.min(1, (dist - 220) / 220));
    e.vx += Math.cos(e.angle) * 140 * desired * dt;
    e.vy += Math.sin(e.angle) * 140 * desired * dt;
    // sideways jitter to look alive
    e.vx += Math.cos(e.angle + Math.PI/2) * Math.sin(performance.now()/300) * 30 * dt;
    e.vy += Math.sin(e.angle + Math.PI/2) * Math.sin(performance.now()/300) * 30 * dt;
    e.vx *= 0.98; e.vy *= 0.98;
    e.x += e.vx * dt; e.y += e.vy * dt;
    e.cooldown -= dt;
    if (e.cooldown <= 0 && dist < 420) {
      fireEnemy(e); e.cooldown = 0.9 + Math.random() * 0.8;
    }
  }

  // asteroids
  for (const a of asteroids.values()) {
    a.x += a.vx * dt; a.y += a.vy * dt; a.rot += a.spin * dt;
    if (a.x < -a.r) a.x = W + a.r; if (a.x > W + a.r) a.x = -a.r;
    if (a.y < -a.r) a.y = H + a.r; if (a.y > H + a.r) a.y = -a.r;
    // collision with player
    if (player.alive && player.invuln <= 0 &&
        a.sandbox.state !== 'Deleting' && a.sandbox.state !== 'Deleted' &&
        Math.hypot(a.x - player.x, a.y - player.y) < a.r + 10) {
      damagePlayer();
    }
  }

  // particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
    p.vx *= 0.96; p.vy *= 0.96;
    if (p.life <= 0) particles.splice(i, 1);
  }

  // wave management
  const aliveAsteroids = [...asteroids.values()].filter(a => a.sandbox.state === 'Running' || a.sandbox.state === 'Stopping' || a.sandbox.state === 'Stopped').length;
  if (enemies.length < Math.min(3, player.wave) && Math.random() < 0.003) spawnEnemy();
  // when many asteroids destroyed, bump wave
}

function damagePlayer() {
  player.lives -= 1;
  explode(player.x, player.y, 18, '#f87171');
  player.invuln = 2.0;
  player.vx = 0; player.vy = 0;
  updateMetrics();
  if (player.lives <= 0) {
    player.alive = false;
    showOverlay('GAME OVER', 'Press SPACE to respawn');
    setTimeout(() => {
      // respawn ready when space pressed → handled in keydown via hideOverlay
    }, 100);
  }
}

function resetPlayer() {
  player.x = W / 2; player.y = H / 2;
  player.vx = player.vy = 0; player.alive = true;
  player.lives = (config && config.starting_lives) || 6;
  player.score = 0; player.invuln = 2.0;
  updateMetrics();
}

// ------- drawing -------
function draw() {
  ctx.clearRect(0, 0, W, H);

  // stars (slow parallax)
  ctx.save();
  for (const s of stars) {
    const x = (s.x * W - player.x * 0.05 * s.z + W * 10) % W;
    const y = (s.y * H - player.y * 0.05 * s.z + H * 10) % H;
    ctx.fillStyle = `rgba(255,255,255,${0.2 + s.z * 0.7})`;
    ctx.fillRect(x, y, s.z * 2, s.z * 2);
  }
  ctx.restore();

  // asteroids
  for (const a of asteroids.values()) drawAsteroid(a);

  // bullets
  for (const b of bullets) {
    ctx.fillStyle = b.from === 'player' ? '#5eead4' : '#f472b6';
    ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = b.from === 'player' ? 'rgba(94,234,212,0.4)' : 'rgba(244,114,182,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.vx*0.02, b.y - b.vy*0.02); ctx.stroke();
  }

  // enemies
  for (const e of enemies) drawEnemy(e);

  // particles
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;

  // player
  if (player.alive) drawPlayer();

  // selection ring
  if (selectedId && asteroids.has(selectedId)) {
    const a = asteroids.get(selectedId);
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(a.x, a.y, a.r + 8, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawAsteroid(a) {
  const color = STATE_COLOR[a.sandbox.state] || '#888';
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(a.rot);
  // body
  ctx.beginPath();
  for (let i = 0; i < a.shape.length; i++) {
    const p = a.shape[i];
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(15,20,40,0.85)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // damage cracks for state
  if (a.sandbox.state === 'Stopping' || a.sandbox.state === 'Stopped') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-a.r*0.6, 0); ctx.lineTo(a.r*0.4, a.r*0.2);
    ctx.moveTo(-a.r*0.2, -a.r*0.4); ctx.lineTo(a.r*0.3, -a.r*0.5);
    ctx.stroke();
  } else if (a.sandbox.state === 'Deleting') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      const ang = i / 5 * Math.PI * 2;
      ctx.lineTo(Math.cos(ang) * a.r * 0.8, Math.sin(ang) * a.r * 0.8);
      ctx.stroke();
    }
  }
  ctx.restore();

  // icon (counter-rotated so it stays upright)
  const icon = iconImages[a.sandbox.family || a.sandbox.disk];
  if (icon) {
    const sz = a.r * 0.9;
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.globalAlpha = 0.95;
    ctx.drawImage(icon, -sz/2, -sz/2, sz, sz);
    ctx.restore();
  }

  // tier label
  ctx.fillStyle = '#d6e1ff';
  ctx.font = 'bold 10px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center';
  ctx.fillText(`${a.sandbox.name || a.sandbox.id} · ${a.sandbox.tier}`, a.x, a.y + a.r + 12);
}

function drawPlayer() {
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);
  if (player.invuln > 0 && Math.floor(player.invuln * 10) % 2 === 0) ctx.globalAlpha = 0.4;
  // sleek arrow ship with neon hull
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(-12, 10);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, -10);
  ctx.closePath();
  ctx.fillStyle = '#0c1330';
  ctx.fill();
  ctx.strokeStyle = '#5eead4';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#5eead4'; ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // cockpit
  ctx.fillStyle = '#a78bfa';
  ctx.beginPath(); ctx.arc(4, 0, 3, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

function drawEnemy(e) {
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.rotate(e.angle);
  // sinister triangle-X
  ctx.beginPath();
  ctx.moveTo(14, 0); ctx.lineTo(-10, 12); ctx.lineTo(-4, 0); ctx.lineTo(-10, -12);
  ctx.closePath();
  ctx.fillStyle = '#1a0e22'; ctx.fill();
  ctx.strokeStyle = e.color; ctx.lineWidth = 2;
  ctx.shadowColor = e.color; ctx.shadowBlur = 10; ctx.stroke();
  ctx.shadowBlur = 0;
  // wings
  ctx.beginPath();
  ctx.moveTo(-8, -12); ctx.lineTo(-14, -18);
  ctx.moveTo(-8, 12);  ctx.lineTo(-14, 18);
  ctx.stroke();
  ctx.restore();
}

// ------- canvas click → open portal (shift-click or just click on asteroid) -------
canvas.addEventListener('click', async ev => {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  for (const a of asteroids.values()) {
    if (Math.hypot(a.x - x, a.y - y) < a.r) {
      if (ev.shiftKey) {
        const { url } = await api(`/api/sandbox_url/${a.id}`);
        window.open(url, '_blank');
      }
      return;
    }
  }
});

canvas.addEventListener('dblclick', async ev => {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  for (const a of asteroids.values()) {
    if (Math.hypot(a.x - x, a.y - y) < a.r) {
      const { url } = await api(`/api/sandbox_url/${a.id}`);
      window.open(url, '_blank');
      return;
    }
  }
});

async function execCmd(sid, presetCmd) {
  const cmd = (presetCmd || '').trim();
  if (!cmd) return null;
  return api(`/api/sandboxes/${sid}/exec`, { method: 'POST', body: JSON.stringify({ cmd }) });
}

async function listFiles(sid, path) {
  const { files } = await api(`/api/sandboxes/${sid}/files?path=${encodeURIComponent(path || '/')}`);
  return files;
}

async function readFile(sid, path) {
  const { content } = await api(`/api/sandboxes/${sid}/files/read?path=${encodeURIComponent(path)}`);
  return content;
}

async function writeFile(sid, path, content) {
  await api(`/api/sandboxes/${sid}/files/write`, {
    method: 'POST', body: JSON.stringify({ path, content }),
  });
}

// ------- modal -------
function openModal(title, builder) {
  const root = document.getElementById('modal-root');
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  builder(body);
  root.classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-root').classList.add('hidden');
}
// Wire close affordances once (close button, backdrop click, Esc).
(function wireModalCloseOnce() {
  const init = () => {
    const root = document.getElementById('modal-root');
    if (!root || root.dataset.wired) return;
    root.dataset.wired = '1';
    document.getElementById('modal-close').addEventListener('click', closeModal);
    root.querySelector('.modal-backdrop').addEventListener('click', closeModal);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !root.classList.contains('hidden')) closeModal();
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

function openExecModal(sid) {
  const sandbox = asteroids.get(sid)?.sandbox;
  const label = sandbox?.name || sid;
  openModal(`⚡ Exec on ${label}`, (body) => {
    const cmds = (config && config.popular_commands) || [];
    body.innerHTML = `
      <div class="row">
        <select id="m-cmd-select"></select>
      </div>
      <div class="row">
        <input id="m-cmd-input" placeholder="…or type a custom command" />
        <button id="m-cmd-run">Run</button>
      </div>
      <pre id="m-cmd-output" class="output">(no output yet)</pre>
    `;
    const sel = body.querySelector('#m-cmd-select');
    cmds.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    const input = body.querySelector('#m-cmd-input');
    const out = body.querySelector('#m-cmd-output');
    const run = async () => {
      const cmd = input.value.trim() || sel.value;
      if (!cmd) return;
      out.textContent = `$ ${cmd}\n…`;
      try {
        const r = await execCmd(sid, cmd);
        out.textContent = `$ ${cmd}\n[exit ${r.exit_code}]\n${r.stdout}${r.stderr ? '\nSTDERR:\n' + r.stderr : ''}`;
      } catch (e) { out.textContent = `error: ${e}`; }
    };
    body.querySelector('#m-cmd-run').onclick = run;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    input.focus();
  });
}

function openFilesModal(sid) {
  const sandbox = asteroids.get(sid)?.sandbox;
  const label = sandbox?.name || sid;
  openModal(`📁 Files on ${label}`, (body) => {
    body.innerHTML = `
      <h4>browse</h4>
      <div class="row">
        <input id="m-fs-path" value="/" />
        <button id="m-fs-ls">ls</button>
      </div>
      <ul id="m-fs-list" class="files"></ul>
      <h4>read / write</h4>
      <div class="row">
        <input id="m-fs-write-path" placeholder="/tmp/note.txt" />
        <button id="m-fs-read">read</button>
      </div>
      <textarea id="m-fs-write-content" placeholder="file contents..."></textarea>
      <div class="row">
        <button id="m-fs-write">write</button>
      </div>
      <pre id="m-fs-read-out" class="output">(no file loaded)</pre>
    `;
    const pathInput = body.querySelector('#m-fs-path');
    const list = body.querySelector('#m-fs-list');
    const writePath = body.querySelector('#m-fs-write-path');
    const writeContent = body.querySelector('#m-fs-write-content');
    const out = body.querySelector('#m-fs-read-out');
    const refresh = async () => {
      list.innerHTML = '<li class="dim">loading…</li>';
      try {
        const files = await listFiles(sid, pathInput.value || '/');
        list.innerHTML = '';
        files.forEach(f => {
          const li = document.createElement('li');
          li.textContent = `${f.is_dir ? '📁' : '📄'} ${f.path} (${f.size}b)`;
          li.onclick = () => {
            if (f.is_dir) { pathInput.value = f.path; refresh(); }
            else { writePath.value = f.path; readNow(); }
          };
          list.appendChild(li);
        });
      } catch (e) { list.innerHTML = `<li class="dim">error: ${e}</li>`; }
    };
    const readNow = async () => {
      if (!writePath.value) return;
      out.textContent = 'loading…';
      try { out.textContent = await readFile(sid, writePath.value); }
      catch (e) { out.textContent = `error: ${e}`; }
    };
    body.querySelector('#m-fs-ls').onclick = refresh;
    body.querySelector('#m-fs-read').onclick = readNow;
    body.querySelector('#m-fs-write').onclick = async () => {
      if (!writePath.value) return;
      try {
        await writeFile(sid, writePath.value, writeContent.value);
        out.textContent = `wrote ${writeContent.value.length} bytes to ${writePath.value}`;
      } catch (e) { out.textContent = `error: ${e}`; }
    };
    refresh();
  });
}

// ------- bottom: sandbox list -------
function renderSandboxList() {
  const root = document.getElementById('sbx-list');
  const items = [...asteroids.values()].map(a => a.sandbox).sort((a,b)=>a.created_at-b.created_at);
  const suspendMax = (config && config.auto_suspend_seconds) || 0;
  const now = Date.now() / 1000;
  root.innerHTML = items.map(s => {
    let displayState = s.state;
    let suspendBar = '';
    if (suspendMax > 0 && s.state === 'Running' && s.last_active_at) {
      const elapsed = Math.max(0, now - s.last_active_at);
      const remaining = Math.max(0, suspendMax - elapsed);
      const pct = (remaining / suspendMax) * 100;
      if (remaining <= 0) {
        displayState = 'Suspending';
        suspendBar = `
        <div class="suspend-row">
          <span class="suspend-label">⏳ suspending…</span>
          <div class="bar suspend low"><div style="width:100%"></div></div>
        </div>`;
      } else {
        const cls = pct < 25 ? 'low' : pct < 60 ? 'mid' : 'ok';
        suspendBar = `
        <div class="suspend-row">
          <span class="suspend-label">⏱ auto-suspend in ${remaining.toFixed(1)}s</span>
          <div class="bar suspend ${cls}"><div style="width:${pct.toFixed(1)}%"></div></div>
        </div>`;
      }
    }
    return `
    <div class="sbx-card state-${displayState.toLowerCase()} ${s.id === selectedId ? 'selected' : ''}" data-id="${s.id}">
      <div class="head">
        <span class="id">
          <img class="sbx-icon" src="/public/icons/${s.family || 'ubuntu'}.svg" alt="" />
          ${s.name || s.id}
        </span>
        <span class="tier">${s.tier}</span>
      </div>
      <div class="meta">${s.disk} · <span class="pill ${displayState.toLowerCase()}">${displayState}</span></div>
      <div class="bar cpu"><div style="width:${s.cpu.toFixed(0)}%"></div></div>
      <div class="bar mem"><div style="width:${s.memory.toFixed(0)}%"></div></div>
      <div class="bar disk"><div style="width:${s.disk_usage.toFixed(0)}%"></div></div>
      <div class="meta">cpu ${s.cpu.toFixed(0)}% · mem ${s.memory.toFixed(0)}% · disk ${s.disk_usage.toFixed(0)}%</div>
      ${suspendBar}
    </div>
  `;
  }).join('');
  root.querySelectorAll('.sbx-card').forEach(el => {
    el.onclick = () => { selectedId = el.dataset.id; renderSandboxList(); };
    el.oncontextmenu = (ev) => { ev.preventDefault(); openContextMenu(ev.clientX, ev.clientY, el.dataset.id); };
  });
}

// ------- context menu -------
function closeContextMenu() {
  const m = document.getElementById('ctx-menu');
  if (m) m.remove();
}
function openContextMenu(x, y, sid) {
  closeContextMenu();
  const a = asteroids.get(sid);
  if (!a) return;
  const s = a.sandbox;
  const items = [];
  items.push({ label: '🔗 Open in portal', fn: async () => {
    const { url } = await api(`/api/sandbox_url/${sid}`);
    window.open(url, '_blank');
  }});
  if (s.state === 'Running') {
    items.push({ label: '⚡ Exec command…', fn: async () => openExecModal(sid) });
    items.push({ label: '📁 Files…',        fn: async () => openFilesModal(sid) });
  }
  if (s.state === 'Running') {
    items.push({ label: '⏸ Stop', fn: async () => {
      await api(`/api/sandboxes/${sid}/stop`, { method: 'POST' });
    }});
  }
  if (s.state === 'Stopped' || s.state === 'Idle' || s.state === 'Suspended') {
    items.push({ label: '▶ Resume', fn: async () => {
      await api(`/api/sandboxes/${sid}/resume`, { method: 'POST' });
    }});
  }
  items.push({ label: '💥 Delete', danger: true, fn: async () => {
    await api(`/api/sandboxes/${sid}`, { method: 'DELETE' });
  }});

  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.className = 'ctx-menu';
  // Hide until we measure & clamp, so it can't flash off-screen.
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  items.forEach(it => {
    const b = document.createElement('div');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { closeContextMenu(); it.fn().catch(console.warn); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  // Clamp to viewport so the menu never gets clipped at the bottom/right edges.
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const pad = 6;
    const w = rect.width || 180;
    const h = rect.height || 32 * items.length;
    let left = x, top = y;
    if (left + w + pad > window.innerWidth)  left = Math.max(pad, window.innerWidth  - w - pad);
    if (top  + h + pad > window.innerHeight) top  = Math.max(pad, window.innerHeight - h - pad);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = 'visible';
  });
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

// ------- logs -------
function addLog(e) {
  const el = document.getElementById('logs');
  const div = document.createElement('div');
  div.className = 'log-entry';
  const t = new Date(e.ts * 1000).toLocaleTimeString();
  div.innerHTML = `<span class="ts">${t}</span><span class="src ${e.source}">[${e.source}]</span>${escapeHtml(e.message)}`;
  el.appendChild(div);
  while (el.children.length > 200) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ------- metrics -------
function updateMetrics() {
  document.getElementById('score').textContent = player.score;
  document.getElementById('lives').textContent = player.lives;
  document.getElementById('wave').textContent = player.wave;
  document.getElementById('avg-latency').textContent = `${avgLatency.toFixed(0)} ms`;
  document.getElementById('alive-count').textContent = asteroids.size;
}

// ------- overlay -------
const overlay = document.getElementById('overlay');
function showOverlay(title, sub) {
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-sub').textContent = sub;
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
  if (!player.alive) resetPlayer();
}

// ------- boot -------
(async function boot() {
  resize();
  await loadIcons();
  config = await api('/api/config');
  if (config.starting_lives) { player.lives = config.starting_lives; document.getElementById('lives').textContent = player.lives; }
  document.getElementById('mode').textContent = `AZURE · ${config.region}`;
  document.getElementById('mode').style.color = 'var(--ok)';

  const poolBtn = document.getElementById('pool-toggle');
  let poolEnabled = config.warm_pool_enabled;
  const renderPoolBtn = () => poolBtn.textContent = poolEnabled ? '⏸ Pause warm pool' : '▶ Resume warm pool';
  renderPoolBtn();
  poolBtn.onclick = async () => {
    const r = await api('/api/warm_pool/toggle', { method: 'POST' });
    poolEnabled = r.enabled; renderPoolBtn();
  };
  document.getElementById('sync-btn').onclick = async () => {
    await api('/api/sync', { method: 'POST' });
  };
  document.getElementById('spawn-btn').onclick = async () => {
    const btn = document.getElementById('spawn-btn');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = '… spawning';
    try { await api('/api/sandboxes', { method: 'POST' }); }
    catch (e) { console.warn(e); }
    finally { btn.disabled = false; btn.textContent = orig; }
  };

  connectWS();
  resetPlayer();
  showOverlay('SANDBOXEROIDS', `LIVE · sub ${config.subscription_id.slice(0,8)}… · rg ${config.resource_group} · ${config.sandbox_group}@${config.region} — SPACE to start · WASD/Arrows to fly · Shift = boost · Click asteroid to inspect · Shift+click to open in portal`);
  requestAnimationFrame(loop);

  // Periodically refresh sandbox list and metrics
  setInterval(() => { renderSandboxList(); updateMetrics(); }, 500);
})();
