// 突出部之矛 桌面战场：三维桌面、物理、算子、拖放吸附与联机同步
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';
import { initRules } from './rules.js';
import { initBook } from './rulebook.js';
import { initMove } from './move.js';

const $ = (s) => document.querySelector(s);
const loadMsg = (t) => { $('#loadMsg').textContent = t; };

// ------------------------------------------------------------------ 数据
const D = await (await fetch('gamedata.json')).json();
const [SW, SH] = D.sheet;                      // 地图纸张尺寸（mm）
const HEXR = D.hexR;                           // 六角格外接圆半径（mm）
const pad = (n) => String(n).padStart(2, '0');
const HEX = new Map();
for (const [c, r, x, y, t] of D.hexes) {
  const id = pad(c + 1) + pad(r + 1);
  HEX.set(id, { id, c, r, x, y, t, X: (x - SW / 2) / 10, Z: (y - SH / 2) / 10 });
}
const RIVER = new Set(D.rivers.map((e) => [...e].sort().join('|')));
const BRIDGE = new Set(D.bridges.map((e) => [...e].sort().join('|')));
const UNIT = new Map(D.units.map((u) => [u.id, u]));
const TERRAIN = { c: '平原', f: '森林', h: '高地', t: '城镇' };
const axial = (h) => [h.c, h.r - (h.c - (h.c & 1)) / 2];
function hexDist(a, b) {
  const [aq, ar] = axial(a), [bq, br] = axial(b);
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
}
function nearestHex(X, Z) {
  const x = X * 10 + SW / 2, y = Z * 10 + SH / 2;
  let best = null, bd = 1e9;
  for (const h of HEX.values()) {
    const d = (h.x - x) ** 2 + (h.y - y) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  return bd <= (HEXR * 1.0) ** 2 ? best : null;
}

// 桌面上的盒子（世界坐标 cm）
const TRAYS = {
  reinfUS: { name: '美军增援（第 4 回合）', x0: -45.7, z0: 32.5, x1: -14.5, z1: 47, color: '#3d4428' },
  deadUS: { name: '美军损失', x0: -12.5, z0: 32.5, x1: 3.5, z1: 47, color: '#3a3324' },
  deadGE: { name: '德军损失', x0: 5.5, z0: 32.5, x1: 21.5, z1: 47, color: '#3a2624' },
  dice: { name: '掷骰盘', x0: 24, z0: 32.5, x1: 45.7, z1: 47, color: '#26301f' },
  exitGE: { name: '德军脱离区（西缘外）', x0: -70, z0: -26, x1: -48.5, z1: -4, color: '#3a2624' },
  fsch: { name: '伞兵待空投', x0: 48.5, z0: -30, x1: 70, z1: -14, color: '#2c2c2c' },
  markers: { name: '标记盒', x0: 48.5, z0: -11, x1: 70, z1: 12, color: '#2b2a1d' },
};
const trayAt = (X, Z) => Object.entries(TRAYS).find(([, t]) => X >= t.x0 && X <= t.x1 && Z >= t.z0 && Z <= t.z1)?.[0] || null;

// ------------------------------------------------------------------ 渲染器与场景
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#120f0b');
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.5, 600);
const HOME = { pos: new THREE.Vector3(6, 78, 62), target: new THREE.Vector3(4, 0, 2) };
camera.position.copy(HOME.pos);

scene.add(new THREE.HemisphereLight('#fff3dc', '#2a2014', 0.75));
const sun = new THREE.DirectionalLight('#fff1d6', 1.9);
sun.position.set(-40, 90, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 60, bottom: -60, near: 10, far: 220 });
sun.shadow.bias = -0.0004;
scene.add(sun);

function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// 胡桃木桌面
const woodTex = canvasTex(1024, 1024, (g, w, h) => {
  g.fillStyle = '#4a3220'; g.fillRect(0, 0, w, h);
  for (let p = 0; p < 6; p++) {
    const y0 = p * h / 6;
    g.fillStyle = ['#4d3421', '#45301f', '#523823'][p % 3]; g.fillRect(0, y0, w, h / 6);
    for (let i = 0; i < 60; i++) {
      g.strokeStyle = `rgba(${20 + Math.random() * 30},${10 + Math.random() * 15},5,${0.08 + Math.random() * 0.12})`;
      g.lineWidth = 1 + Math.random() * 2;
      g.beginPath();
      const yy = y0 + Math.random() * h / 6;
      g.moveTo(0, yy);
      for (let x = 0; x <= w; x += 64) g.lineTo(x, yy + Math.sin(x / 90 + i) * 3);
      g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, y0, w, 2);
  }
});
woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
woodTex.repeat.set(3, 2);
const table = new THREE.Mesh(new THREE.PlaneGeometry(160, 110), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.7 }));
table.rotation.x = -Math.PI / 2;
table.receiveShadow = true;
scene.add(table);

// 地图纸张
const maxTex = renderer.capabilities.maxTextureSize;
loadMsg('载入地图贴图（' + (maxTex >= 8192 ? '8K' : '4K') + '）');
const mapTex = await new THREE.TextureLoader().loadAsync(maxTex >= 8192 ? 'map_8k.jpg' : 'map_4k.jpg');
mapTex.colorSpace = THREE.SRGBColorSpace;
mapTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const sheet = new THREE.Mesh(new THREE.BoxGeometry(SW / 10, 0.04, SH / 10),
  [0, 0, 0, 0, 0, 0].map((_, i) => i === 2 ? new THREE.MeshStandardMaterial({ map: mapTex, roughness: 0.92 }) : new THREE.MeshStandardMaterial({ color: '#e9e2c9' })));
sheet.position.y = 0.02;
sheet.receiveShadow = true;
scene.add(sheet);

// 桌面盒子（毛毡底 + 标签）
for (const [key, t] of Object.entries(TRAYS)) {
  const w = t.x1 - t.x0, d = t.z1 - t.z0;
  const tex = canvasTex(512, Math.round(512 * d / w), (g, W, H) => {
    g.fillStyle = t.color; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    g.strokeStyle = 'rgba(201,164,76,.55)'; g.lineWidth = 4; g.strokeRect(6, 6, W - 12, H - 12);
    g.fillStyle = 'rgba(236,230,210,.75)'; g.font = '700 30px "Noto Sans SC", sans-serif'; g.textBaseline = 'top';
    g.fillText(t.name, 18, 16);
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set((t.x0 + t.x1) / 2, 0.012, (t.z0 + t.z1) / 2);
  m.receiveShadow = true;
  scene.add(m);
}

// ------------------------------------------------------------------ 物理
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -981, 0) });
world.allowSleep = true;
world.broadphase = new CANNON.SAPBroadphase(world);
const matPiece = new CANNON.Material('piece'), matTable = new CANNON.Material('table'), matDie = new CANNON.Material('die');
world.addContactMaterial(new CANNON.ContactMaterial(matPiece, matTable, { friction: 0.5, restitution: 0.05 }));
world.addContactMaterial(new CANNON.ContactMaterial(matPiece, matPiece, { friction: 0.6, restitution: 0.02 }));
world.addContactMaterial(new CANNON.ContactMaterial(matDie, matTable, { friction: 0.35, restitution: 0.38 }));
world.addContactMaterial(new CANNON.ContactMaterial(matDie, matDie, { friction: 0.2, restitution: 0.4 }));
world.addContactMaterial(new CANNON.ContactMaterial(matDie, matPiece, { friction: 0.3, restitution: 0.2 }));
const ground = new CANNON.Body({ mass: 0, material: matTable, shape: new CANNON.Plane() });
ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
ground.position.y = 0.04;
world.addBody(ground);
function wall(cx, cz, hx, hz, h = 1.2, visible = true) {
  const b = new CANNON.Body({ mass: 0, material: matTable, shape: new CANNON.Box(new CANNON.Vec3(hx, h, hz)) });
  b.position.set(cx, h, cz);
  world.addBody(b);
  if (visible) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, h * 2, hz * 2), new THREE.MeshStandardMaterial({ color: '#2e2014', roughness: 0.6 }));
    m.position.set(cx, h, cz); m.castShadow = m.receiveShadow = true; scene.add(m);
  }
}
{ // 掷骰盘围栏 + 桌边
  const t = TRAYS.dice, cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2, hw = (t.x1 - t.x0) / 2, hd = (t.z1 - t.z0) / 2;
  wall(cx, t.z0 - 0.3, hw + 0.6, 0.3); wall(cx, t.z1 + 0.3, hw + 0.6, 0.3);
  wall(t.x0 - 0.3, cz, 0.3, hd); wall(t.x1 + 0.3, cz, 0.3, hd);
  wall(0, -55.5, 80, 0.5, 4, false); wall(0, 55.5, 80, 0.5, 4, false); wall(-80.5, 0, 0.5, 56, 4, false); wall(80.5, 0, 0.5, 56, 4, false);
}

