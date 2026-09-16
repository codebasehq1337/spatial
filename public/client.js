/*
 * spatial — browser client (v4)
 *
 * 3D manila folders with paper inside. Angled camera for real depth.
 * Files are cards with real previews.
 */

import * as THREE from 'three';

/* =================================================================
   STATE
================================================================= */

const state = {
  ws: null,
  connected: false,
  current: null,
  cards: [],
  hovered: null,
  yaw: 0,
  pitch: 0,
  targetYaw: 0,
  targetPitch: 0,
};

const socket = {};

/* =================================================================
   DOM
================================================================= */

const $ = (id) => document.getElementById(id);
const backBtn = $('backBtn');
const crumbsEl = $('crumbs');
const statusEl = $('status');
const statusTextEl = $('statusText');
const tooltipEl = $('tooltip');
const modalEl = $('modal');
const modalNameEl = $('modalName');
const modalMetaEl = $('modalMeta');
const modalBodyEl = $('modalBody');
const modalCloseEl = $('modalClose');
const loaderEl = $('loader');
const loaderMsgEl = $('loaderMsg');

/* =================================================================
   THREE.JS
================================================================= */

const canvas = $('gl');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);
scene.fog = new THREE.FogExp2(0x03040a, 0.02);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  400,
);
camera.rotation.order = 'YXZ';

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

/* ---------- lights ---------- */

scene.add(new THREE.AmbientLight(0x3a4a6a, 0.5));

const warm = new THREE.PointLight(0xffb454, 3.5, 70, 2);
warm.position.set(4, 8, 10);
scene.add(warm);

const cool = new THREE.PointLight(0x6b8cff, 2.4, 70, 2);
cool.position.set(-10, -2, -4);
scene.add(cool);

const rim = new THREE.DirectionalLight(0xffe4b5, 0.7);
rim.position.set(6, 12, 5);
scene.add(rim);

/* =================================================================
   FLOOR + GRID
================================================================= */

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({
    color: 0x06080f,
    roughness: 0.55,
    metalness: 0.6,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -4.5;
scene.add(floor);

const grid = new THREE.GridHelper(400, 200, 0x1c2840, 0x101828);
grid.position.y = -4.49;
grid.material.transparent = true;
grid.material.opacity = 0.5;
scene.add(grid);

/* =================================================================
   STARS
================================================================= */

const STAR_COUNT = 800;
const starPositions = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  const r = 60 + Math.random() * 180;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
  starPositions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.7 + 10;
  starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
  color: 0xa8b4d4,
  size: 0.5,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
})));

/* =================================================================
   CONTROLS
================================================================= */

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Backspace') {
    e.preventDefault();
    goUp();
  }
  if (e.code === 'Escape') closeModal();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

let mouseDown = false;
let dragStartX = 0;
let dragStartY = 0;
let dragged = false;

const pointerNdc = new THREE.Vector2(0, 0);

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  mouseDown = true;
  dragged = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
});

window.addEventListener('pointermove', (e) => {
  pointerNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointerNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;

  if (mouseDown) {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged = true;
    state.targetYaw -= dx * 0.004;
    state.targetPitch -= dy * 0.004;
    state.targetPitch = Math.max(-1.2, Math.min(1.2, state.targetPitch));
    dragStartX = e.clientX;
    dragStartY = e.clientY;
  }

  if (state.hovered) {
    tooltipEl.style.left = `${e.clientX + 16}px`;
    tooltipEl.style.top = `${e.clientY + 16}px`;
  }
});

window.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  const wasDown = mouseDown;
  mouseDown = false;
  if (wasDown && !dragged && e.target === canvas) {
    handleClick();
  }
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  camera.position.addScaledVector(dir, -e.deltaY * 0.006);
}, { passive: false });

/* =================================================================
   NETWORK
================================================================= */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    statusEl.classList.add('connected');
    statusTextEl.textContent = 'connected';
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    statusEl.classList.remove('connected');
    statusTextEl.textContent = 'reconnecting…';
    setTimeout(connect, 1500);
  });

  ws.addEventListener('error', () => {
    statusTextEl.textContent = 'error';
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'folder') handleFolder(msg.data);
    else if (msg.type === 'file') handleFile(msg);
    else if (msg.type === 'error') {
      console.warn('[spatial] server error:', msg.message);
      loaderMsgEl.textContent = msg.message;
    }
  });
}

