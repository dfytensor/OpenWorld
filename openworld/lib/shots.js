// openworld 分镜解析器：自然语言分镜脚本 → 可执行任务规格
'use strict';
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');

// 机位关键词 → 类型
const SHOT_KEYWORDS = [
  [/远景|全景|establish|wide/i, 'establish'],
  [/正门|大门|门口|gate/i, 'gate'],
  [/环绕|旋转|360|orbit/i, 'orbit'],
  [/螺旋|盘旋|helix|spiral/i, 'helix'],
  [/推近|推进|push/i, 'dolly'],
  [/拉远|后退|pullout|pull/i, 'pullout'],
  [/横移|侧面滑过|truck|lateral/i, 'truck'],
  [/摇臂|升降|上升|crane|rise/i, 'crane'],
  [/跟拍|跟随|follow/i, 'follow'],
  [/俯瞰|俯视|上帝|鸟瞰|high|aerial/i, 'high'],
  [/街道|街景|street/i, 'street'],
  [/庭院|花园|garden/i, 'garden'],
  [/塔|tower/i, 'tower'],
  [/特写|closeup|close/i, 'closeup'],
];

// 蓝图关键词 → 蓝图 id
const BP_KEYWORDS = [
  [/城堡|castle/i, 'castle'],
  [/房屋?|小屋|house|home/i, 'house'],
  [/望塔|塔楼|哨塔|tower/i, 'tower'],
  [/桥|bridge/i, 'bridge'],
  [/树|tree|森林|树林/i, 'tree'],
];

const SCENE_DIR = path.join(ASSETS, 'scenes');
function listScenes() {
  try { return fs.readdirSync(SCENE_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(SCENE_DIR, f), 'utf8'))); }
  catch (e) { return []; }
}

/**
 * 解析分镜脚本。
 * 语法（每行一条，# 开头为注释）：
 *   场景 中世纪村庄            → 引用素材库场景
 *   建造 城堡@65,90 房屋@76,88  → 行内建造（坐标可省略→自动找陆地相对摆放）
 *   分镜:                      → 以下每行一个分镜
 *     远景 / 正门 / 环绕 8秒 / 推近 5秒 / 俯瞰 / 街道 / 庭院 / 塔 / 特写
 */
function parseScript(text) {
  const spec = { name: '未命名', sceneRef: null, build: [], shots: [] };
  const lines = text.split(/\r?\n/);
  let inShots = false;
  let autoOrigin = null; // 无坐标时相对摆放基准

  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // 场景引用
    let m = line.match(/^场景\s+(.+)$/);
    if (m) {
      const scenes = listScenes();
      const sc = scenes.find(s => s.name === m[1].trim() || s.id === m[1].trim());
      if (!sc) throw new Error('素材库中没有场景: ' + m[1]);
      spec.sceneRef = sc.id;
      spec.build.push(...sc.build);
      if (!inShots && sc.shots && !spec.shots.length) spec.shots = sc.shots.map(s => ({ ...s }));
      continue;
    }

    // 建造行
    m = line.match(/^(建造|build)\s+(.+)$/i);
    if (m) {
      const items = m[2].split(/\s+/);
      for (const it of items) {
        const bm = it.match(/(.+?)(?:@([\d-]+),([\d-]+))?$/);
        if (!bm) continue;
        const bp = matchBp(bm[1]);
        if (!bp) throw new Error('未知建筑: ' + bm[1] + '（可用: 城堡/房屋/望塔/桥/树）');
        let at;
        if (bm[2] !== undefined && bm[3] !== undefined) {
          at = [+bm[2], +bm[3]];
        } else {
          if (!autoOrigin) autoOrigin = [65, 90]; // parse 阶段先记占位，执行期再自动找
          at = null; // 标记自动
        }
        spec.build.push({ bp, at });
      }
      continue;
    }

    if (/^分镜[:：]?$/.test(line) || /^shots?:?$/i.test(line)) { inShots = true; continue; }

    if (inShots) {
      const shot = parseShotLine(line, spec.shots.length + 1);
      if (shot) spec.shots.push(shot);
    } else if (/^(名称|name)[:：]/i.test(line)) {
      spec.name = line.split(/[:：]/).slice(1).join(':').trim();
    } else {
      // 不在分镜区的行：尝试当作分镜解析（宽松模式）
      const shot = parseShotLine(line, spec.shots.length + 1);
      if (shot) spec.shots.push(shot);
    }
  }

  if (!spec.shots.length) spec.shots = defaultShots();
  return spec;
}