// ------------------------------------------------------------------ 算子贴图
await Promise.race([Promise.all([
  document.fonts.load('700 40px "Saira Condensed"'), document.fonts.load('600 40px "Saira Condensed"'),
  document.fonts.load('700 40px "Noto Sans SC"', '疲劳压制断补工事炸桥浮桥美军德军控制'),
]), new Promise((r) => setTimeout(r, 4000))]);
loadMsg('绘制算子');
const FM = {
  US: { body: '#7b8158', full: '#33362a', red: '#d6d9c4', txtFull: '#fff', txtRed: '#2a2c22' },
  SS: { body: '#151515', full: '#3a1838', red: '#c9a95a', txtFull: '#fff', txtRed: '#fff' },
  WH: { body: '#707070', full: '#101010', red: '#d9d9d9', txtFull: '#fff', txtRed: '#2a2a2a' },
};
function drawSymbol(g, sym, x, y, w, h) {
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 5; g.lineJoin = 'round';
  g.strokeRect(x, y, w, h);
  const cx = x + w / 2, cy = y + h / 2;
  const X = () => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y + h); g.moveTo(x + w, y); g.lineTo(x, y + h); g.stroke(); };
  const oval = (s = 1) => { const ow = w * 0.62 * s, oh = h * 0.5 * s; g.beginPath(); g.roundRect(cx - ow / 2, cy - oh / 2, ow, oh, oh / 2); g.stroke(); };
  const txt = (t, size, yy = cy) => { g.font = `700 ${size}px "Saira Condensed",sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, cx, yy); };
  switch (sym) {
    case 'inf': X(); break;
    case 'arm': oval(); break;
    case 'harm': oval(); txt('H', 26); break;
    case 'mech': X(); oval(0.7); break;
    case 'art': g.beginPath(); g.arc(cx, cy, 7, 0, 7); g.fill(); break;
    case 'hart': g.beginPath(); g.arc(cx, cy + 6, 7, 0, 7); g.fill(); txt('H', 22, cy - 12); break;
    case 'eng': g.beginPath(); g.moveTo(cx - w * 0.3, cy + h * 0.25); g.lineTo(cx - w * 0.3, cy - h * 0.1); g.lineTo(cx + w * 0.3, cy - h * 0.1); g.lineTo(cx + w * 0.3, cy + h * 0.25); g.moveTo(cx, cy - h * 0.1); g.lineTo(cx, cy + h * 0.25); g.stroke(); break;
    case 'rcn': oval(); g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + w, y); g.stroke(); break;
    case 'abn': X(); g.beginPath(); g.arc(cx - w * 0.16, cy + h * 0.3, w * 0.16, Math.PI, 0); g.arc(cx + w * 0.16, cy + h * 0.3, w * 0.16, Math.PI, 0); g.stroke(); break;
    case 'td': g.beginPath(); g.moveTo(x, y + h); g.lineTo(cx, y + 4); g.lineTo(x + w, y + h); g.stroke(); oval(0.55); break;
    case 'hq': oval(); txt('HQ', 24); break;
    case 'flak': oval(); g.beginPath(); g.arc(cx, cy, w * 0.33, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); break;
    case 'werf': oval(); g.beginPath(); g.moveTo(cx - 14, cy + 6); g.lineTo(cx, cy - 10); g.lineTo(cx + 14, cy + 6); g.moveTo(cx - 14, cy + 14); g.lineTo(cx, cy - 2); g.lineTo(cx + 14, cy + 14); g.stroke(); break;
    case 'sof': g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + w, y); g.stroke(); txt('SOF', 20); break;
    case 'air': { // 俯视的战斗机剪影
      g.beginPath();
      g.moveTo(cx, y + 8); g.lineTo(cx + 5, y + 18); g.lineTo(cx + 5, cy - 6); g.lineTo(cx + w * 0.42, cy + 2); g.lineTo(cx + w * 0.42, cy + 9);
      g.lineTo(cx + 5, cy + 6); g.lineTo(cx + 4, y + h - 18); g.lineTo(cx + 16, y + h - 10); g.lineTo(cx + 16, y + h - 5); g.lineTo(cx, y + h - 9);
      g.lineTo(cx - 16, y + h - 5); g.lineTo(cx - 16, y + h - 10); g.lineTo(cx - 4, y + h - 18); g.lineTo(cx - 5, cy + 6); g.lineTo(cx - w * 0.42, cy + 9);
      g.lineTo(cx - w * 0.42, cy + 2); g.lineTo(cx - 5, cy - 6); g.lineTo(cx - 5, y + 18); g.closePath(); g.fill();
      break;
    }
  }
}
// P-47 俯视剪影（机头朝上）：粗短的星型发动机整流罩、半椭圆机翼、气泡座舱
function drawP47(g, cx, cy, s) {
  g.save(); g.translate(cx, cy); g.scale(s, s);
  g.beginPath();
  g.moveTo(-6, -25); g.bezierCurveTo(-30, -27, -55, -21, -59, -10); g.bezierCurveTo(-59, -3, -40, 1, -6, 7);
  g.lineTo(6, 7); g.bezierCurveTo(40, 1, 59, -3, 59, -10); g.bezierCurveTo(55, -21, 30, -27, 6, -25); g.closePath(); g.fill();
  g.beginPath();
  g.moveTo(-7.5, -43); g.bezierCurveTo(-8.5, -50, 8.5, -50, 7.5, -43); g.bezierCurveTo(9.5, -18, 6, 12, 2.4, 47);
  g.lineTo(-2.4, 47); g.bezierCurveTo(-6, 12, -9.5, -18, -7.5, -43); g.closePath(); g.fill();
  g.beginPath();
  g.moveTo(-3, 31); g.bezierCurveTo(-14, 30, -22, 33, -22, 37); g.bezierCurveTo(-20, 41, -10, 42, -2, 41);
  g.lineTo(2, 41); g.bezierCurveTo(10, 42, 20, 41, 22, 37); g.bezierCurveTo(22, 33, 14, 30, 3, 31); g.closePath(); g.fill();
  const body = g.fillStyle;
  g.fillStyle = 'rgba(20,24,16,.75)'; g.beginPath(); g.ellipse(0, -9, 3, 8, 0, 0, 7); g.fill();          // 座舱
  g.strokeStyle = 'rgba(20,24,16,.55)'; g.lineWidth = 1.2;
  for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 22, -22); g.lineTo(sx * 22, 3); g.stroke(); } // 机翼分段线
  g.strokeStyle = body; g.globalAlpha = 0.5; g.lineWidth = 1.5; g.beginPath(); g.arc(0, -46, 17, 0, 7); g.stroke(); // 螺旋桨桨盘
  g.restore();
}
function airFace(u) {
  return canvasTex(256, 256, (g, W, H) => {
    g.fillStyle = '#6f7650'; g.fillRect(0, 0, W, H);
    const grad = g.createRadialGradient(128, 104, 10, 128, 104, 170); grad.addColorStop(0, 'rgba(255,255,255,.14)'); grad.addColorStop(1, 'rgba(0,0,0,.18)');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    // 底部：盟军识别带（黑白相间）
    const y0 = 196, bw = W / 5;
    for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#15150f' : '#f1ede0'; g.fillRect(i * bw, y0, bw + 1, H - y0); }
    g.fillStyle = '#6f7650'; g.fillRect(74, y0 + 9, 108, 42);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 40px "Saira Condensed",sans-serif'; g.fillText('P-47', 128, y0 + 32);
    g.font = '600 17px "Saira Condensed",sans-serif'; g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillText('IX TAC · USAAF', 128, 20);
    g.fillStyle = 'rgba(0,0,0,.28)'; drawP47(g, 131, 113, 1.62);
    g.fillStyle = '#f4f0e2'; drawP47(g, 128, 109, 1.62);
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 4; g.strokeRect(2, 2, W - 4, H - 4);
  });
}
function counterFace(u, reduced) {
  if (u.kind === 'air') return airFace(u);
  return canvasTex(256, 256, (g, W, H) => {
    const c = FM[u.fm];
    g.fillStyle = c.body; g.fillRect(0, 0, W, H);
    // 轻微纸面纹理
    for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    g.fillStyle = reduced ? c.red : c.full; g.fillRect(0, H * 0.66, W, H * 0.34);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = '700 34px "Saira Condensed",sans-serif'; g.fillText(u.ech, W / 2, 44);
    drawSymbol(g, u.sym, 62, 54, 132, 76);
    g.font = '600 15px "Saira Condensed",sans-serif'; g.fillText(u.label, W / 2, 156);
    g.save(); g.translate(40, 92); g.rotate(-Math.PI / 2); g.font = '700 21px "Saira Condensed",sans-serif'; g.fillText(u.side_label, 0, 0); g.restore();
    const s = reduced ? u.red : u.full;
    const v = u.kind === 'hq' ? `(${u.cmp})-${s[2]}-${s[3]}` : u.kind === 'air' ? 'AIR' : s.join('-');
    g.fillStyle = reduced ? c.txtRed : c.txtFull; g.font = '700 54px "Saira Condensed",sans-serif';
    g.fillText(v, W / 2, H * 0.66 + 62);
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 4; g.strokeRect(2, 2, W - 4, H - 4);
  });
}

const MARKERS = {
  F: { name: '疲劳', color: '#d9b83a', edge: '#8f7717', ink: '#2a2200' },
  P: { name: '压制', color: '#d9742b', edge: '#8a4212', ink: '#2a1200' },
  S: { name: '断补', color: '#a9a797', edge: '#66655a', ink: '#1d1d1d' },
  K: { name: '工事', color: '#8a6a3d', edge: '#4f3a1c', ink: '#f5ecd8' },
  B: { name: '炸桥', color: '#b3322b', edge: '#671611', ink: '#fff4e0' },
  W: { name: '浮桥', color: '#3f78ad', edge: '#1f4468', ink: '#f2f7fb' },
  CU: { name: '美军控制', color: '#6f7650', edge: '#3d4428', ink: '#fff' },
  CG: { name: '德军控制', color: '#7e817a', edge: '#4a4c47', ink: '#fff' },
};
// 每种标记的图形：画在 256×256 的圆盘中央
const MARK_GLYPH = {
  F(g, m) {   // 空了一半的弹匣
    g.fillStyle = m.ink; g.font = '700 132px "Saira Condensed",sans-serif'; g.fillText('F', 128, 122);
  },
  P(g, m) {   // 向下的双折线：被火力压住
    g.strokeStyle = m.ink; g.lineWidth = 20; g.lineCap = 'butt'; g.lineJoin = 'miter';
    for (const y of [78, 122]) { g.beginPath(); g.moveTo(74, y); g.lineTo(128, y + 40); g.lineTo(182, y); g.stroke(); }
  },
  S(g, m) {   // 油桶加一道斜杠
    g.strokeStyle = m.ink; g.fillStyle = m.ink; g.lineWidth = 10; g.lineJoin = 'round';
    g.strokeRect(92, 78, 64, 86); g.fillRect(104, 60, 28, 14); g.beginPath(); g.moveTo(104, 96); g.lineTo(144, 146); g.moveTo(144, 96); g.lineTo(104, 146); g.lineWidth = 7; g.stroke();
    g.strokeStyle = '#a3261f'; g.lineWidth = 14; g.beginPath(); g.moveTo(64, 188); g.lineTo(192, 60); g.stroke();
  },
  K(g, m) {   // 三层沙袋
    g.fillStyle = m.ink; g.strokeStyle = m.edge; g.lineWidth = 5;
    const bag = (x, y) => { g.beginPath(); g.roundRect(x, y, 58, 30, 14); g.fill(); g.stroke(); };
    bag(64, 140); bag(124, 140); bag(40 + 54, 108); bag(64, 76); bag(124, 76);
  },
  B(g, m) {   // 爆炸
    g.fillStyle = m.ink; g.beginPath();
    for (let i = 0; i < 20; i++) { const a = i * Math.PI / 10 - Math.PI / 2, r = i % 2 ? 34 : 72 - (i % 4 ? 0 : 10); g.lineTo(128 + r * Math.cos(a), 122 + r * Math.sin(a)); }
    g.closePath(); g.fill();
    g.fillStyle = m.color; g.beginPath(); g.arc(128, 122, 15, 0, 7); g.fill();
  },
  W(g, m) {   // 桥面 + 浮舟 + 水波
    g.strokeStyle = m.ink; g.fillStyle = m.ink; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(58, 96); g.lineTo(198, 96); g.stroke();
    for (const x of [80, 128, 176]) { g.beginPath(); g.moveTo(x - 18, 112); g.lineTo(x + 18, 112); g.lineTo(x + 11, 134); g.lineTo(x - 11, 134); g.closePath(); g.fill(); }
    g.lineWidth = 7; g.beginPath(); g.moveTo(62, 164);
    for (let x = 62; x < 194; x += 22) g.quadraticCurveTo(x + 5.5, 152, x + 11, 164), g.quadraticCurveTo(x + 16.5, 176, x + 22, 164);
    g.stroke();
  },
  CU(g, m) {  // 盟军识别星：白色五角星外加白圈
    g.strokeStyle = '#f4f0e2'; g.lineWidth = 11; g.beginPath(); g.arc(128, 128, 80, 0, 7); g.stroke();
    g.fillStyle = '#f4f0e2'; g.beginPath();
    for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, r = i % 2 ? 26.5 : 69; g.lineTo(128 + r * Math.cos(a), 128 + r * Math.sin(a)); }
    g.closePath(); g.fill();
  },
  CG(g) {     // 国防军车辆识别标志 Balkenkreuz：黑色直臂十字，四臂两侧各有白色折角边，臂端不封口
    const L = 172, w = 30, b = 15;
    const bar = (hw, len) => { g.fillRect(128 - hw, 128 - len / 2, hw * 2, len); g.fillRect(128 - len / 2, 128 - hw, len, hw * 2); };
    g.fillStyle = '#f2f1ea'; bar(w / 2 + b, L);
    g.fillStyle = '#111210'; bar(w / 2, L);
  },
};
const markerTexCache = {};
function markerTex(type) {
  if (markerTexCache[type]) return markerTexCache[type];
  const m = MARKERS[type];
  return (markerTexCache[type] = canvasTex(256, 256, (g, W, H) => {
    g.fillStyle = m.edge; g.fillRect(0, 0, W, H);
    const grad = g.createRadialGradient(108, 96, 12, 128, 128, 132); grad.addColorStop(0, 'rgba(255,255,255,.2)'); grad.addColorStop(1, 'rgba(0,0,0,.14)');
    g.fillStyle = m.color; g.beginPath(); g.arc(128, 128, 122, 0, 7); g.fill();
    g.fillStyle = grad; g.beginPath(); g.arc(128, 128, 122, 0, 7); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 4; g.beginPath(); g.arc(128, 128, 108, 0, 7); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.save(); g.beginPath(); g.arc(128, 128, 106, 0, 7); g.clip(); MARK_GLYPH[type](g, m); g.restore();
    if (!type.startsWith('C')) {   // 下缘的小字说明
      g.fillStyle = m.ink; g.globalAlpha = 0.9; g.font = '700 30px "Noto Sans SC",sans-serif'; g.fillText(m.name, 128, type === 'F' ? 202 : 208);
    }
  }));
}
// 算子与标记的图片（悬停卡、档案条、参谋板里用）
const imgCache = new Map();
function pieceImg(p) {
  const key = p.kind === 'marker' ? 'm:' + p.type : p.id + (p.flip ? ':r' : ':f');
  if (!imgCache.has(key)) imgCache.set(key, (p.kind === 'marker' ? markerTex(p.type) : p.faces[p.flip ? 1 : 0]).image.toDataURL('image/png'));
  return imgCache.get(key);
}

// ------------------------------------------------------------------ 棋子
const pieces = new Map();            // id -> piece
const pickables = [];
const CW = 1.5, CH = 0.24;           // 算子边长 15 mm、厚 2.4 mm
const QFLIP = new CANNON.Quaternion().setFromEuler(Math.PI, 0, 0);
const QUP = new CANNON.Quaternion();
function makeUnit(u) {
  const side = new THREE.MeshStandardMaterial({ color: FM[u.fm].body, roughness: 0.6 });
  const faces = [counterFace(u, false), counterFace(u, true)];
  const mats = [side, side, new THREE.MeshStandardMaterial({ map: faces[0], roughness: 0.55 }),
    new THREE.MeshStandardMaterial({ map: faces[1], roughness: 0.55 }), side, side];
  // 底面贴图在翻面后需要正向显示：BoxGeometry 的 -Y 面绕 X 轴翻转后方向一致
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(CW, CH, CW), mats);
  mesh.castShadow = mesh.receiveShadow = true;
  // 算子与标记一样不受重力：高度由 restack() 按堆叠顺序算好，叠在一起也不会互相顶着发抖；骰子仍然能撞上它们
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matPiece, shape: new CANNON.Box(new CANNON.Vec3(CW / 2, CH / 2, CW / 2)) });
  const p = { id: u.id, kind: 'unit', u, mesh, body, faces, flip: false, dmg: 0, tx: 0, tz: 0, ty: 0.04 + CH / 2, ord: 0, placed: false };
  mesh.userData.piece = p;
  scene.add(mesh); world.addBody(body); pickables.push(mesh); pieces.set(u.id, p);
  return p;
}
function makeMarker(id, type) {
  const m = MARKERS[type];
  const side = new THREE.MeshStandardMaterial({ color: m.edge, roughness: 0.45, metalness: 0.15 });
  const face = new THREE.MeshStandardMaterial({ map: markerTex(type), roughness: 0.42 });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.2, 48).rotateY(Math.PI / 2), [side, face, face]);   // 转正：图案上方朝向桌子远端
  mesh.castShadow = mesh.receiveShadow = true;
  // 标记不受重力：高度由 restack() 直接算到所在格那叠算子的顶上，不会悬空或歪倒
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matPiece, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.1, 0.5)) });
  const p = { id, kind: 'marker', type, mesh, body, flip: false, tx: 0, tz: 0, ty: 0.14, e: null, ord: Date.now() + Math.random() };
  mesh.userData.piece = p;
  scene.add(mesh); world.addBody(body); pickables.push(mesh); pieces.set(id, p);
  return p;
}
function removePiece(p) {
  scene.remove(p.mesh); world.removeBody(p.body);
  pickables.splice(pickables.indexOf(p.mesh), 1); pieces.delete(p.id);
  if (selected === p) select(null);
  if (p.kind === 'marker') restack(p.tx, p.tz);
}
// (x,z) 处的一叠：战斗单位在下，指挥部在上，标记最上，同类按放下的先后
const stackRank = (q) => (q.kind === 'marker' ? 2 : q.u.kind === 'hq' ? 1 : 0);
function stackAt(x, z) {
  return [...pieces.values()].filter((q) => q.kind !== 'die' && Math.hypot(q.tx - x, q.tz - z) < 0.55)
    .sort((a, b) => stackRank(a) - stackRank(b) || a.ord - b.ord);
}
// 重新计算 (x,z) 处每个棋子的高度
function restack(x, z) {
  let y = 0.04;
  for (const q of stackAt(x, z)) {
    if (q.kind === 'marker') { q.ty = y + 0.1; y += 0.205; } else { q.ty = y + CH / 2; y += CH; }
  }
}
for (const u of D.units) makeUnit(u);

// 跟着 p 一起移动的：单位身上的疲劳/压制/断补标记，以及同格的己方指挥部（格子上的工事、控制、桥梁标记留在原地）
const UNIT_MARKS = new Set(['F', 'P', 'S']);
function riders(p) {
  if (p.kind !== 'unit' || p.u.kind === 'hq' || p.u.kind === 'air') return [];
  return stackAt(p.tx, p.tz).filter((q) => q !== p &&
    ((q.kind === 'marker' && UNIT_MARKS.has(q.type)) || (q.kind === 'unit' && q.u.kind === 'hq' && q.u.side === p.u.side)));
}
// 拖动时 riders 叠在 p 上方的高度
function riderHeights(base, list) {
  let y = base + CH / 2;
  return list.map((r) => { if (r.kind === 'marker') { y += 0.205; return y - 0.105; } y += CH; return y - CH / 2; });
}
// 某处的棋子离开后，唤醒附近静止（休眠）的棋子，让它们自然落下
function wakeAround(x, z) {
  for (const q of pieces.values()) if (q.body.type === CANNON.Body.DYNAMIC && Math.hypot(q.body.position.x - x, q.body.position.z - z) < 1.2) q.body.wakeUp();
}
// 把棋子放到 (x,z)：落到这一叠的顶上（高度在主循环里缓动到 ty）
function settle(p, x, z, flip = p.flip) {
  const ox = p.tx, oz = p.tz, first = !p.placed, moved = first || Math.hypot(ox - x, oz - z) > 0.05;
  if (moved && !(first && p.kind === 'marker')) p.ord = Date.now() + Math.random();
  p.placed = true; p.tx = x; p.tz = z;
  if (p.kind === 'unit') p.flip = flip;
  const b = p.body;
  b.type = CANNON.Body.KINEMATIC; b.collisionResponse = true;
  b.velocity.setZero(); b.angularVelocity.setZero();
  b.quaternion.copy(p.kind === 'unit' && flip ? QFLIP : QUP);
  b.position.x = x; b.position.z = z;
  restack(x, z); if (moved) restack(ox, oz);
  if (first && p.kind === 'unit') b.position.y = p.ty;
  wakeAround(x, z);
}
// 动画移动（远端更新、翻面）：抬起→平移/翻转→落下
const tweens = new Map();
function animateTo(p, x, z, flip = p.flip, dur = 380, carry = false) {
  const b = p.body;
  if (carry) riders(p).forEach((r, i) => animateTo(r, x, z, r.kind === 'unit' ? r.flip : false, dur + 140 + i * 60));
  wakeAround(b.position.x, b.position.z);
  b.type = CANNON.Body.KINEMATIC; b.collisionResponse = false;
  b.velocity.setZero(); b.angularVelocity.setZero();
  const q0 = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(flip ? Math.PI : 0, 0, 0));
  tweens.set(p.id, { p, x0: b.position.x, z0: b.position.z, y0: b.position.y, x, z, q0, q1, flip, t0: performance.now(), dur });
}
function runTweens(now) {
  for (const [id, t] of tweens) {
    const k = Math.min(1, (now - t.t0) / t.dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const b = t.p.body;
    b.position.set(t.x0 + (t.x - t.x0) * e, t.y0 + (2.2 - t.y0) * Math.sin(Math.PI * Math.min(1, k * 1.05)) * 0.9 + 0.2 * (1 - e), t.z0 + (t.z - t.z0) * e);
    const q = t.q0.clone().slerp(t.q1, e);
    b.quaternion.set(q.x, q.y, q.z, q.w);
    if (k >= 1) { tweens.delete(id); settle(t.p, t.x, t.z, t.flip); }
  }
}

// ------------------------------------------------------------------ 骰子
const PIPS = { 1: [[.5, .5]], 2: [[.27, .27], [.73, .73]], 3: [[.25, .25], [.5, .5], [.75, .75]], 4: [[.27, .27], [.73, .27], [.27, .73], [.73, .73]],
  5: [[.25, .25], [.75, .25], [.5, .5], [.25, .75], [.75, .75]], 6: [[.27, .22], [.73, .22], [.27, .5], [.73, .5], [.27, .78], [.73, .78]] };
const FACE_NUM = [1, 6, 2, 5, 3, 4];          // BoxGeometry 面序 +X −X +Y −Y +Z −Z
const FACE_N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function dieMats(bg, pip) {
  return FACE_NUM.map((n) => new THREE.MeshStandardMaterial({ roughness: 0.35, map: canvasTex(128, 128, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
    g.fillStyle = pip; for (const [a, b] of PIPS[n]) { g.beginPath(); g.arc(a * 128, b * 128, 12, 0, 7); g.fill(); }
  }) }));
}
// 桌上常驻两枚骰子：红骰（攻方）、白骰（守方），颜色固定；点一下就投，按住可拖动
const DIE_STYLE = { att: dieMats('#a8291f', '#fff6e8'), def: dieMats('#ece6d2', '#1d2117') };
const DIE_NAME = { att: '红骰（攻方）', def: '白骰（守方）' };
const DS = 1.3;
const dice = ['att', 'def'].map((style, i) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(DS, DS, DS), DIE_STYLE[style]);
  mesh.castShadow = true;
  const body = new CANNON.Body({ mass: 1, material: matDie, shape: new CANNON.Box(new CANNON.Vec3(DS / 2, DS / 2, DS / 2)),
    linearDamping: 0.1, angularDamping: 0.1, sleepSpeedLimit: 1.5, sleepTimeLimit: 0.25 });
  const t = TRAYS.dice;
  body.position.set(t.x1 - 6 + i * 2.4, 0.04 + DS / 2, (t.z0 + t.z1) / 2 + 1);
  scene.add(mesh); world.addBody(body);
  const d = { id: 'die-' + style, kind: 'die', style, mesh, body, tx: body.position.x, tz: body.position.z, rolling: null };
  mesh.userData.piece = d; pickables.push(mesh);
  return d;
});
const dieOf = (s, i = 0) => dice.find((d) => d.style === s) || dice[i % 2];
function readFace(body, withTilt = false) {
  let best = 0, bv = -2;
  FACE_N.forEach((n, i) => { const v = body.quaternion.vmult(new CANNON.Vec3(...n)); if (v.y > bv) { bv = v.y; best = i; } });
  return withTilt ? [FACE_NUM[best], bv] : FACE_NUM[best];
}
function showFace(d, num) {
  const i = FACE_NUM.indexOf(num);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...FACE_N[i]), new THREE.Vector3(0, 1, 0));
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6.28);
  q.premultiply(yaw);
  d.body.type = CANNON.Body.KINEMATIC; d.body.velocity.setZero(); d.body.angularVelocity.setZero();
  d.body.quaternion.set(q.x, q.y, q.z, q.w); d.body.position.y = 0.04 + DS / 2;
}
const rnd = (a, b) => a + Math.random() * (b - a);
function throwParams(n) {   // 从掷骰盘一侧扔进盘里
  const t = TRAYS.dice;
  return Array.from({ length: n }, (_, i) => ({ p: [t.x0 + 3 + i * 2.2, rnd(5, 7), t.z1 - 2], v: [rnd(10, 24), -2, -rnd(16, 28)],
    w: [rnd(-20, 20), rnd(-20, 20), rnd(-20, 20)], q: [Math.random(), Math.random(), Math.random(), Math.random()] }));
}
function throwInPlace(d) {  // 点一下：就地抛起
  const b = d.body;
  return { p: [b.position.x, 3.2, b.position.z], v: [rnd(-6, 6), rnd(6, 10), rnd(-6, 6)], w: [rnd(-30, 30), rnd(-30, 30), rnd(-30, 30)],
    q: [Math.random(), Math.random(), Math.random(), Math.random()] };
}
// 投掷：styles 指定用哪枚骰子；params 为初速度（远端重演时用对方的参数）；faces 给定时落定后显示对方的结果
function rollDice(styles, params = throwParams(styles.length), faces = null) {
  const used = styles.map((s, i) => dieOf(s, i));
  const token = {};
  used.forEach((d, i) => {
    const pr = params[i], b = d.body;
    d.rolling = token;
    b.type = CANNON.Body.DYNAMIC; b.collisionResponse = true;
    b.position.set(...pr.p); b.velocity.set(...pr.v); b.angularVelocity.set(...pr.w);
    const q = new CANNON.Quaternion(...pr.q); q.normalize(); b.quaternion.copy(q);
    b.wakeUp();
  });
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      if (used.some((d) => d.rolling !== token)) return resolve(null);
      const done = used.every((d) => d.body.sleepState === CANNON.Body.SLEEPING) || performance.now() - t0 > 4500;
      if (!done) return setTimeout(check, 60);   // 不用 rAF：页面在后台时也要能结算
      const res = faces || used.map((d) => { const [f, up] = readFace(d.body, true); if (up < 0.92) showFace(d, f); return f; });
      if (faces) used.forEach((d, i) => showFace(d, faces[i]));
      used.forEach((d) => { d.tx = d.body.position.x; d.tz = d.body.position.z; });
      resolve(res);
    };
    setTimeout(check, 400);
  });
}

// ------------------------------------------------------------------ 状态与同步
const OBJ = D.objectives;                        // hexId -> VP
const tableId = (/^#[A-Za-z0-9_-]{1,16}$/.test(location.hash) ? location.hash.slice(1) : null) || 'main';
$('#tableId').value = tableId;
// fuel: 燃油危机发生的回合；g150: 150 装甲旅伪装已解除；m10: 705 坦歼营已进攻过；air: 本回合已空袭；
// hits: 本阶段谁进攻过谁；cmp: 本回合已用的指挥点；mv: 单位最近一次移动的阶段序号（回合×6+阶段）
const EXTRA_KEYS = ['fuel', 'g150', 'm10', 'air', 'hits', 'cmp', 'mv', 'pend', 'reg'];
const st = { units: {}, markers: {}, turn: 1, phase: 0, weather: '浓雾/暴雪', ctrl: {}, log: [], fuel: 0, g150: 0, m10: 0, air: 0, hits: { k: '', s: '{}' }, cmp: { t: 0, s: '{}' }, mv: {}, pend: { s: '{}' }, reg: { t: 0, s: '' } };
for (const id of Object.keys(OBJ)) st.ctrl[id] = 'US';
let db = null, docRef = null, docExists = false, pending = {}, writing = false, flushTimer = 0, gotFirst = false, unsub = null, readOnly = false;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(dst, src) { for (const k in src) { if (isObj(src[k]) && isObj(dst[k])) merge(dst[k], src[k]); else dst[k] = isObj(src[k]) ? structuredClone(src[k]) : src[k]; } return dst; }
const lsKey = 'sotb-table-' + tableId;
function saveLocal() { if (db) return; try { localStorage.setItem(lsKey, JSON.stringify(st)); } catch {} }
// 没有写入权限：停止同步，改为只在本机保存
function goLocal(msg) {
  if (unsub) { unsub(); unsub = null; }
  db = null; docRef = null; readOnly = false; pending = {};
  setSync('warn', '本机练习（不同步）');
  saveLocal();
  if (msg) toast(msg);
}
function commit(patch) {
  if (readOnly) goLocal('你在这个对局里只能观战。已切换为本机练习，操作不会同步给其他人。');
  merge(st, patch); merge(pending, patch); saveLocal();
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 150);
}
async function flush() {
  if (!docRef || writing || !Object.keys(pending).length) return;
  writing = true;
  const p = pending; pending = {};
  try {
    if (!docExists) { await docRef.set(structuredClone(st)); docExists = true; }
    else await docRef.update(p);
    setSync('ok', '已同步 · 对局 ' + tableId);
  } catch (e) {
    if (e?.code === 'invalid_argument') { writing = false; goLocal('你在这个对局里只能观战。已切换为本机练习，操作不会同步给其他人。'); return; }
    merge(pending, p);
    setSync('warn', '同步失败，稍后重试');
  }
  writing = false;
  if (Object.keys(pending).length) setTimeout(flush, 300);
}
function setSync(kind, text) { $('#syncDot').className = 'dot ' + kind; $('#syncText').textContent = text; }
let mySide = 'OBS';
try { mySide = localStorage.getItem('sotb-side') || 'OBS'; } catch {}
const sideName = { US: '美军', GE: '德军', OBS: '观战' };
function log(text, side = mySide) {
  const e = { t: Date.now(), s: side, m: text };
  st.log = [...st.log, e].slice(-60);
  commit({ log: st.log });
  renderLog();
}
function renderLog() {
  const ol = $('#log'); ol.replaceChildren();
  for (const e of [...st.log].reverse()) {
    const li = document.createElement('li'); li.className = e.s;
    const tm = document.createElement('time'); tm.textContent = new Date(e.t).toTimeString().slice(0, 5);
    li.append(tm, document.createTextNode(`${sideName[e.s] || ''} · ${e.m}`));
    ol.append(li);
  }
}

// 把状态里的位置同步到棋子
function applyState(remote, instant = false) {
  for (const [id, s] of Object.entries(remote.units || {})) {
    const p = pieces.get(id);
    if (!p || !s || drag?.p === p || remoteHeld.has(id)) continue;
    const moved = Math.hypot(p.tx - s.x, p.tz - s.z) > 0.05 || p.flip !== !!s.f;
    p.dmg = s.d || 0;
    if (!moved) continue;
    if (instant) settle(p, s.x, s.z, !!s.f); else animateTo(p, s.x, s.z, !!s.f);
  }
  // 旧存档里没有的算子（例如后来加入的 P-47）放到剧本位置
  const missing = [...pieces.values()].filter((p) => p.kind === 'unit' && !p.placed && !(remote.units || {})[p.id]);
  if (missing.length) { const def = scenarioState().units; for (const p of missing) { const s = def[p.id]; if (s) settle(p, s.x, s.z, !!s.f); } }
  for (const [id, s] of Object.entries(remote.markers || {})) {
    let p = pieces.get(id);
    if (!s) { if (p) removePiece(p); continue; }
    if (!p) { p = makeMarker(id, s.t); p.e = s.e ?? null; p.body.position.set(s.x, 3, s.z); settle(p, s.x, s.z); continue; }
    p.e = s.e ?? null;
    if (drag?.p !== p && Math.hypot(p.tx - s.x, p.tz - s.z) > 0.05) instant ? settle(p, s.x, s.z) : animateTo(p, s.x, s.z);
  }
  for (const p of [...pieces.values()]) if (p.kind === 'marker' && !(remote.markers || {})[p.id]) removePiece(p);
}

// 按剧本布置
function trayGrid(key, i, cols) {
  const t = TRAYS[key];
  const c = i % cols, r = Math.floor(i / cols);
  return [t.x0 + 2 + c * 2.1, t.z0 + 4.2 + r * 2.1];
}
function scenarioState() {
  const S = D.setup, units = {};
  const at = (id) => { const h = HEX.get(id); return { x: h.X, z: h.Z, f: 0, d: 0 }; };
  for (const [uid, hid] of Object.entries(S.us)) units[uid] = at(hid);
  units.US504 = at('1610');
  for (const z of Object.values(S.zones)) {
    let k = 0;
    for (const uid of z.units) { if (uid.startsWith('GHQ')) continue; units[uid] = at(z.hexes[k++]); }
  }
  units.GHQ1 = { ...units.GPz1 }; units.GHQ12 = { ...units.GPz12 };
  units.G150 = at(S.g150);
  let r = 0;
  for (const e of Object.values(S.entry)) for (const uid of e.units) {
    if (uid === 'USHQ') continue;
    const [x, z] = trayGrid('reinfUS', r++, 7); units[uid] = { x, z, f: 0, d: 0 };
  }
  units.USHQ = { ...units.USCCB };
  { const [x, z] = trayGrid('reinfUS', r, 7); units.USP47 = { x, z, f: 0, d: 0 }; }
  ['GFj5', 'GFj9'].forEach((uid, i) => { const [x, z] = trayGrid('fsch', i, 5); units[uid] = { x, z, f: 1, d: 1 }; });
  const ctrl = {}; for (const id of Object.keys(OBJ)) ctrl[id] = 'US';
  return { units, markers: {}, turn: 1, phase: 0, weather: '浓雾/暴雪', ctrl, fuel: 0, g150: 0, m10: 0, air: 0, hits: { k: '', s: '{}' }, cmp: { t: 0, s: '{}' }, mv: {}, pend: { s: '{}' }, reg: { t: 0, s: '' } };
}
function resetGame() {
  const s = scenarioState();
  const nullMarkers = {}; for (const id of Object.keys(st.markers)) nullMarkers[id] = null;
  const nullMv = {}; for (const id of Object.keys(st.mv || {})) nullMv[id] = null;
  st.units = s.units; st.markers = {}; st.turn = 1; st.phase = 0; st.weather = s.weather; st.ctrl = s.ctrl;
  for (const k of EXTRA_KEYS) st[k] = structuredClone(s[k]);
  pending = {}; commit({ units: s.units, markers: nullMarkers, turn: 1, phase: 0, weather: s.weather, ctrl: s.ctrl,
    fuel: 0, g150: 0, m10: 0, air: 0, hits: s.hits, cmp: s.cmp, mv: nullMv, pend: s.pend, reg: s.reg });
  for (const p of [...pieces.values()]) if (p.kind === 'marker') removePiece(p);
  applyState(st);
  rules.refresh();
}

// ------------------------------------------------------------------ 交互
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const planeAt = (y) => new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
function setNdc(e) { const r = renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); }
function hitPiece(e) { setNdc(e); const h = ray.intersectObjects(pickables, false)[0]; return h ? h.object.userData.piece : null; }
function hitPlane(e, y = 0) { setNdc(e); const v = new THREE.Vector3(); return ray.ray.intersectPlane(planeAt(y), v) ? v : null; }

let drag = null, selected = null;
const card = $('#card');
function pieceHex(p) { return p.kind === 'die' ? null : nearestHex(p.tx, p.tz); }
function whereOf(p) {
  const h = pieceHex(p);
  return h ? `${h.id} · ${TERRAIN[h.t]}${D.towns[h.id] ? ' · ' + D.towns[h.id][0] : D.villages[h.id] ? ' · ' + D.villages[h.id] : ''}` : (trayAt(p.tx, p.tz) ? TRAYS[trayAt(p.tx, p.tz)].name : '桌面');
}
function unitVal(p) { const u = p.u, s = p.flip ? u.red : u.full; return u.kind === 'hq' ? `(${u.cmp})-${s[2]}-${s[3]}` : s.join('-'); }
const imgTag = (p) => `<img src="${pieceImg(p)}" alt="" class="${p.kind === 'marker' ? 'round' : ''}">`;
function infoHtml(p) {
  if (p.kind === 'marker') return `<b>${MARKERS[p.type].name}标记</b><span class="hint">${whereOf(p)}</span>`;
  const u = p.u;
  return `<b>${u.name}</b>${u.kind === 'air' ? '' : `<span><span class="num">${unitVal(p)}</span> <span class="hint">${u.kind === 'hq' ? 'CMP-MP-R' : 'A-D-MP-R'} · ${p.flip ? '损伤面' : '完好面'}${p.dmg ? ` ${p.dmg}/${u.hp}` : ''}</span></span>`}
    <span class="hint">${whereOf(p)}</span>${u.rule ? `<span class="hint">${u.rule}</span>` : ''}`;
}
// 悬停：这枚棋子的图片与说明；同格有多枚时，把这一格的全部算子和标记的图片排出来（从上到下）
function describeStack(p) {
  if (p.kind === 'die') return `<b>${DIE_NAME[p.style]}</b><span class="hint">点一下投掷 · 按住拖动</span>`;
  const list = stackAt(p.tx, p.tz);
  let html = `<div class="top">${imgTag(p)}<div style="display:flex;flex-direction:column;gap:2px;min-width:0">${infoHtml(p)}</div></div>`;
  if (list.length > 1) html += `<div class="stk"><span class="label">本格 ${list.length} 枚 · 从上到下</span><div class="faces">${[...list].reverse().map((q) =>
    `<figure>${imgTag(q)}<figcaption>${q.kind === 'marker' ? MARKERS[q.type].name : q.u.name}</figcaption></figure>`).join('')}</div></div>`;
  return html;
}
function showCard(p, e) {
  if (!p) { card.hidden = true; return; }
  card.innerHTML = describeStack(p); card.hidden = false;
  const x = Math.min(e.clientX + 18, innerWidth - card.offsetWidth - 10), y = Math.min(e.clientY + 18, innerHeight - card.offsetHeight - 10);
  card.style.left = Math.max(8, x) + 'px'; card.style.top = Math.max(8, y) + 'px';
}
const selRing = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.25, 6), new THREE.MeshBasicMaterial({ color: '#d0aa52', transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
selRing.rotation.x = -Math.PI / 2; selRing.rotation.z = Math.PI / 6; selRing.visible = false; scene.add(selRing);
// 规则约束开关（只影响本机）：打开时移动、进攻、堆叠都按规则检查
let strictOn = true;
try { strictOn = localStorage.getItem('sotb-strict') !== '0'; } catch {}
const strict = () => strictOn;
function select(p) {
  selected = p && pieces.has(p.id) ? p : null;
  renderSel(); refreshOverlays();
}
function renderSel() {
  const bar = $('#selbar'), p = selected;
  if (!p) { bar.hidden = true; selRing.visible = false; return; }
  bar.className = p.kind === 'unit' ? p.u.side : '';
  bar.innerHTML = `${imgTag(p)}<div class="info">${infoHtml(p)}</div><div class="acts"></div>`;
  const acts = bar.querySelector('.acts');
  const add = (label, fn, cls = '') => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; acts.append(b); };
  if (p.kind === 'unit' && p.u.kind === 'air') {
    const s = document.createElement('span'); s.className = 'hint'; s.textContent = '晴朗天气的空袭阶段，把它拖到德军单位上'; acts.append(s);
  } else if (p.kind === 'unit') {
    const tg = targetsOf(p);
    if (tg.ids.size) { const s = document.createElement('span'); s.className = 'chip'; s.textContent = `点带红圈的敌军${tg.mode === 'arty' ? '炮击' : '进攻'}（${tg.ids.size} 个目标）`; acts.append(s); }
    if (rules.canRegroup(p)) add('整补', () => rules.regroup(p), 'primary');
    for (const [label, fn] of rules.engActions(p)) add(label, fn, 'primary');
    if (!strict()) {
      add('翻面 F', () => flipPiece(p));
      add('受 1 点损伤', () => damage(p, 1));
      add('移入损失盒 X', () => eliminate(p));
    }
  } else add('移除标记', () => removeMarker(p));
  add('取消', () => select(null));
  bar.hidden = false;
}
// 选中的算子现在能打谁：相邻的敌军（行动阶段），或射程内的敌军（炮兵阶段的炮兵）
function targetsOf(p) {
  const none = { ids: new Set(), mode: 'assault' }, h = pieceHex(p);
  if (!p || p.kind !== 'unit' || !h || ['hq', 'air'].includes(p.u.kind)) return none;
  const arty = p.u.kind === 'art';
  if (strict() && (arty ? st.phase !== 4 : !((st.phase === 2 && p.u.side === 'US') || (st.phase === 3 && p.u.side === 'GE')))) return none;
  if (strict() && (rules.attacked(p) || markerOnHex(h.id, 'P') || (!arty && (markerOnHex(h.id, 'F') || markerOnHex(h.id, 'S') || (st.turn === 1 && p.u.side === 'US'))))) return none;
  const R = arty ? (p.flip ? p.u.red : p.u.full)[3] : 1, ids = new Set();
  for (const q of pieces.values()) {
    if (q.kind !== 'unit' || q.u.side === p.u.side || ['hq', 'air'].includes(q.u.kind)) continue;
    const qh = pieceHex(q); if (!qh || hexDist(h, qh) > R) continue;
    if (q.u.id === 'G150' && rules.disguised()) continue;
    ids.add(q.id);
  }
  return { ids, mode: arty ? 'arty' : 'assault' };
}
const unitUnder = (p) => (p.kind === 'die' ? null : stackAt(p.tx, p.tz).find((q) => q.kind === 'unit' && !['hq', 'air'].includes(q.u.kind)) || null);
function removeMarker(m) { commit({ markers: { [m.id]: null } }); removePiece(m); }
function heal(p) { p.dmg = 0; p.flip = false; movePiece(p, p.tx, p.tz, false, { free: true }); animateTo(p, p.tx, p.tz, false, 450, true); }
function movePiece(p, x, z, flip = p.flip, opts = {}) {
  const h = nearestHex(x, z);
  if (h && !opts.free) { x = h.X; z = h.Z; }
  if (p.kind === 'unit') {
    const from = nearestHex(p.tx, p.tz);
    commit({ units: { [p.id]: { x: +x.toFixed(2), z: +z.toFixed(2), f: flip ? 1 : 0, d: p.dmg } } });
    if (h && from?.id !== h.id && !opts.free) commit({ mv: { [p.id]: st.turn * 6 + st.phase } });
    if (h && OBJ[h.id] && !['hq', 'air'].includes(p.u.kind) && st.ctrl[h.id] !== p.u.side) {
      commit({ ctrl: { [h.id]: p.u.side } });
      log(`${p.u.name} 进入 ${D.towns[h.id][0]}，取得控制`, p.u.side);
      rules.refresh();
    }
  } else commit({ markers: { [p.id]: { t: p.type, x: +x.toFixed(2), z: +z.toFixed(2), e: p.e ?? null } } });
  return [x, z];
}
function flipPiece(p) {
  p.flip = !p.flip;
  movePiece(p, p.tx, p.tz, p.flip, { free: true });
  animateTo(p, p.tx, p.tz, p.flip, 450, true);
  if (p.kind === 'unit') log(`${p.u.name} 翻到${p.flip ? '损伤面' : '完好面'}`, p.u.side);
}
function eliminate(p) {
  // 单位身上的标记一起移除；同格的指挥部移到 3 格内最近的己方战斗单位处，没有就一并消灭
  const from = pieceHex(p);
  for (const r of riders(p)) {
    if (r.kind === 'marker') { commit({ markers: { [r.id]: null } }); removePiece(r); continue; }
    const host = from && [...pieces.values()].filter((q) => q !== p && q.kind === 'unit' && q.u.side === p.u.side && !['hq', 'air'].includes(q.u.kind) && pieceHex(q) && !trayAt(q.tx, q.tz))
      .map((q) => [q, hexDist(pieceHex(q), from)]).filter(([, d]) => d <= 3).sort((a, b) => a[1] - b[1])[0]?.[0];
    if (host) { movePiece(r, host.tx, host.tz, r.flip, { free: true }); animateTo(r, host.tx, host.tz, r.flip, 600); log(`${r.u.name} 失去宿主，移到 ${host.u.name} 处`, r.u.side); }
    else setTimeout(() => eliminate(r), 50);
  }
  const key = p.u.side === 'US' ? 'deadUS' : 'deadGE';
  const n = [...pieces.values()].filter((q) => q.kind === 'unit' && trayAt(q.tx, q.tz) === key).length;
  const [x, z] = trayGrid(key, n, 7);
  movePiece(p, x, z, p.flip, { free: true });
  animateTo(p, x, z);
  log(`${p.u.name} 被消灭`, p.u.side === 'US' ? 'GE' : 'US');
  rules.refresh();
}
function damage(p, n) {
  p.dmg = (p.dmg || 0) + n;
  if (p.dmg >= p.u.hp) { eliminate(p); return 'dead'; }
  p.flip = true;
  movePiece(p, p.tx, p.tz, true, { free: true });
  animateTo(p, p.tx, p.tz, true, 450, true);
  log(`${p.u.name} 受 ${n} 点损伤（${p.dmg}/${p.u.hp}）`, p.u.side === 'US' ? 'GE' : 'US');
  return 'hit';
}
let mkSeq = 0;
function placeMarker(type, onPiece = null, e = null) {
  const id = 'm' + Date.now().toString(36) + (mkSeq++).toString(36) + Math.random().toString(36).slice(2, 5);
  const p = makeMarker(id, type); p.e = e;
  let x, z;
  if (onPiece) { x = onPiece.tx; z = onPiece.tz; }
  else { const t = TRAYS.markers, n = [...pieces.values()].filter((q) => q.kind === 'marker' && trayAt(q.tx, q.tz) === 'markers').length; x = t.x0 + 2 + (n % 9) * 2.2; z = t.z0 + 4.5 + Math.floor(n / 9) * 2.2; }
  movePiece(p, x, z, false, { free: true });
  p.body.position.set(x, 3, z);
  settle(p, x, z);
  return p;
}

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  let p = hitPiece(e);
  if (!p) return;
  // 规则约束打开时，点一叠里的任何一枚（标记、指挥部）都算点它底下的战斗单位
  if (strict() && p.kind !== 'die') p = unitUnder(p) || p;
  controls.enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
  const hp = hitPlane(e, 1.6) || new THREE.Vector3(p.body.position.x, 1.6, p.body.position.z);
  drag = { p, sx: e.clientX, sy: e.clientY, moved: false, ox: p.body.position.x - hp.x, oz: p.body.position.z - hp.z, id: e.pointerId };
});
let lastHover = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  const tp = hitPlane(e, 0.05);
  if (tp) presence({ cur: [+tp.x.toFixed(1), +tp.z.toFixed(1)] });
  if (drag) {
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) {
      drag.moved = true; const b = drag.p.body;
      tweens.delete(drag.p.id);
      if (drag.p.kind === 'die') drag.p.rolling = null;
      b.type = CANNON.Body.KINEMATIC; b.collisionResponse = false; b.velocity.setZero(); b.angularVelocity.setZero();
      if (drag.p.kind !== 'die') b.quaternion.copy(drag.p.flip ? QFLIP : QUP);
      card.hidden = true;
      drag.riders = riders(drag.p);
      for (const r of drag.riders) { tweens.delete(r.id); r.body.type = CANNON.Body.KINEMATIC; r.body.collisionResponse = false; r.body.velocity.setZero(); r.body.angularVelocity.setZero(); r.body.quaternion.copy(r.kind === 'unit' && r.flip ? QFLIP : QUP); }
      drag.ry = riderHeights(1.6, drag.riders);
      wakeAround(b.position.x, b.position.z);
      if (drag.p.kind === 'unit') { drag.range = legalRange(drag.p); if (drag.range.kind === 'move') drawRange(drag.range); else if (drag.range.note && !drag.range.hexes.size && !drag.range.free) toast(drag.range.note); }
    }
    if (drag.moved) {
      const hp = hitPlane(e, 1.6);
      if (hp && drag.p.kind === 'die') { drag.p.body.position.set(hp.x + drag.ox, 2.2, hp.z + drag.oz); }
      else if (hp) {
        drag.p.body.position.set(hp.x + drag.ox, 1.6, hp.z + drag.oz);
        (drag.riders || []).forEach((r, i) => r.body.position.set(hp.x + drag.ox, drag.ry[i], hp.z + drag.oz));
        const h = nearestHex(hp.x + drag.ox, hp.z + drag.oz);
        hoverHex.visible = !!h; if (h) hoverHex.position.set(h.X, 0.06, h.Z);
        presence({ drag: { id: drag.p.id, x: +(hp.x + drag.ox).toFixed(2), z: +(hp.z + drag.oz).toFixed(2), f: drag.p.flip ? 1 : 0 } });
      }
    }
    return;
  }
  const now = performance.now();
  if (now - lastHover < 40) return; lastHover = now;
  const hov = e.pointerType === 'mouse' ? hitPiece(e) : null;
  showCard(hov && strict() && hov.kind !== 'die' ? unitUnder(hov) || hov : hov, e);
});
function endDrag(e) {
  if (!drag) return;
  const d = drag; drag = null; controls.enabled = true; hoverHex.visible = false;
  try { renderer.domElement.releasePointerCapture(d.id); } catch {}
  const b = d.p.body;
  if (d.p.kind === 'die') {
    if (!d.moved) { rollOne(d.p); return; }
    b.type = CANNON.Body.DYNAMIC; b.collisionResponse = true;
    b.position.y = 0.04 + DS / 2 + 0.3; b.velocity.set(0, -2, 0); b.angularVelocity.setZero(); b.wakeUp();
    d.p.tx = b.position.x; d.p.tz = b.position.z;
    return;
  }
  hideRange();
  if (!d.moved) {
    // 已选中己方算子时，点带红圈的敌军就是进攻
    const tgt = unitUnder(d.p), tg = selected?.kind === 'unit' && tgt && tgt !== selected ? targetsOf(selected) : null;
    if (tg && tg.ids.has(tgt.id)) { rules.engage(selected, tgt, tg.mode); return; }
    select(d.p); return;
  }
  presence({ drag: null });
  const h0 = nearestHex(b.position.x, b.position.z), from = pieceHex(d.p), r = d.range, tr0 = trayAt(b.position.x, b.position.z);
  const back = (msg) => { toast(msg); dropTo(d, d.p.tx, d.p.tz, false); select(d.p); };
  if (d.p.kind === 'unit' && d.p.u.kind !== 'air' && r && !r.free) {
    if (h0 && h0.id !== from?.id && !r.hexes.has(h0.id))
      return back(r.kind === 'retreat' ? '只能后撤到橙色轮廓内' : r.kind === 'advance' ? '只能推进到绿色轮廓内' : r.hexes.size ? '超出本阶段的可移动范围（青色轮廓）' : (r.note || '现在不能移动这个单位'));
    if (!h0 && tr0 === 'exitGE' && !r.exitW) return back('要先走到地图西缘，并留有 0.5 MP 才能脱离');
    if (!h0 && r.kind !== 'move' && tr0 !== 'deadUS' && tr0 !== 'deadGE') return back(r.note || '现在不能移动这个单位');
  }
  const why = d.p.kind === 'unit' && h0 && h0.id !== from?.id ? stackProblem(d.p, h0) : null;
  if (why) return back(why);
  const [x, z] = movePiece(d.p, b.position.x, b.position.z, d.p.flip, { free: !h0 });
  dropTo(d, x, z, true);
  if (d.p.kind === 'unit') {
    const h = nearestHex(x, z), tr = trayAt(x, z), u = d.p.u;
    if (u.kind === 'air') {
      const target = h && stackAt(h.X, h.Z).find((q) => q.kind === 'unit' && q.u.side === 'GE' && !['hq', 'air'].includes(q.u.kind));
      rules.airStrike(target).then((msg) => {
        if (msg) toast(msg);
        setTimeout(() => { const s = scenarioState().units.USP47; movePiece(d.p, s.x, s.z, false, { free: true }); animateTo(d.p, s.x, s.z, false, 600); }, msg ? 300 : 1400);
      });
    } else {
      log(`${u.name} ${r?.kind === 'retreat' ? '后撤到' : r?.kind === 'advance' ? '推进到' : '→'} ${h ? h.id + (D.towns[h.id] ? ' ' + D.towns[h.id][0] : '') : tr ? TRAYS[tr].name : '桌面'}`, u.side);
      if (h && h.id !== from?.id) afterMove(d.p, r, from, h);
    }
  }
  setTimeout(() => { rules.refresh(); }, 260);
  select(d.p);
}
// 后撤、推进走完一步之后的衔接
function afterMove(p, r, from, h) {
  const pend = getPend();
  if (r?.kind === 'retreat' && pend.r?.id === p.id) {
    if (r.zocOnly) setTimeout(() => { log(`${p.u.name} 只能撤进敌方控制区，受 1 点损伤`, p.u.side); damage(p, 1); }, 300);
    const vac = pend.r.vac || from?.id, n = pend.r.n - 1, by = pieces.get(pend.r.by);
    setTimeout(() => {
      const ok = (p.dmg || 0) < p.u.hp && pieceHex(p);
      if (n > 0 && ok) { if (!startRetreat(p, n, pend.r.att, pend.r.by, vac)) return; }
      else setPend(by && pieceHex(by) && vac ? { a: { id: by.id, hexes: [vac] } } : {});
      rules.refresh();
    }, 420);
  } else if (r?.kind === 'advance' && pend.a?.id === p.id) {
    if (pend.a.blitz) setTimeout(() => { const hx = mover.burst(p, 2, moveCtx()); setPend(hx.length ? { a: { id: p.id, hexes: hx, burst: 1 } } : {}); rules.refresh(); }, 300);
    else setPend({});
  }
}
const getPend = () => { try { return JSON.parse(st.pend?.s || '{}'); } catch { return {}; } };
function setPend(o) { st.pend = { s: JSON.stringify(o) }; commit({ pend: st.pend }); refreshOverlays(); }
// 开始后撤：算出合法去处；无格可撤时原地受 2 点损伤。返回是否进入了“等待后撤”
function startRetreat(p, n, attHexId, attId, vac = null) {
  const rt = mover.retreat(p, attHexId, moveCtx());
  if (!rt.hexes.length) {
    log(`${p.u.name} 无格可撤，原地受 2 点损伤`, p.u.side);
    const here = pieceHex(p)?.id, by = pieces.get(attId);
    const dead = damage(p, 2) === 'dead';
    setPend(dead && by && (vac || here) ? { a: { id: by.id, hexes: [vac || here] } } : vac && by ? { a: { id: by.id, hexes: [vac] } } : {});
    return false;
  }
  setPend({ r: { id: p.id, n, att: attHexId, by: attId, vac } });
  select(p);
  return true;
}
function offerAdvance(att, hexId, blitz) { setPend({ a: { id: att.id, hexes: [hexId], blitz: blitz ? 1 : 0 } }); select(att); }
// 这个单位现在能去哪：后撤 / 推进 / 本阶段移动 / 自由摆放
function legalRange(p) {
  const pend = getPend(), u = p.u, E = new Set();
  if (u.kind === 'air') return { hexes: E, free: true, kind: 'free' };
  if (pend.r?.id === p.id) { const rt = mover.retreat(p, pend.r.att, moveCtx()); return { hexes: new Set(rt.hexes), zocOnly: rt.zocOnly, kind: 'retreat' }; }
  if (pend.a?.id === p.id) return { hexes: new Set(pend.a.hexes), kind: 'advance' };
  if (!strict()) return { ...mover.range(p, moveCtx()), free: true, kind: 'move' };
  if (st.turn === 1 && st.phase === 0) return { hexes: E, free: true, kind: 'free' };
  if ((st.phase === 2 && u.side === 'US') || (st.phase === 3 && u.side === 'GE')) return { ...mover.range(p, moveCtx()), kind: 'move' };
  return { hexes: E, kind: 'none', note: `现在不是${u.side === 'US' ? '美军' : '德军'}的行动阶段` };
}
// 落下：棋子和随行的标记/指挥部一起缓动到 (x,z)；commitRiders 为 false 时是退回原位
function dropTo(d, x, z, commitRiders) {
  const b = d.p.body, now = performance.now();
  b.type = CANNON.Body.KINEMATIC;
  const qOf = (q) => new THREE.Quaternion().setFromEuler(new THREE.Euler(q.kind === 'unit' && q.flip ? Math.PI : 0, 0, 0));
  tweens.set(d.p.id, { p: d.p, x0: b.position.x, z0: b.position.z, y0: b.position.y, x, z,
    q0: new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w), q1: qOf(d.p), flip: d.p.flip, t0: now, dur: 120 });
  (d.riders || []).forEach((r, i) => {
    if (commitRiders) movePiece(r, x, z, r.kind === 'unit' ? r.flip : false, { free: true });
    const rb = r.body;
    tweens.set(r.id, { p: r, x0: rb.position.x, z0: rb.position.z, y0: rb.position.y, x, z, q0: qOf(r), q1: qOf(r), flip: r.kind === 'unit' ? r.flip : false, t0: now, dur: 220 + i * 60 });
  });
}
// 堆叠规则：每格最多 1 个战斗单位，另外可以有任意数量的己方指挥部；指挥部必须和己方战斗单位同格
function stackProblem(p, h) {
  if (p.u.kind === 'air') return null;
  const combat = stackAt(h.X, h.Z).filter((q) => q.kind === 'unit' && q !== p && !['hq', 'air'].includes(q.u.kind));
  if (p.u.kind === 'hq') return combat.some((q) => q.u.side === p.u.side) ? null : '指挥部必须和一个己方战斗单位同格';
  if (combat.some((q) => q.u.side !== p.u.side)) return '不能进入敌方单位所在格';
  if (combat.length) return '每格最多 1 个战斗单位（另外可以有任意数量的己方指挥部）；移动中可以穿过友军格，但不能停在那里';
  return null;
}

// ------------------------------------------------------------------ 移动范围（举起算子时显示外轮廓）
const mover = initMove({ D, HEX, RIVER, BRIDGE, hexDist });
let rangeMesh = null;
function markerOnHex(hid, type) {
  const h = HEX.get(hid);
  return !!h && [...pieces.values()].some((q) => q.kind === 'marker' && q.type === type && Math.hypot(q.tx - h.X, q.tz - h.Z) < 0.55);
}
function moveCtx() {
  const units = [];
  for (const q of pieces.values()) if (q.kind === 'unit' && q.u.kind !== 'air') { const h = nearestHex(q.tx, q.tz); if (h) units.push({ p: q, hex: h }); }
  return { units, hexOf: (q) => nearestHex(q.tx, q.tz), inTray: (q) => trayAt(q.tx, q.tz), mark: markerOnHex,
    turn: st.turn, phase: st.phase, fuel: st.fuel, disguised: !st.g150 && st.turn <= 2,
    attacked: (q) => strict() && rules.attacked(q), cur: (q) => nearestHex(q.body.position.x, q.body.position.z) && nearestHex(q.tx, q.tz) };
}
function outlineMesh(ids, color, y = 0.075) {
  const pos = [];
  for (const [X, Z, a0, a1, R] of mover.outline(ids)) {
    const o = R * 0.975, i = R * 0.85;
    const P = (rad, a) => [X + rad * Math.cos(a), y, Z + rad * Math.sin(a)];
    const A = P(o, a0), B = P(o, a1), C = P(i, a1), E = P(i, a0);
    pos.push(...A, ...B, ...C, ...A, ...C, ...E);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
  m.renderOrder = 2; scene.add(m);
  return m;
}
const dropMesh = (m) => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); };
function drawRange(r) {
  hideRange();
  if (!r.hexes.size) { if (r.note) toast(r.note); return; }
  rangeMesh = outlineMesh(r.hexes, '#38c9dc');
  toast('可移动范围 · ' + r.note);
}
function hideRange() { if (rangeMesh) { dropMesh(rangeMesh); rangeMesh = null; } }
// 常驻覆盖层：待后撤（橙）、可推进（绿）、选中算子的可攻击目标（红圈）
let overlays = [];
function refreshOverlays() {
  overlays.forEach(dropMesh); overlays = [];
  const pend = getPend();
  const rp = pend.r && pieces.get(pend.r.id);
  if (rp && pieceHex(rp)) { const rt = mover.retreat(rp, pend.r.att, moveCtx()); if (rt.hexes.length) overlays.push(outlineMesh(new Set(rt.hexes), '#f08a3c', 0.08)); }
  if (pend.a && pieces.get(pend.a.id)) overlays.push(outlineMesh(new Set(pend.a.hexes), '#8fd16a', 0.08));
  if (selected?.kind === 'unit') for (const id of targetsOf(selected).ids) {
    const q = pieces.get(id);
    const m = new THREE.Mesh(new THREE.RingGeometry(1.12, 1.3, 40), new THREE.MeshBasicMaterial({ color: '#e5483a', transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(q.tx, 0.085, q.tz); m.renderOrder = 3; scene.add(m); overlays.push(m);
  }
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select') || !selected) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') select(null);
  if (selected.kind !== 'unit') return;
  if (strict() || selected.u.kind === 'air') return;
  if (k === 'f') flipPiece(selected);
  if (k === 'x') eliminate(selected);
});
const hoverHex = new THREE.Mesh(new THREE.RingGeometry(HEXR / 10 * 0.82, HEXR / 10 * 0.98, 6), new THREE.MeshBasicMaterial({ color: '#f3e3a0', transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
hoverHex.rotation.x = -Math.PI / 2; hoverHex.visible = false; scene.add(hoverHex);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.screenSpacePanning = false;
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.minDistance = 12; controls.maxDistance = 170; controls.maxPolarAngle = Math.PI * 0.44;
controls.update();
function homeView() { camera.position.copy(HOME.pos); controls.target.copy(HOME.target); controls.update(); }

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ------------------------------------------------------------------ 联机：实时房间（光标、拖动、骰子）
let gameRoom = null, userCap = null, myId = null;
let presenceState = { side: mySide };
function presence(patch) { Object.assign(presenceState, patch); if (gameRoom) gameRoom.presence(patch).catch(() => {}); }
const peerMarks = new Map();
const remoteHeld = new Map();     // 远端正在拖动的棋子
function peerColor(side) { return side === 'US' ? '#9aa36b' : side === 'GE' ? '#d24a3f' : '#d8d2bc'; }
async function renderPeers(list) {
  const box = $('#peers'); box.replaceChildren();
  const ids = list.map((p) => p.by).filter(Boolean);
  let prof = {};
  try { if (userCap && ids.length) prof = await userCap.profiles(ids); } catch {}
  for (const p of list) {
    const c = document.createElement('span'); c.className = 'chip';
    const dot = document.createElement('i'); dot.className = 'dot'; dot.style.background = peerColor(p.presence?.side);
    c.append(dot, document.createTextNode(`${(p.by && prof[p.by]?.name) || (p.isMe ? '你' : '对手')}${p.isMe ? '（你）' : ''} · ${sideName[p.presence?.side] || '观战'}`));
    box.append(c);
  }
}
function onPeerFrame(peers) {
  const seen = new Set();
  for (const pr of peers) {
    if (pr.sameTab) continue;
    seen.add(pr.peer);
    let m = peerMarks.get(pr.peer);
    if (!m) {
      m = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.8, 24), new THREE.MeshBasicMaterial({ color: peerColor(pr.presence?.side), transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; scene.add(m); peerMarks.set(pr.peer, m);
    }
    m.material.color.set(peerColor(pr.presence?.side));
    const cur = pr.presence?.cur;
    m.visible = Array.isArray(cur);
    if (m.visible) m.position.set(+cur[0] || 0, 0.08, +cur[1] || 0);
    const dg = pr.presence?.drag, held = [...remoteHeld].find(([, v]) => v === pr.peer)?.[0];
    if (dg && pieces.get(dg.id) && drag?.p?.id !== dg.id) {
      const p = pieces.get(dg.id);
      remoteHeld.set(dg.id, pr.peer);
      p.body.type = CANNON.Body.KINEMATIC; p.body.collisionResponse = false;
      p.body.position.set(+dg.x || 0, 1.6, +dg.z || 0);
      p.body.quaternion.copy(dg.f ? QFLIP : QUP);
    } else if (held) {
      remoteHeld.delete(held);
      const p = pieces.get(held), s = st.units[held] || st.markers[held];
      if (p && s) animateTo(p, s.x, s.z, p.kind === 'unit' ? !!s.f : false, 200);
    }
  }
  for (const [k, m] of peerMarks) if (!seen.has(k)) { scene.remove(m); peerMarks.delete(k); }
}
function emit(topic, data) { if (gameRoom) gameRoom.emit(topic, data).catch(() => {}); }

// ------------------------------------------------------------------ 规则模块
const rules = initRules({
  D, HEX, UNIT, RIVER, BRIDGE, OBJ, TRAYS, TERRAIN, st, pieces, hexDist, nearestHex, trayAt, pieceHex,
  commit, log, damage, eliminate, placeMarker, flipPiece, select, selectedUnit: () => (selected?.kind === 'unit' ? selected : null),
  markersAt: (hid, type) => { const h = HEX.get(hid); return h ? [...pieces.values()].filter((q) => q.kind === 'marker' && q.type === type && Math.hypot(q.tx - h.X, q.tz - h.Z) < 0.55) : []; },
  setMarkerE: (m, e) => { m.e = e; commit({ markers: { [m.id]: { t: m.type, x: +m.tx.toFixed(2), z: +m.tz.toFixed(2), e } } }); },
  removeMarker, heal, strict, pieceImg, getPend, setPend, startRetreat, offerAdvance,
  inEnemyZoc: (p) => { const h = pieceHex(p); return !!h && mover.zones(p.u.side, moveCtx()).zoc.has(h.id); },
  movedThisPhase: (p) => st.mv?.[p.id] === st.turn * 6 + st.phase,
  supplyCheck: () => mover.supply(moveCtx()),
  onRefresh: () => { if (selected && !pieces.has(selected.id)) selected = null; renderSel(); refreshOverlays(); },
  rollDice: async (styles, label) => {
    styles = styles.map((s, i) => (s === 'free' ? ['att', 'def'][i % 2] : s));
    const params = throwParams(styles.length);
    emit('dice', { styles, params, label });
    const faces = await rollDice(styles, params);
    if (faces) emit('dice', { styles, faces, label, done: true });
    return faces;
  },
  toast,
  side: () => mySide,
});
initBook((t) => toast(t));
function toast(t) { const el = $('#toast'); el.textContent = t; el.style.opacity = 1; clearTimeout(toast.h); toast.h = setTimeout(() => (el.style.opacity = 0), 2200); }

// ------------------------------------------------------------------ 界面接线
document.querySelectorAll('#sideSel button').forEach((b) => {
  b.setAttribute('aria-pressed', String(b.dataset.side === mySide));
  b.onclick = () => {
    mySide = b.dataset.side;
    try { localStorage.setItem('sotb-side', mySide); } catch {}
    document.querySelectorAll('#sideSel button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    presence({ side: mySide });
    renderPeers(gameRoom?.peers?.() || []);
  };
});
$('#setupBtn').onclick = () => { resetGame(); log('按剧本 1 布置全部单位'); toast('已按剧本布置'); openPop(null); };
$('#viewBtn').onclick = homeView;
$('#resetBtn').onclick = () => { $('#resetRow').hidden = true; $('#resetConfirm').hidden = false; };
$('#resetNo').onclick = () => { $('#resetRow').hidden = false; $('#resetConfirm').hidden = true; };
$('#resetYes').onclick = () => { $('#resetRow').hidden = false; $('#resetConfirm').hidden = true; st.log = []; resetGame(); log('清空并重开对局'); };
$('#joinTable').onclick = () => {
  const v = $('#tableId').value.trim();
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(v)) { toast('对局代码只能用字母、数字、- 和 _'); return; }
  location.hash = v; location.reload();
};
for (const [k, m] of Object.entries(MARKERS)) {
  const b = document.createElement('button'); b.className = 'mk';
  const i = document.createElement('img'); i.src = markerTex(k).image.toDataURL('image/png'); i.alt = '';
  b.append(i, document.createTextNode(m.name));
  b.onclick = () => { const p = placeMarker(k, selected?.kind === 'unit' ? selected : null); toast(`已放置${m.name}标记`); if (!selected) select(p); };
  $('#markerBtns').append(b);
}
$('#roll1').onclick = async () => { const f = await rules.api.rollDice(['free']); if (f) { log(`掷骰：${f[0]}`); toast(`掷出 ${f[0]}`); } };
async function rollOne(d) {
  const params = [throwInPlace(d)];
  emit('dice', { styles: [d.style], params, label: '单骰' });
  const f = await rollDice([d.style], params);
  if (!f) return;
  emit('dice', { styles: [d.style], faces: f, label: '单骰', done: true });
  log(`${DIE_NAME[d.style]}掷出 ${f[0]}`); toast(`${DIE_NAME[d.style]}：${f[0]}`);
}
$('#roll2').onclick = async () => { const f = await rules.api.rollDice(['free', 'free']); if (f) { log(`掷骰：${f.join(' + ')} = ${f[0] + f[1]}`); toast(`掷出 ${f.join(' + ')}`); } };
document.querySelectorAll('[data-collapse]').forEach((b) => b.onclick = () => {
  const d = $('#' + b.dataset.collapse); d.classList.toggle('collapsed');
  const c = d.classList.contains('collapsed'); b.textContent = c ? '▴' : '▾'; b.setAttribute('aria-expanded', String(!c));
});
// 左缘工具列：弹出面板一次只开一个
const popBtns = [...document.querySelectorAll('.rail [data-pop]')];
function openPop(name) {
  for (const b of popBtns) { const on = b.dataset.pop === name; b.setAttribute('aria-expanded', String(on)); $('#pop-' + b.dataset.pop).hidden = !on; }
}
popBtns.forEach((b) => b.onclick = () => openPop(b.getAttribute('aria-expanded') === 'true' ? null : b.dataset.pop));
renderer.domElement.addEventListener('pointerdown', () => openPop(null));
function syncRuleBtn() { const b = $('#ruleBtn'); b.setAttribute('aria-pressed', String(strictOn)); b.dataset.tip = '规则约束：' + (strictOn ? '开' : '关（自由摆放）'); }
$('#ruleBtn').onclick = () => {
  strictOn = !strictOn; try { localStorage.setItem('sotb-strict', strictOn ? '1' : '0'); } catch {}
  syncRuleBtn(); toast(strictOn ? '规则约束已打开' : '规则约束已关闭：可以自由摆放'); rules.refresh();
};
syncRuleBtn();
$('#staffBtn').onclick = () => $('#right').classList.toggle('mclosed');
if (innerWidth <= 820) $('#right').classList.add('mclosed');

// ------------------------------------------------------------------ 主循环
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  runTweens(now);
  world.step(1 / 120, dt, 8);
  for (const p of pieces.values()) {
    if (!tweens.has(p.id) && drag?.p !== p && !(drag?.riders || []).includes(p) && !remoteHeld.has(p.id)) {
      const b = p.body; b.position.y += (p.ty - b.position.y) * Math.min(1, dt * 14);
    }
    p.mesh.position.copy(p.body.position); p.mesh.quaternion.copy(p.body.quaternion);
  }
  for (const d of dice) { d.mesh.position.copy(d.body.position); d.mesh.quaternion.copy(d.body.quaternion); }
  if (selected) { selRing.visible = true; selRing.position.set(selected.body.position.x, 0.07, selected.body.position.z); }
  if (gameRoom?.peers) onPeerFrame(gameRoom.peers());
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ 启动
{
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch {}
  const init = saved && saved.units ? saved : scenarioState();
  merge(st, init);
  applyState(st, true);
  renderLog(); rules.refresh();
}
$('#loading').hidden = true;
requestAnimationFrame(frame);
setSync('warn', '本地模式（未联机）');

(async () => {
  const claude = window.claude;
  if (!claude?.use) return;
  const [dbCap, roomCap, uCap] = await Promise.all([claude.use('db'), claude.use('room'), claude.use('user')]);
  userCap = uCap;
  try { myId = uCap ? await uCap.id() : null; } catch {}
  let canWrite = null;
  try { canWrite = uCap?.can ? await uCap.can('data.write') : null; } catch {}
  readOnly = canWrite === false;
  if (dbCap) {
    db = dbCap;
    docRef = db.doc('games/' + tableId);
    setSync('warn', '正在读取对局 ' + tableId + '…');
    const timer = setTimeout(() => { if (!gotFirst) setSync('warn', '暂时连不上对局数据，先在本地摆放'); }, 10000);
    unsub = docRef.onSnapshot((snap) => {
      if (!snap.metadata.fromCache) clearTimeout(timer);
      const first = !gotFirst; gotFirst = true;
      if (!snap.exists) { docExists = false; if (first) setSync('ok', readOnly ? '观战中 · 对局 ' + tableId + ' 还没开始' : '新对局 ' + tableId + ' · 第一次移动后开始同步'); return; }
      docExists = true;
      const data = snap.data();
      if (snap.metadata.hasPendingWrites) return;
      for (const k of ['turn', 'phase', 'weather', ...EXTRA_KEYS]) if (data[k] !== undefined) st[k] = structuredClone(data[k]);
      st.ctrl = { ...st.ctrl, ...(data.ctrl || {}) };
      st.log = Array.isArray(data.log) ? data.log : st.log;
      st.units = structuredClone(data.units || {});
      st.markers = Object.fromEntries(Object.entries(data.markers || {}).filter(([, v]) => v));
      applyState(data, first);
      renderLog(); rules.refresh();
      setSync('ok', (readOnly ? '观战中 · 对局 ' : '已同步 · 对局 ') + tableId);
    }, (err) => setSync('warn', '对局数据连接中断（' + (err?.code || '未知') + '）'));
  }
  if (roomCap) {
    gameRoom = await roomCap.join('sotb-' + tableId);
    presence({ side: mySide, me: myId });
    gameRoom.onPeers((ch) => renderPeers(ch.peers));
    gameRoom.on('dice', async (msg) => {
      if (msg.sameTab) return;
      const d = msg.data || {};
      const styles = Array.isArray(d.styles) ? d.styles.filter((s) => DIE_STYLE[s]).slice(0, 2) : [];
      if (!styles.length) return;
      if (d.params && !d.done) { rollDice(styles, d.params.slice(0, styles.length)); }
      else if (d.done && Array.isArray(d.faces)) {
        styles.forEach((st2, i) => { const f = +d.faces[i]; if (f >= 1 && f <= 6) showFace(dieOf(st2, i), f); });
        toast(`对手掷出 ${d.faces.join(' + ')}${d.label ? '（' + String(d.label).slice(0, 30) + '）' : ''}`);
      }
    });
  }
})();
