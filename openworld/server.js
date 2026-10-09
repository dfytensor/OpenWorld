// openworld 服务器：控制台 UI + 渲染管线 + 素材库 API（零依赖）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./lib/engine');
const { parseScript, resolveShots, listScenes } = require('./lib/shots');

const ROOT = __dirname;
const PORT = 8500;
const OUT = path.join(ROOT, 'output');
const ASSETS = path.join(ROOT, 'assets');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.webm': 'video/webm', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

fs.mkdirSync(OUT, { recursive: true });
for (const d of ['blueprints', 'scenes', 'shots']) fs.mkdirSync(path.join(ASSETS, d), { recursive: true });

// ============ 任务状态 ============
let job = null; // {id, name, status, log[], outputs[], startedAt, endedAt, progress}
function newJob(name) {
  job = { id: Date.now().toString(36), name, status: 'queued', log: [], outputs: [], progress: 0, startedAt: Date.now(), endedAt: null };
  return job;
}
function jlog(msg) { if (job) { job.log.push('[' + new Date().toLocaleTimeString() + '] ' + msg); console.log('[job] ' + msg); } }

// ============ 渲染管线 ============
async function runPipeline(scriptText) {
  const engine = new Engine(jlog);
  try {
    // 1. 解析脚本
    jlog('解析分镜脚本 ...');
    const spec = parseScript(scriptText);
    job.name = spec.name;
    jlog('脚本解析完成: ' + spec.build.length + ' 个建造项, ' + spec.shots.length + ' 个分镜');

    // 2. 启动环境
    await engine.ensureGameServer(ROOT);
    await engine.launch();
    job.status = 'running';
    await engine.waitReady();

    // 3. 建造（自动坐标：找陆地后相对展开）
    if (spec.build.length) {
      const needAuto = spec.build.filter(b => !b.at);
      let origin = null;
      if (needAuto.length) {
        const land = await engine.findLand();
        origin = land;
        let row = 0, col = 0;
        for (const b of needAuto) {
          b.at = [land[0] + col * 14, land[1] + row * 14];
          col++; if (col > 2) { col = 0; row++; }
        }
      }
      jlog('开始建造 ' + spec.build.length + ' 个建筑 ...');
      var built = await engine.buildScene(spec.build);
      job.center = built.center;
    } else {
      // 无建造：直接探测当前区域中心（用玩家出生点附近扫描）
      const c = await engine.eval(`(function(){
        var h=0, sx=0, sz=0, n=0;
        for(var x=-40;x<=40;x+=4) for(var z=-40;z<=40;z+=4)
          for(var y=40;y>=0;y--){ if(__game.world.registry.get(x,y,z)){ h+=y; n++; break; } }
        return JSON.stringify([0, Math.round(h/Math.max(n,1))+3, 0]);
      })()`);
      job.center = JSON.parse(c);
      jlog('无建造项，以出生点区域为中心');
    }

    // 4. 逐分镜执行
    const outDir = path.join(OUT, job.id);
    fs.mkdirSync(outDir, { recursive: true });
    const concrete = resolveShots(spec, job.center);
    job.progress = 0;
    for (const shot of concrete) {
      jlog('执行分镜 [' + shot.id + '] ' + shot.type + (shot.kind === 'still' ? '' : ' ' + (shot.duration || 8) + 's'));
      let file;
      if (shot.kind === 'still') file = await engine.shootStill(shot, outDir);
      else if (shot.kind === 'orbit') file = await engine.recordOrbit(shot, outDir);
      else if (shot.kind === 'dolly') file = await engine.recordDolly(shot, outDir);
      else if (shot.kind === 'follow') file = await engine.recordFollow(shot, outDir);
      const base = path.basename(file);
      job.outputs.push({
        shot: shot.id, type: shot.type,
        url: '/output/' + job.id + '/' + base,
        file, kind: shot.kind,
        video: shot.kind !== 'still'
      });
      job.progress = Math.round(job.outputs.length / concrete.length * 100);
    }

    // 5. 存场景入素材库（若本次有建造且没有引用现成场景）
    if (spec.build.length && !spec.sceneRef) {
      try {
        const sceneName = job.name !== '未命名' ? job.name : 'scene-' + job.id;
        const sceneId = 'scene-' + job.id;
        fs.writeFileSync(path.join(ASSETS, 'scenes', sceneId + '.json'), JSON.stringify({
          id: sceneId, name: sceneName, build: spec.build,
          center: job.center,
          shots: spec.shots.map(s => ({ id: s.id, type: s.type, duration: s.duration })),
          createdAt: new Date().toISOString()
        }, null, 2));
        jlog('场景已存入素材库: ' + sceneName);
      } catch (e) { jlog('场景入库失败: ' + e.message); }
    }

    job.status = 'done';
    jlog('✅ 全部完成: ' + job.outputs.length + ' 个分镜产出');
  } catch (e) {
    job.status = 'error';
    jlog('❌ 失败: ' + e.message);
  } finally {
    await engine.close();
    job.endedAt = Date.now();
  }
}