function matchBp(word) {
  for (const [re, id] of BP_KEYWORDS) if (re.test(word)) return id;
  return null;
}

function parseShotLine(line, idx) {
  const durM = line.match(/(\d+(?:\.\d+)?)\s*秒/);
  const duration = durM ? +durM[1] : null;
  for (const [re, type] of SHOT_KEYWORDS) {
    if (re.test(line)) {
      return { id: String(idx).padStart(2, '0') + '-' + type, type, duration };
    }
  }
  return null;
}

function defaultShots() {
  return [
    { id: '01-establish', type: 'establish' },
    { id: '02-gate', type: 'gate' },
    { id: '03-orbit', type: 'orbit', duration: 8 },
    { id: '04-high', type: 'high' },
  ];
}

/**
 * 把抽象分镜 + 场景中心 → 具体机位参数
 * center: [cx, cy, cz]（cy 为地面最高点+3）
 */
function resolveShots(spec, center) {
  const [cx, cy, cz] = center;
  return spec.shots.map(s => {
    switch (s.type) {
      case 'establish': return { ...s, kind: 'still', pos: [cx + 18, cy + 17, cz + 18], target: [cx, cy, cz], land: false };
      case 'gate': return { ...s, kind: 'still', pos: [cx + 0.5, cy + 3, cz + 20], target: [cx, cy, cz - 2], land: false };
      case 'tower': return { ...s, kind: 'still', pos: [cx + 14, cy + 5, cz + 14], target: [cx + 6, cy + 6, cz - 6], land: false };
      case 'street': return { ...s, kind: 'still', pos: [cx + 15, cy + 9, cz + 17], target: [cx - 3, cy - 1, cz - 3], land: false };
      case 'garden': return { ...s, kind: 'still', pos: [cx + 9, cy + 3, cz + 10], target: [cx - 2, cy, cz - 2], land: false };
      case 'closeup': return { ...s, kind: 'still', pos: [cx + 7, cy + 2, cz + 7], target: [cx, cy, cz], land: false };
      case 'high': return { ...s, kind: 'still', pos: [cx + 4, cy + 19, cz + 16], target: [cx, cy - 3, cz], land: false };
      case 'orbit': return { ...s, kind: 'orbit', center, duration: s.duration || 8, r0: 20, r1: 14, h0: 6, h1: 3 };
      case 'helix': return { ...s, kind: 'orbit', center, duration: s.duration || 9, r0: 16, r1: 16, h0: 1, h1: 15 };   // 螺旋上升环绕
      case 'dolly': return {
        ...s, kind: 'dolly', center, duration: s.duration || 5,
        from: [cx + 20, cy + 9, cz + 20], to: [cx + 8, cy + 3, cz + 8]
      };
      case 'pullout': return { ...s, kind: 'dolly', center, duration: s.duration || 5, from: [cx + 7, cy + 3, cz + 7], to: [cx + 22, cy + 10, cz + 22] };  // 拉远揭示
      case 'truck': return { ...s, kind: 'dolly', center, duration: s.duration || 6, from: [cx - 18, cy + 5, cz + 10], to: [cx + 18, cy + 5, cz + 10] };   // 侧面横移
      case 'crane': return { ...s, kind: 'dolly', center, duration: s.duration || 6, from: [cx + 12, cy + 1, cz + 12], to: [cx + 12, cy + 16, cz + 12] };  // 垂直摇臂上升
      case 'follow': return { ...s, kind: 'follow', center, duration: s.duration || 8, from: [cx - 10, cz + 18], to: [cx + 2, cz + 4] };  // 穿村跟拍
      default: return { ...s, kind: 'still', pos: [cx + 26, cy + 5, cz + 26], target: [cx, cy, cz], land: false };
    }
  });
}

module.exports = { parseScript, resolveShots, listScenes, matchBp };
