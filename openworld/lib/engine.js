// openworld 引擎：CDP 控制体素世界 —— 建造 + 分镜拍摄 + 视频录制
// 沉淀自 voxel-ai-filmmaker skill 的全部实战经验
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const GAME_URL = 'http://127.0.0.1:8200/index.html';
const CHROME = process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_X86 = process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe';

function httpJson(port, p, m) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: m || 'GET' }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Engine {
  constructor(log) {
    this.log = log || (() => {});
    this.chrome = null;
    this.port = 0;
  }

  // 确保游戏 HTTP 服务器在 8200 运行
  async ensureGameServer(root) {
    const alive = await new Promise(res => {
      const req = http.request({ host: '127.0.0.1', port: 8200, path: '/index.html', method: 'GET' }, r => { r.resume(); res(r.statusCode === 200); });
      req.on('error', () => res(false)); req.end();
    });
    if (alive) return 'already';
    const gameRoot = path.join(root, '..', 'voxel-projects', 'minecraft-web');
    const srv = spawn('node', ['-e', `
      const http=require('http'),fs=require('fs'),path=require('path');
      const root=${JSON.stringify(gameRoot)};
      http.createServer((q,s)=>{
        try{
          let p=q.url.split('?')[0]; if(p==='/')p='/index.html';
          const f=path.join(root,p);
          const ext=path.extname(p);
          const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.json':'application/json'}[ext]||'application/octet-stream';
          s.setHeader('Content-Type',mime);
          s.end(fs.readFileSync(f));
        }catch(e){ s.statusCode=404; s.end('nf'); }
      }).listen(8200);
    `], { stdio: 'ignore', windowsHide: true });
    srv.unref();
    for (let i = 0; i < 20; i++) {
      const up = await new Promise(res => {
        const req = http.request({ host: '127.0.0.1', port: 8200, path: '/index.html', method: 'GET' }, r => { r.resume(); res(r.statusCode === 200); });
        req.on('error', () => res(false)); req.end();
      });
      if (up) { this.log('游戏服务器已启动 (:8200)'); return 'started'; }
      await sleep(500);
    }
    throw new Error('游戏服务器启动失败');
  }

  // 启动 headless Chrome 并连上游戏页
  async launch() {
    this.port = 9500 + Math.floor(Math.random() * 400);
    const exe = fs.existsSync(CHROME) ? CHROME : CHROME_X86;
    if (!fs.existsSync(exe)) throw new Error('找不到 Chrome');
    this.prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-'));
    this.chrome = spawn(exe, [
      '--headless=new', '--no-first-run', '--no-sandbox',
      '--enable-webgl', '--use-gl=angle', '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=IntensiveWakeUpThrottling,PageVisibility',
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.prof}`,
      '--window-size=1280,720', 'about:blank'
    ], { stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { await httpJson(this.port, '/json/version'); up = true; } catch (e) { await sleep(500); } }
    if (!up) throw new Error('Chrome 启动失败');
    const tab = await httpJson(this.port, '/json/new?' + encodeURI(GAME_URL), 'PUT').catch(() => httpJson(this.port, '/json/new?' + encodeURI(GAME_URL)));
    this.ws = new WebSocket(tab.webSocketDebuggerUrl);
    this._id = 0; this._pending = new Map();
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this._pending.has(m.id)) { this._pending.get(m.id)(m); this._pending.delete(m.id); }
    };
    await new Promise(r => { this.ws.onopen = r; });
    await this.send('Page.enable');
    this.log('浏览器已连接 (port ' + this.port + ')');
  }

  send(method, params) {
    return new Promise(res => { const i = ++this._id; this._pending.set(i, res); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }

  // 页面内执行。awaitPromise=true 时等待 Promise
  async eval(expr, ap) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!ap });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error('页面执行错误: ' + ((d.exception && d.exception.description) || d.text).slice(0, 300));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  // 等待游戏世界就绪（★ 布尔判断，绝不能用 typeof 字符串 truthy）
  async waitReady(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const ok = await this.eval('typeof __game !== "undefined" && typeof Blueprints !== "undefined" && __game.world && !!__game.world.registry').catch(() => false);
      if (ok) { this.log('游戏世界就绪'); return; }
      if (Date.now() - t0 > (timeoutMs || 120000)) throw new Error('等待游戏世界超时');
      await sleep(1000);
    }
  }

  async screenshot(filePath) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!(r.result && r.result.data)) throw new Error('截图失败');
    fs.writeFileSync(filePath, Buffer.from(r.result.data, 'base64'));
    return filePath;
  }

  // 把玩家传送到 (px,py,pz) 看向 (tx,ty,tz)。
  // land=true 时等落地后再瞄准（地面机位）；false 立即瞄准（高空/飞行机位）
  async aim(px, py, pz, tx, ty, tz, land) {
    await this.eval(`(function(){
      var p = __game.player;
      p.position.set(${+px}, ${+py}, ${+pz});
      p.velocity.set(0,0,0); p.yaw = 0; p.pitch = -1.5;
      return 1;
    })()`);
    if (land) {
      for (let i = 0; i < 20; i++) {
        if (await this.eval('__game.player.isOnGround')) break;
        await sleep(300);
      }
    }
    await this.eval(`(function(){
      var p = __game.player, eye = 1.8;
      var dx=${+tx}-p.position.x, dy=${+ty}-(p.position.y+eye), dz=${+tz}-p.position.z;
      p.yaw = Math.atan2(-dx,-dz);
      p.pitch = Math.atan2(dy, Math.sqrt(dx*dx+dz*dz));
      return 1;
    })()`);
    await sleep(900); // 等渲染 + 区块网格
  }

  // 找一片陆地（5×5 无水无低洼沙滩）。候选点由近及远
  async findLand(cands) {
    const list = cands || [[65, 90], [75, 90], [65, 100], [55, 90], [65, 80], [75, 100], [80, 85], [50, 95], [85, 95], [70, 110], [90, 100], [100, 90], [110, 95], [95, 110]];
    const s = await this.eval(`(function(){
      var w = __game.world;
      function g(x,z){ for(var y=40;y>=0;y--){ var b=w.registry.get(x,y,z); if(b) return {y:y,t:b.type}; } return null; }
      function ok(cx,cz){ for(var dx=0;dx<5;dx++) for(var dz=0;dz<5;dz++){ var c=g(cx+dx,cz+dz); if(!c||c.t==='water'||(c.y<3&&c.t==='sand')) return false; } return true; }
      var cands=${JSON.stringify(list)};
      for (var i=0;i<cands.length;i++) if(ok(cands[i][0],cands[i][1])) return JSON.stringify(cands[i]);
      return JSON.stringify(null);
    })()`);
    const found = JSON.parse(s);
    if (!found) throw new Error('候选区域都没有合适陆地，请提供更多坐标');
    this.log('选定陆地: (' + found[0] + ', ' + found[1] + ')');
    return found;
  }

    // 建造场景。placements: [{bp:'castle', at:[65,90]}, ...]
    // 返回 { center:[cx,cy,cz], blocks:n }
    async buildScene(placements) {
      // ★ 关键：registry 按 chunk 懒加载，必须先把玩家传到目标区域上空触发加载，否则全是 EMPTY
      const c0 = placements[0].at;
      await this.eval(`(function(){
        var p=__game.player;
        p.position.set(${c0[0]}, 28, ${c0[1]}); p.velocity.set(0,0,0);
        return 1;
      })()`);
      await sleep(4000); // 等区块生成
      const GROUND_SKIP = /^(leaves|spruce_leaves|birch_leaves|jungle_leaves|wood|log|slab_wood|stair_wood|roof|copper_roof|glass|torch|flower|cactus|water)$/;
      const r = await this.eval(`(function(){
        var g=__game.world, BP=Blueprints; BP._n=0;
        var GROUND={grass:1,dirt:1,stone:1,sand:1,bedrock:1,snow:1};
        var minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9,hMax=0;
      var items=${JSON.stringify(placements)};
      // 落点检测：每栋建筑落位前在 3×3 内找全自然地面的点，水上/悬崖自动微移
      function spotFree(x,z){
        for(var dx=-1;dx<=1;dx++) for(var dz=-1;dz<=1;dz++){
          var ok=false;
          for(var y=12;y>=0;y--){ var b=g.registry.get(x+dx,y,z+dz); if(b){ ok=GROUND[b.type]&&y>=1; break; } }
          if(!ok) return false;
        }
        return true;
      }
      function nudge(it){
        if(spotFree(it.at[0],it.at[1])) return;
        for(var r=1;r<=8;r++) for(var dx=-r;dx<=r;dx++) for(var dz=-r;dz<=r;dz++){
          if(Math.max(Math.abs(dx),Math.abs(dz))!==r) continue;
          if(spotFree(it.at[0]+dx,it.at[1]+dz)){ it.at=[it.at[0]+dx,it.at[1]+dz]; return; }
        }
      }
      items.forEach(function(it){
        var f=BP[it.bp]; if(!f) return;
        nudge(it);
        f.call(BP,g,it.at[0],it.at[1]);
        var ext=it.ext||6;
        minX=Math.min(minX,it.at[0]-ext); maxX=Math.max(maxX,it.at[0]+ext);
        minZ=Math.min(minZ,it.at[1]-ext); maxZ=Math.max(maxZ,it.at[1]+ext);
      });
        for(var x=minX;x<=maxX;x++) for(var z=minZ;z<=maxZ;z++)
          for(var y=40;y>=0;y--){
            var b=g.registry.get(x,y,z);
            if(b && GROUND[b.type]){ if(y>hMax)hMax=y; break; }
          }
        return JSON.stringify({blocks:BP._n, center:[(minX+maxX)/2, hMax+3, (minZ+maxZ)/2]});
      })()`, true);
      await sleep(3500); // 等区块网格重建
      const out = JSON.parse(r);
      this.log('建造完成: ' + placements.map(p => p.bp).join('+') + ' 共 ' + out.blocks + ' 块');
      return out;
    }

  // 拍摄单个静帧机位。shot: {id, pos:[x,y,z], target:[x,y,z], land:bool}
  async shootStill(shot, outDir) {
    const file = path.join(outDir, 'shot-' + shot.id + '.png');
    await this.aim(shot.pos[0], shot.pos[1], shot.pos[2], shot.target[0], shot.target[1], shot.target[2], shot.land !== false);
    await this.screenshot(file);
    this.log('分镜 [' + shot.id + '] 静帧完成');
    return file;
  }

  // 环绕飞行视频。opts: {id, center:[x,y,z], duration:s, r0, r1, h0, h1, fps}
  // 页面内 MediaRecorder 录游戏画布 → webm，无需 ffmpeg
  async recordOrbit(opts, outDir) {
    const file = path.join(outDir, 'shot-' + opts.id + '.webm');
    const [cx, cy, cz] = opts.center;
    const dur = (opts.duration || 8) * 1000;
    const r0 = opts.r0 || 20, r1 = opts.r1 || (r0 - 6);
    const h0 = cy + (opts.h0 != null ? opts.h0 : 6), h1 = cy + (opts.h1 != null ? opts.h1 : 3);
    this.log('录制 [' + opts.id + '] 环绕视频 ' + (dur / 1000) + 's ...');
    await this.eval(`(function(){
      return new Promise(function(resolve){
        var cv = document.querySelector('canvas');
        if (!cv || !cv.captureStream) { resolve('ERR:no stream'); return; }
        var mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
          .find(function(m){ return MediaRecorder.isTypeSupported(m); });
        var rec = new MediaRecorder(cv.captureStream(${opts.fps || 30}), mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : undefined);
        var chunks = [];
        rec.ondataavailable = function(e){ if (e.data.size) chunks.push(e.data); };
        rec.onstop = function(){
          var blob = new Blob(chunks, { type: 'video/webm' });
          var fr = new FileReader();
          fr.onload = function(){ window.__owVid = fr.result.split(',')[1]; window.__owVidSize = blob.size; resolve('ok ' + blob.size + ' ' + (mime||'')); };
          fr.readAsDataURL(blob);
        };
        var dur=${dur}, t0=null;
        var CX=${+cx}, CY=${+cy}, CZ=${+cz}, R0=${+r0}, R1=${+r1}, H0=${+h0}, H1=${+h1};
        function frame(ts){
          if(!t0) t0=ts;
          var t=Math.min((ts-t0)/dur,1);
          var ang=t*Math.PI*2, r=R0+(R1-R0)*t;
          var px=CX+Math.cos(ang)*r, pz=CZ+Math.sin(ang)*r, py=H0+(H1-H0)*t;
          var p=__game.player;
          p.position.set(px,py,pz); p.velocity.set(0,0,0);
          var dx=CX-px, dy=CY-py, dz=CZ-pz;
          p.yaw=Math.atan2(-dx,-dz);
          p.pitch=Math.atan2(dy,Math.sqrt(dx*dx+dz*dz))*0.6;
          if(t<1) requestAnimationFrame(frame);
          else setTimeout(function(){ rec.stop(); },300);
        }
        rec.start();
        requestAnimationFrame(frame);
      });
    })()`, true);
    // 等 base64 就绪 + 分块取回
    let size = 0;
    for (let i = 0; i < 20; i++) { size = (await this.eval('window.__owVidSize || 0')) || 0; if (size) break; await sleep(500); }
    if (!size) throw new Error('视频录制失败（无数据）');
    const b64len = await this.eval('window.__owVid.length');
    let buf = Buffer.alloc(0);
    const CH = 800000;
    for (let off = 0; off < b64len; off += CH) {
      const part = await this.eval(`window.__owVid.substr(${off}, ${CH})`);
      buf = Buffer.concat([buf, Buffer.from(part, 'base64')]);
    }
    await this.eval('window.__owVid = null; window.__owVidSize = 0');
    fs.writeFileSync(file, buf);
    this.log('分镜 [' + opts.id + '] 视频完成 (' + (buf.length / 1024).toFixed(0) + ' KB)');
    return file;
  }

  // 推近/拉远视频（直线运镜）。opts: {id, center, from:[x,y,z], to:[x,y,z], duration}
  async recordDolly(opts, outDir) {
    const file = path.join(outDir, 'shot-' + opts.id + '.webm');
    const [cx, cy, cz] = opts.center;
    const dur = (opts.duration || 5) * 1000;
    this.log('录制 [' + opts.id + '] 直线运镜 ' + (dur / 1000) + 's ...');
    await this.eval(`(function(){
      return new Promise(function(resolve){
        var cv = document.querySelector('canvas');
        if (!cv || !cv.captureStream) { resolve('ERR:no stream'); return; }
        var mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
          .find(function(m){ return MediaRecorder.isTypeSupported(m); });
        var rec = new MediaRecorder(cv.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : undefined);
        var chunks = [];
        rec.ondataavailable = function(e){ if (e.data.size) chunks.push(e.data); };
        rec.onstop = function(){
          var blob = new Blob(chunks, { type: 'video/webm' });
          var fr = new FileReader();
          fr.onload = function(){ window.__owVid = fr.result.split(',')[1]; window.__owVidSize = blob.size; resolve('ok ' + blob.size); };
          fr.readAsDataURL(blob);
        };
        var dur=${dur}, t0=null;
        var CX=${+cx}, CY=${+cy}, CZ=${+cz};
        var A=${JSON.stringify(opts.from)}, B=${JSON.stringify(opts.to)};
        function frame(ts){
          if(!t0) t0=ts;
          var t=Math.min((ts-t0)/dur,1);
          var e=t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2;  // easeInOutQuad
          var px=A[0]+(B[0]-A[0])*e, py=A[1]+(B[1]-A[1])*e, pz=A[2]+(B[2]-A[2])*e;
          var p=__game.player;
          p.position.set(px,py,pz); p.velocity.set(0,0,0);
          var dx=CX-px, dy=CY-py, dz=CZ-pz;
          p.yaw=Math.atan2(-dx,-dz);
          p.pitch=Math.atan2(dy,Math.sqrt(dx*dx+dz*dz));
          if(t<1) requestAnimationFrame(frame);
          else setTimeout(function(){ rec.stop(); },300);
        }
        rec.start();
        requestAnimationFrame(frame);
      });
    })()`, true);
    let size = 0;
    for (let i = 0; i < 20; i++) { size = (await this.eval('window.__owVidSize || 0')) || 0; if (size) break; await sleep(500); }
    if (!size) throw new Error('视频录制失败');
    const b64len = await this.eval('window.__owVid.length');
    let buf = Buffer.alloc(0);
    for (let off = 0; off < b64len; off += 800000) {
      buf = Buffer.concat([buf, Buffer.from(await this.eval(`window.__owVid.substr(${off}, 800000)`), 'base64')]);
    }
    await this.eval('window.__owVid=null; window.__owVidSize=0');
    fs.writeFileSync(file, buf);
    this.log('分镜 [' + opts.id + '] 视频完成 (' + (buf.length / 1024).toFixed(0) + ' KB)');
    return file;
  }

  // 跟拍：替身角色（黑身红头）沿 A→B 移动，相机后方跟随
  async recordFollow(opts, outDir) {
    const file = path.join(outDir, 'shot-' + opts.id + '.webm');
    const dur = (opts.duration || 8) * 1000;
    this.log('录制 [' + opts.id + '] 跟拍 ' + (dur / 1000) + 's ...');
    await this.eval(`(function(){
      return new Promise(function(resolve){
        var g=__game.world, p=__game.player;
        var GROUND={grass:1,dirt:1,stone:1,sand:1,bedrock:1,snow:1};
        function ground(x,z){for(var y=14;y>=0;y--){var b=g.registry.get(x,y,z);if(b&&GROUND[b.type])return y}return 1}
        var cv=document.querySelector('canvas');
        var mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(function(m){return MediaRecorder.isTypeSupported(m)});
        var rec=new MediaRecorder(cv.captureStream(30),mime?{mimeType:mime,videoBitsPerSecond:6000000}:undefined);
        var chunks=[]; rec.ondataavailable=function(e){if(e.data.size)chunks.push(e.data)};
        rec.onstop=function(){var blob=new Blob(chunks,{type:'video/webm'});var fr=new FileReader();fr.onload=function(){window.__owVid=fr.result.split(',')[1];window.__owVidSize=blob.size;resolve('ok '+blob.size)};fr.readAsDataURL(blob)};
        var A=${JSON.stringify(opts.from)}, B=${JSON.stringify(opts.to)};
        var dur=${dur}, t=0, last=null, prevChunk=null;
        var iv=setInterval(function(){
          t+=150/dur; if(t>1)t=1;
          var x=Math.round(A[0]+(B[0]-A[0])*t), z=Math.round(A[1]+(B[1]-A[1])*t);
          var gy=ground(x,z);
          if(last){ last.forEach(function(q){g.voxelBuilder.removeBlock(q[0],q[1],q[2])}); }
          last=[[x,gy+1,z],[x,gy+2,z]];
          g.voxelBuilder.addBlock('black',x,gy+1,z);
          g.voxelBuilder.addBlock('red',x,gy+2,z);
          g.refreshChunkAt(x,z); if(prevChunk&&prevChunk!==(x+'|'+z))g.refreshChunkAt(prevChunk.split('|')[0]*1,prevChunk.split('|')[1]*1);
          prevChunk=x+'|'+z;
          var dx=B[0]-A[0],dz=B[1]-A[1],L=Math.sqrt(dx*dx+dz*dz)||1;dx/=L;dz/=L;
          var px=x-dx*5, pz=z-dz*5, py=gy+3.5;
          p.position.set(px,py,pz); p.velocity.set(0,0,0);
          var tx=x-px, ty=(gy+1.5)-py, tz=z-pz;
          p.yaw=Math.atan2(-tx,-tz);
          p.pitch=Math.atan2(ty,Math.sqrt(tx*tx+tz*tz));
          if(t>=1){ clearInterval(iv); setTimeout(function(){rec.stop()},400); }
        },150);
        rec.start();
      });
    })()`, true);
    let size = 0;
    for (let i = 0; i < 20; i++) { size = (await this.eval('window.__owVidSize || 0')) || 0; if (size) break; await sleep(500); }
    if (!size) throw new Error('跟拍录制失败');
    const b64len = await this.eval('window.__owVid.length');
    let buf = Buffer.alloc(0);
    for (let off = 0; off < b64len; off += 800000) buf = Buffer.concat([buf, Buffer.from(await this.eval(`window.__owVid.substr(${off}, 800000)`), 'base64')]);
    await this.eval('window.__owVid=null;window.__owVidSize=0');
    fs.writeFileSync(file, buf);
    this.log('分镜 [' + opts.id + '] 跟拍完成 (' + (buf.length / 1024).toFixed(0) + ' KB)');
    return file;
  }

  async close() {
    try { if (this.chrome) this.chrome.kill(); } catch (e) {}
    this.chrome = null;
  }
}

module.exports = { Engine, sleep };