socket.list = (path) => {
  if (state.ws?.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'list', path }));
  }
};

socket.open = (path) => {
  if (state.ws?.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'open', path }));
  }
};

/* =================================================================
   COLORS
================================================================= */

function colorFor(entry) {
  if (entry.isDir) return 0xffb454;
  const ext = entry.ext || '';
  if (['png','jpg','jpeg','gif','webp','bmp','ico','avif'].includes(ext)) return 0xc792ea;
  if (['js','ts','jsx','tsx','mjs'].includes(ext)) return 0xffe066;
  if (['py','rb'].includes(ext)) return 0x82aaff;
  if (['c','cpp','cc','h','hpp','rs','go'].includes(ext)) return 0x7ee787;
  if (['json','yml','yaml','toml','ini','conf','env'].includes(ext)) return 0x89ddff;
  if (['html','css','scss','sass','less','xml','svg'].includes(ext)) return 0xff9e64;
  if (['md','markdown','txt','log'].includes(ext)) return 0xd2d6e0;
  if (['mp3','wav','flac','ogg','m4a'].includes(ext)) return 0xff6b9d;
  if (['mp4','mov','mkv','webm','avi'].includes(ext)) return 0xff6b6b;
  if (['zip','tar','gz','7z','rar','bz2'].includes(ext)) return 0xb294bb;
  return 0x8b93a3;
}