// ============ 素材库 ============
function assetJson(dir) {
  try { return fs.readdirSync(path.join(ASSETS, dir)).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(ASSETS, dir, f), 'utf8'))); }
  catch (e) { return []; }
}
function seedAssets() {
  const bps = [
    { id: 'castle', name: '城堡', kw: ['城堡'], size: '7×16×7', desc: '平台+木墙+四角铜顶塔+庭院花园' },
    { id: 'house', name: '房屋', kw: ['房屋', '小屋'], size: '5×6×5', desc: '人字红瓦顶+玻璃窗+门口火把' },
    { id: 'tower', name: '望塔', kw: ['塔楼', '哨塔'], size: '3×12×3', desc: '石身瞭望塔+铜顶+塔尖火把' },
    { id: 'bridge', name: '石桥', kw: ['桥'], size: '任意长', desc: '拱形桥面+木栏杆+支撑柱' },
    { id: 'tree', name: '树', kw: ['树'], size: '5×8×5', desc: '随机高度树木' }
  ];
  for (const b of bps) {
    const f = path.join(ASSETS, 'blueprints', b.id + '.json');
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(b, null, 2));
  }
  const presetShots = path.join(ASSETS, 'shots', 'standard.json');
  if (!fs.existsSync(presetShots)) fs.writeFileSync(presetShots, JSON.stringify({
    id: 'standard', name: '标准六机位', shots: ['远景', '正门', '环绕 8秒', '俯瞰', '街道', '庭院'], desc: '全能套餐：适合任何建筑群'
  }, null, 2));
}

// ============ HTTP ============
function body(req) {
  return new Promise((res, rej) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => res(b)); req.on('error', rej);
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  try {
    if (req.method === 'POST' && u === '/api/render') {
      if (job && (job.status === 'running' || job.status === 'queued')) return json(res, 409, { error: '有任务进行中' });
      const text = await body(req);
      newJob('未命名');
      runPipeline(text).catch(e => console.error(e));
      return json(res, 200, { ok: true, jobId: job.id });
    }
    if (u === '/api/status') return json(res, 200, job || { status: 'idle' });
    if (u === '/api/assets') {
      return json(res, 200, {
        blueprints: assetJson('blueprints'),
        scenes: listScenes(),
        shotPresets: assetJson('shots')
      });
    }
    if (req.method === 'POST' && u === '/api/assets/scenes') {
      const sc = JSON.parse(await body(req));
      if (!sc.id || !sc.build) return json(res, 400, { error: '需要 id 和 build' });
      fs.writeFileSync(path.join(ASSETS, 'scenes', sc.id + '.json'), JSON.stringify(sc, null, 2));
      return json(res, 200, { ok: true });
    }
    // 静态文件
    let p = u === '/' ? '/index.html' : u;
    const file = path.join(ROOT, decodeURIComponent(p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

seedAssets();
server.listen(PORT, () => {
  console.log('openworld 运行中 → http://127.0.0.1:' + PORT);
});