function hexColor(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

/* =================================================================
   LABELS
================================================================= */

function makeLabel(text, color, opts) {
  const { width = 512, height = 96, fontSize = 32, uppercase = false } = opts || {};

  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');

  ctx.clearRect(0, 0, width, height);
  ctx.font = `500 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;

  let label = uppercase ? text.toUpperCase() : text;
  const maxWidth = width - 40;

  if (ctx.measureText(label).width > maxWidth) {
    while (label.length > 1 && ctx.measureText(label + '…').width > maxWidth) {
      label = label.slice(0, -1);
    }
    label += '…';
  }

  ctx.fillText(label, width / 2, height / 2);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearFilter;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });

  return new THREE.Sprite(mat);
}

/* =================================================================
   FOLDER — 3D manila folder with paper inside, properly angled
================================================================= */

function makeFolder(entry) {
  const outer = new THREE.Group();
  const AMBER = 0xffb454;

  /* --- The folder body, rotated so it doesn't face dead-on.
     Every folder gets a slightly different Y rotation and tilt so
     the whole scene feels arranged rather than stamped out. --- */
  const body = new THREE.Group();
  body.rotation.y = (Math.random() - 0.5) * 0.55;
  body.rotation.x = (Math.random() - 0.5) * 0.08;
  body.rotation.z = (Math.random() - 0.5) * 0.05;
  outer.add(body);

  /* Dimensions */
  const BODY_W = 2.4;
  const BODY_H = 1.5;
  const TAB_W = 0.85;
  const TAB_H = 0.32;

  /* ---- Back panel: full folder silhouette with tab ---- */
  const backShape = new THREE.Shape();
  backShape.moveTo(-BODY_W / 2, -BODY_H / 2);
  backShape.lineTo(-BODY_W / 2, BODY_H / 2 - TAB_H);
  backShape.lineTo(-BODY_W / 2 + TAB_W, BODY_H / 2 - TAB_H);
  backShape.lineTo(-BODY_W / 2 + TAB_W * 0.72, BODY_H / 2);
  backShape.lineTo(BODY_W / 2, BODY_H / 2);
  backShape.lineTo(BODY_W / 2, -BODY_H / 2);
  backShape.closePath();

  const backGeo = new THREE.ExtrudeGeometry(backShape, {
    depth: 0.06,
    bevelEnabled: true,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    bevelSegments: 2,
  });
  backGeo.translate(0, 0, -0.03);

  const backMat = new THREE.MeshStandardMaterial({
    color: 0xb36c1e,
    emissive: AMBER,
    emissiveIntensity: 0.22,
    roughness: 0.55,
    metalness: 0.15,
  });
  const back = new THREE.Mesh(backGeo, backMat);
  body.add(back);

  /* ---- Papers, splayed out of the top of the folder.
     They lean back slightly so they're visible above the front panel. ---- */
  const paperColors = [0x7ee787, 0x82aaff, 0xffe066, 0xc792ea, 0xff9e64];
  const papers = [];
  const paperCount = 5;

  for (let i = 0; i < paperCount; i++) {
    const pw = BODY_W * 0.7;
    const ph = 0.55 + Math.random() * 0.2;
    const paperGeo = new THREE.PlaneGeometry(pw, ph);
    const paperMat = new THREE.MeshBasicMaterial({
      color: paperColors[i % paperColors.length],
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });
    const paper = new THREE.Mesh(paperGeo, paperMat);

    /* Papers fan out: each sits slightly higher, slightly rotated,
       slightly to the side. The tilt back makes them stand up out of
       the folder like real sheets. */
    paper.position.set(
      (i - paperCount / 2) * 0.045 + (Math.random() - 0.5) * 0.06,
      BODY_H / 2 - 0.1 + i * 0.02,
      0.04 + i * 0.012,
    );
    paper.rotation.z = (Math.random() - 0.5) * 0.14;
    paper.rotation.x = -0.18 - i * 0.015;
    body.add(paper);
    papers.push(paper);
  }

  /* ---- Front panel: SHORT, only covers the bottom half.
     This is the key fix — the front doesn't hide the papers. ---- */
  const FRONT_H = BODY_H * 0.55;
  const frontShape = new THREE.Shape();
  frontShape.moveTo(-BODY_W / 2, -BODY_H / 2);
  frontShape.lineTo(BODY_W / 2, -BODY_H / 2);
  frontShape.lineTo(BODY_W / 2, -BODY_H / 2 + FRONT_H);
  frontShape.lineTo(-BODY_W / 2, -BODY_H / 2 + FRONT_H);
  frontShape.closePath();

  const frontGeo = new THREE.ExtrudeGeometry(frontShape, {
    depth: 0.04,
    bevelEnabled: true,
    bevelSize: 0.014,
    bevelThickness: 0.014,
    bevelSegments: 2,
  });
  frontGeo.translate(0, 0, 0.05);

  const frontMat = new THREE.MeshStandardMaterial({
    color: 0xffc168,
    emissive: AMBER,
    emissiveIntensity: 0.35,
    roughness: 0.45,
    metalness: 0.2,
  });
  const front = new THREE.Mesh(frontGeo, frontMat);

  /* Front panel tilts forward slightly — an open folder, ready. */
  front.rotation.x = -0.15;
  body.add(front);

  /* ---- Amber edge outline on the front panel for definition ---- */
  const edges = new THREE.EdgesGeometry(frontGeo, 25);
  const outline = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({
      color: 0xffe4b5,
      transparent: true,
      opacity: 0.55,
    }),
  );
  body.add(outline);

  /* ---- Soft glow underneath, spilling onto the floor ---- */
  const glowGeo = new THREE.CircleGeometry(1.7, 40);
  const glowMat = new THREE.MeshBasicMaterial({
    color: AMBER,
    transparent: true,
    opacity: 0.09,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -BODY_H / 2 - 0.35;
  outer.add(glow);

  /* ---- Name label (billboarded — always faces camera) ---- */
  const label = makeLabel(entry.name, '#ffb454', {
    width: 512, height: 96, fontSize: 38,
  });
  label.position.set(0, BODY_H / 2 + 1.0, 0);
  label.scale.set(2.4, 0.45, 1);
  outer.add(label);

  /* ---- "folder" chip ---- */
  const chip = makeLabel('folder', 'rgba(255,180,84,0.7)', {
    width: 256, height: 64, fontSize: 24, uppercase: true,
  });
  chip.position.set(0, BODY_H / 2 + 0.62, 0);
  chip.scale.set(1.2, 0.3, 1);
  outer.add(chip);

  outer.userData = {
    entry,
    isDir: true,
    color: AMBER,
    body,
    front,
    glow,
    papers,
    baseScale: 1,
    targetScale: 1,
    baseY: 0,
    phase: Math.random() * Math.PI * 2,
  };

  return outer;
}

/* =================================================================
   FILE CARD
================================================================= */

function makeFileCard(entry) {
  const outer = new THREE.Group();
  const color = colorFor(entry);

  const W = 1.7;
  const H = 2.1;

  /* Slight rotation so cards don't face dead-on either */
  const card = new THREE.Group();
  card.rotation.y = (Math.random() - 0.5) * 0.4;
  outer.add(card);

  const cardGeo = new THREE.PlaneGeometry(W, H);

  const cnv = document.createElement('canvas');
  cnv.width = 512;
  cnv.height = 640;
  const ctx = cnv.getContext('2d');

  ctx.fillStyle = '#0a0c14';
  ctx.fillRect(0, 0, 512, 640);

  const grad = ctx.createLinearGradient(0, 0, 0, 640);
  grad.addColorStop(0, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 640);

  ctx.fillStyle = hexColor(color);
  ctx.fillRect(0, 0, 10, 640);

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 511, 639);

  ctx.fillStyle = '#e8e9ee';
  ctx.font = '600 28px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'top';

  let name = entry.name;
  if (ctx.measureText(name).width > 440) {
    while (name.length > 1 && ctx.measureText(name + '…').width > 440) {
      name = name.slice(0, -1);
    }
    name += '…';
  }
  ctx.fillText(name, 34, 36);

  const extLabel = (entry.ext || 'file').toUpperCase();
  ctx.font = '500 20px "JetBrains Mono", ui-monospace, monospace';
  const chipW = ctx.measureText(extLabel).width + 24;
  ctx.fillStyle = hexColor(color);
  ctx.globalAlpha = 0.15;
  ctx.fillRect(34, 84, chipW, 32);
  ctx.globalAlpha = 1;
  ctx.fillStyle = hexColor(color);
  ctx.fillText(extLabel, 46, 92);

  ctx.fillStyle = '#5a5f6b';
  ctx.font = '400 18px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(formatSize(entry.size), 478, 92);
  ctx.textAlign = 'left';

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.moveTo(34, 136);
  ctx.lineTo(478, 136);
  ctx.stroke();

  ctx.font = '400 17px "JetBrains Mono", ui-monospace, monospace';
  let py = 158;

  if (entry.previewLines && entry.previewLines.length) {
    for (const rawLine of entry.previewLines.slice(0, 22)) {
      if (py > 600) break;
      const line = rawLine.length > 44 ? rawLine.slice(0, 43) + '…' : rawLine;
      ctx.fillStyle = '#8b93a3';
      ctx.fillText(line, 34, py);
      py += 22;
    }
  } else {
    ctx.fillStyle = '#3a3f4b';
    ctx.font = 'italic 400 18px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText('— no preview —', 34, py);
  }

  const tex = new THREE.CanvasTexture(cnv);
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearFilter;

  const mesh = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.DoubleSide,
    transparent: true,
  }));
  card.add(mesh);

  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(cardGeo),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
  );
  outline.position.z = 0.001;
  card.add(outline);

  outer.userData = {
    entry,
    isDir: false,
    color,
    card,
    baseScale: 1,
    targetScale: 1,
    baseY: 0,
    phase: Math.random() * Math.PI * 2,
  };

  return outer;
}

/* =================================================================
   LAYOUT
================================================================= */

function computeLayout(n) {
  if (n === 0) return [];

  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
  const rows = Math.ceil(n / cols);
  const spacingX = 3.0;
  const spacingY = 3.0;

  const positions = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = (c - (cols - 1) / 2) * spacingX;
    const y = -(r - (rows - 1) / 2) * spacingY + 0.5;
    positions.push({ x, y });
  }
  return positions;
}

/* =================================================================
   RENDER FOLDER
================================================================= */

function clearScene() {
  for (const g of state.cards) {
    scene.remove(g);
    g.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
  }
  state.cards = [];
  state.hovered = null;
  tooltipEl.style.display = 'none';
}

function buildFolder(folder) {
  clearScene();

  const entries = folder.entries.slice(0, 80);
  const layout = computeLayout(entries.length);

  entries.forEach((entry, i) => {
    const group = entry.isDir ? makeFolder(entry) : makeFileCard(entry);
    const { x, y } = layout[i] ?? { x: 0, y: 0 };

    group.position.set(x, y, 0);
    group.scale.set(0.001, 0.001, 0.001);
    group.userData.targetScale = 1;
    group.userData.baseY = y;

    state.cards.push(group);
    scene.add(group);
  });

  loaderEl.classList.add('hidden');

  /* Camera positioned to see the layout, slightly off-axis so the
     whole scene has perspective instead of looking flat-on. */
  const cols = Math.ceil(Math.sqrt(entries.length * 1.6));
  const width = cols * 3.0;
  const camZ = Math.max(11, width * 0.9);

  camera.position.set(1.5, 1.8, camZ);
  camera.rotation.set(-0.1, -0.12, 0);
  state.yaw = -0.12;
  state.pitch = -0.1;
  state.targetYaw = -0.12;
  state.targetPitch = -0.1;
}

function handleFolder(folder) {
  state.current = folder;
  buildFolder(folder);
  updatePathBar();
}

/* =================================================================
   PATH BAR
================================================================= */

function updatePathBar() {
  if (!state.current) return;
  const { path: curPath, root, parent } = state.current;
  const rel = curPath.startsWith(root)
    ? curPath.slice(root.length).replace(/^[\\\/]/, '')
    : curPath;

  const parts = rel.split(/[\\\/]/).filter(Boolean);
  const rootLabel = root.split(/[\\\/]/).filter(Boolean).pop() || '/';

  crumbsEl.innerHTML = '';
  const rootCrumb = document.createElement('span');
  rootCrumb.className = 'crumb' + (parts.length === 0 ? ' last' : '');
  rootCrumb.textContent = rootLabel;
  crumbsEl.appendChild(rootCrumb);

  for (let i = 0; i < parts.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    crumbsEl.appendChild(sep);

    const c = document.createElement('span');
    c.className = 'crumb' + (i === parts.length - 1 ? ' last' : '');
    c.textContent = parts[i];
    crumbsEl.appendChild(c);
  }

  if (parent) backBtn.classList.remove('off');
  else backBtn.classList.add('off');
}

backBtn.addEventListener('click', goUp);

function goUp() {
  if (!state.current?.parent) return;
  socket.list(state.current.parent);
}

/* =================================================================
   CLICK
================================================================= */

const raycaster = new THREE.Raycaster();

function findOwner(obj) {
  while (obj && !state.cards.includes(obj)) obj = obj.parent;
  return obj;
}

function handleClick() {
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(state.cards, true);
  if (hits.length === 0) return;

  const owner = findOwner(hits[0].object);
  if (!owner) return;

  const entry = owner.userData.entry;
  if (entry.isDir) socket.list(entry.path);
  else openFile(entry);
}

/* =================================================================
   FILE VIEWER
================================================================= */

function openFile(entry) {
  modalNameEl.textContent = entry.name;
  modalMetaEl.textContent = `${entry.ext || 'file'} · ${formatSize(entry.size)}`;
  modalBodyEl.innerHTML = '<div class="empty">loading…</div>';
  modalEl.classList.add('open');
  socket.open(entry.path);
}

function handleFile(msg) {
  const { meta, content } = msg;
  modalNameEl.textContent = meta.name;
  modalMetaEl.textContent = `${meta.ext || 'file'} · ${formatSize(meta.size)}`;
  modalBodyEl.innerHTML = '';

  if (content.kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = content.text;
    modalBodyEl.appendChild(pre);
  } else if (content.kind === 'image') {
    const img = document.createElement('img');
    img.src = content.dataUrl;
    img.alt = meta.name;
    modalBodyEl.appendChild(img);
  } else {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = `No preview for .${content.ext || 'this'} files.`;
    modalBodyEl.appendChild(div);
  }
}

function closeModal() {
  modalEl.classList.remove('open');
}

modalCloseEl.addEventListener('click', closeModal);
modalEl.addEventListener('click', (e) => {
  if (e.target === modalEl) closeModal();
});

/* =================================================================
   FORMAT
================================================================= */

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* =================================================================
   HOVER
================================================================= */

function updateHover() {
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(state.cards, true);

  let newHover = null;
  if (hits.length > 0) {
    newHover = findOwner(hits[0].object);
  }

  if (newHover === state.hovered) return;

  if (state.hovered) {
    state.hovered.userData.targetScale = 1;
  }

  state.hovered = newHover;

  if (newHover) {
    newHover.userData.targetScale = 1.1;

    const entry = newHover.userData.entry;
    const meta = entry.isDir ? 'folder' : formatSize(entry.size);

    tooltipEl.innerHTML =
      `<strong>${escapeHtml(entry.name)}</strong> <span class="dim">· ${meta}</span>`;
    tooltipEl.style.display = 'block';
    canvas.style.cursor = 'pointer';
  } else {
    tooltipEl.style.display = 'none';
    canvas.style.cursor = 'crosshair';
  }
}

/* =================================================================
   RENDER LOOP
================================================================= */

const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsedTime();

  const speed = (keys['ShiftLeft'] ? 20 : 9) * dt;
  const forward = new THREE.Vector3(
    Math.sin(state.yaw), 0, Math.cos(state.yaw),
  ).multiplyScalar(-1);
  const right = new THREE.Vector3(forward.z, 0, -forward.x);

  if (keys['KeyW']) camera.position.addScaledVector(forward, speed);
  if (keys['KeyS']) camera.position.addScaledVector(forward, -speed);
  if (keys['KeyD']) camera.position.addScaledVector(right, speed);
  if (keys['KeyA']) camera.position.addScaledVector(right, -speed);
  if (keys['KeyE']) camera.position.y += speed;
  if (keys['KeyQ']) camera.position.y -= speed;

  state.yaw += (state.targetYaw - state.yaw) * 0.12;
  state.pitch += (state.targetPitch - state.pitch) * 0.12;

  camera.rotation.set(state.pitch, state.yaw, 0);

  if (!keys['KeyW'] && !keys['KeyS'] && !keys['KeyA'] && !keys['KeyD']) {
    camera.position.y += Math.sin(t * 0.7) * 0.0008;
  }

  for (const g of state.cards) {
    const ud = g.userData;

    const target = ud.targetScale;
    const cur = g.scale.x;
    const next = cur + (target - cur) * 0.18;
    g.scale.setScalar(next);

    if (ud.isDir) {
      g.position.y = ud.baseY + Math.sin(t * 1.2 + ud.phase) * 0.07;

      /* Front panel tilts further forward when hovered, as if opening. */
      if (ud.front) {
        const targetTilt = (ud === state.hovered) ? -0.35 : -0.15;
        ud.front.rotation.x += (targetTilt - ud.front.rotation.x) * 0.1;
      }

      /* Papers sway very slightly. */
      if (ud.papers) {
        for (let i = 0; i < ud.papers.length; i++) {
          const p = ud.papers[i];
          p.rotation.z += Math.sin(t * 1.5 + i * 0.7 + ud.phase) * 0.0004;
        }
      }

      if (ud.glow) {
        ud.glow.material.opacity = 0.06 + Math.sin(t * 1.4 + ud.phase) * 0.035;
      }
    } else {
      g.position.y = ud.baseY + Math.sin(t * 1.0 + ud.phase) * 0.05;

      /* Cards tilt a bit more toward camera when hovered. */
      if (ud.card) {
        const targetRotY = (ud === state.hovered) ? 0.1 : ud.card.userData.baseRotY ?? 0;
        ud.card.rotation.y += (targetRotY - ud.card.rotation.y) * 0.1;
      }
    }
  }

  updateHover();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

/* =================================================================
   RESIZE
================================================================= */

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/* =================================================================
   BOOT
================================================================= */

loaderMsgEl.textContent = 'connecting to server…';
connect();
tick();
