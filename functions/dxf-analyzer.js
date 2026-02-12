// dxf-analyzer.js v3 - Smart IQR bounds for real-world DXF files
const fs = require('fs');

// ============ PARSER ============
function parseDXF(filePath) {
  var raw = fs.readFileSync(filePath, 'utf8');
  var tokens = [], lines = raw.split(/\r?\n/);
  for (var i = 0; i < lines.length - 1; i += 2) {
    var code = parseInt(lines[i].trim()), value = (lines[i + 1] || '').trim();
    if (!isNaN(code)) tokens.push({ code: code, value: value });
  }
  var sections = {}, idx = 0;
  while (idx < tokens.length) {
    if (tokens[idx].code === 0 && tokens[idx].value === 'SECTION' && tokens[idx + 1] && tokens[idx + 1].code === 2) {
      var name = tokens[idx + 1].value, start = idx + 2, end = start;
      while (end < tokens.length && !(tokens[end].code === 0 && tokens[end].value === 'ENDSEC')) end++;
      sections[name] = { start: start, end: end }; idx = end + 1;
    } else idx++;
  }

  var blocks = {};
  if (sections.BLOCKS) {
    var j = sections.BLOCKS.start, curBlock = null, bEnts = [];
    while (j < sections.BLOCKS.end) {
      if (tokens[j].code === 0) {
        if (tokens[j].value === 'BLOCK') {
          curBlock = null; bEnts = [];
          var k = j + 1, bx = 0, by = 0;
          while (k < tokens.length && tokens[k].code !== 0) {
            if (tokens[k].code === 2) curBlock = tokens[k].value;
            if (tokens[k].code === 10) bx = parseFloat(tokens[k].value);
            if (tokens[k].code === 20) by = parseFloat(tokens[k].value);
            k++;
          }
          if (curBlock) blocks[curBlock] = { entities: [], baseX: bx, baseY: by };
          j = k; continue;
        } else if (tokens[j].value === 'ENDBLK') {
          if (curBlock && blocks[curBlock]) blocks[curBlock].entities = bEnts;
          curBlock = null; j++; continue;
        } else if (curBlock) {
          var ent = parseEntity(tokens, j);
          if (ent) bEnts.push(ent.entity);
          j = ent ? ent.nextIdx : j + 1; continue;
        }
      }
      j++;
    }
  }

  var entities = [];
  if (sections.ENTITIES) {
    var j2 = sections.ENTITIES.start;
    while (j2 < sections.ENTITIES.end) {
      if (tokens[j2].code === 0) {
        var ent2 = parseEntity(tokens, j2);
        if (ent2) { entities.push(ent2.entity); j2 = ent2.nextIdx; continue; }
      }
      j2++;
    }
  }

  var layers = {};
  if (sections.TABLES) {
    var j3 = sections.TABLES.start;
    while (j3 < sections.TABLES.end) {
      if (tokens[j3].code === 0 && tokens[j3].value === 'LAYER') {
        var lname = '', lcolor = 7, ltype = 'CONTINUOUS', k3 = j3 + 1;
        while (k3 < tokens.length && tokens[k3].code !== 0) {
          if (tokens[k3].code === 2) lname = tokens[k3].value;
          if (tokens[k3].code === 62) lcolor = parseInt(tokens[k3].value);
          if (tokens[k3].code === 6) ltype = tokens[k3].value;
          k3++;
        }
        if (lname) layers[lname] = { color: lcolor, ltype: ltype }; j3 = k3;
      } else j3++;
    }
  }

  var expanded = [];
  function expand(ents, ox, oy, sx, sy, d) {
    if (d > 5) return;
    for (var ei = 0; ei < ents.length; ei++) {
      var ent = ents[ei];
      if (ent.type === 'INSERT' && blocks[ent.blockName]) {
        var b = blocks[ent.blockName];
        var isx = (ent.scaleX || 1) * sx, isy = (ent.scaleY || 1) * sy;
        expand(b.entities, (ent.x || 0) + ox - b.baseX * isx, (ent.y || 0) + oy - b.baseY * isy, isx, isy, d + 1);
      } else {
        var e = {};
        for (var key in ent) e[key] = ent[key];
        if (e.x !== undefined) { e.x = e.x * sx + ox; e.y = (e.y || 0) * sy + oy; }
        if (e.x2 !== undefined) { e.x2 = e.x2 * sx + ox; e.y2 = (e.y2 || 0) * sy + oy; }
        if (e.radius !== undefined) e.radius = e.radius * Math.abs(sx);
        if (e.vertices) e.vertices = e.vertices.map(function(v) { return { x: v.x * sx + ox, y: v.y * sy + oy }; });
        expanded.push(e);
      }
    }
  }
  expand(entities, 0, 0, 1, 1, 0);
  return { entities: expanded, blocks: blocks, layers: layers, raw: entities, blockCount: Object.keys(blocks).length };
}

function parseEntity(tokens, startIdx) {
  var type = tokens[startIdx].value;
  var ok = { LINE: 1, CIRCLE: 1, ARC: 1, TEXT: 1, MTEXT: 1, INSERT: 1, LWPOLYLINE: 1, POLYLINE: 1, SOLID: 1, ELLIPSE: 1, POINT: 1, SPLINE: 1 };
  if (!ok[type]) return null;
  var entity = { type: type }, j = startIdx + 1, verts = [], curVx = null;
  while (j < tokens.length && tokens[j].code !== 0) {
    var c = tokens[j].code, v = tokens[j].value;
    if (c === 8) entity.layer = v;
    else if (c === 6) entity.linetype = v;
    else if (c === 62) entity.color = parseInt(v);
    else if (c === 10) { if (type === 'LWPOLYLINE' || type === 'POLYLINE') { if (curVx !== null) verts.push({ x: curVx, y: 0 }); curVx = parseFloat(v); } else entity.x = parseFloat(v); }
    else if (c === 20) { if ((type === 'LWPOLYLINE' || type === 'POLYLINE') && curVx !== null) { verts.push({ x: curVx, y: parseFloat(v) }); curVx = null; } else entity.y = parseFloat(v); }
    else if (c === 11) entity.x2 = parseFloat(v);
    else if (c === 21) entity.y2 = parseFloat(v);
    else if (c === 40) { entity.radius = parseFloat(v); entity.height = parseFloat(v); }
    else if (c === 41) entity.scaleX = parseFloat(v);
    else if (c === 42) entity.scaleY = parseFloat(v);
    else if (c === 50) { entity.startAngle = parseFloat(v); entity.rotation = parseFloat(v); }
    else if (c === 51) entity.endAngle = parseFloat(v);
    else if (c === 1) entity.text = v;
    else if (c === 2) entity.blockName = v;
    else if (c === 70) entity.flags = parseInt(v);
    j++;
  }
  if ((type === 'LWPOLYLINE' || type === 'POLYLINE') && curVx !== null) verts.push({ x: curVx, y: 0 });
  if (verts.length > 0) entity.vertices = verts;
  return { entity: entity, nextIdx: j };
}

// ============ CLASSIFIER ============
function classifyEntities(parsed) {
  var C = { walls: [], doors: [], fireDoors: [], windows: [], stairs: [], elevators: [], corridors: [], rooms: [], exits: [], sprinklers: [], smokeDetectors: [], heatDetectors: [], fireExtinguishers: [], hydrants: [], fireAlarmPanel: [], manualCallPoints: [], emergencyLights: [], exitSigns: [], smokeVents: [], fireWalls: [], accessRoads: [], texts: [], unknown: [], stats: { total: 0, classified: 0, byLayer: {}, byType: {} } };
  var LP = { walls: /wall|קיר|A[-_]?WALL|^KIR$/i, doors: /^door|דלת|A[-_]?DOOR|^DELET$/i, fireDoors: /fire.?door|דלת.?אש|FD[-_]/i, windows: /window|חלון|^HALON$/i, stairs: /stair|מדרגות|^MADREGOT$/i, elevators: /elev|lift|מעלית|^MAALIT$/i, sprinklers: /sprink|מתז|ספרינק|FIRE[-_]S/i, smokeDetectors: /smoke.?det|גלאי.?עשן|SD[-_]/i, heatDetectors: /heat.?det|גלאי.?חום|HD[-_]/i, fireExtinguishers: /exting|מטפ|FE[-_]/i, hydrants: /hydrant|ברז.?כיבוי|הידרנט|IH[-_]|FH[-_]/i, fireAlarmPanel: /alarm.?panel|רכזת/i, manualCallPoints: /call.?point|MCP/i, emergencyLights: /emerg.?light|תאורת.?חירום|EC[-_]/i, exitSigns: /exit.?sign|שלט.?יציאה/i, smokeVents: /smoke.?vent|שחרור.?עשן|SV[-_]|VENT/i, fireWalls: /fire.?wall|קיר.?אש|FIRE[-_]W|FW[-_]/i, accessRoads: /access|גישה|FIRE[-_]ACC|^KVISH$|^DEREH/i };
  var TP = { doors: /door|דלת/i, fireDoors: /fire.?door|דלת.?אש|FD[-_]?\d/i, exits: /exit|יציאה|מוצא/i, stairs: /stair|מדרגות/i, sprinklers: /^S$|sprink|מתז/i, smokeDetectors: /^SD$|גלאי.?עשן/i, fireExtinguishers: /^FE$|מטפ/i, hydrants: /^IH$|^EH$|הידרנט|ברז/i, emergencyLights: /^EC$|חירום/i, exitSigns: /^EXIT$/i, smokeVents: /^SV$/i, rooms: /office|משרד|חדר|room/i };
  var BP = { doors: /door|DR[-_]/i, fireDoors: /FD[-_]/i, sprinklers: /sprink|SPR[-_]/i, smokeDetectors: /SD[-_]|DETECT/i, fireExtinguishers: /FE[-_]/i, hydrants: /HYD[-_]|IH[-_]/i, stairs: /STAIR/i, elevators: /ELEV|LIFT/i, exitSigns: /EXIT/i };

  for (var i = 0; i < parsed.entities.length; i++) {
    var ent = parsed.entities[i];
    C.stats.total++;
    var layer = (ent.layer || '').toUpperCase();
    C.stats.byLayer[layer] = (C.stats.byLayer[layer] || 0) + 1;
    C.stats.byType[ent.type] = (C.stats.byType[ent.type] || 0) + 1;
    var m = false;
    var lpKeys = Object.keys(LP);
    for (var li = 0; li < lpKeys.length && !m; li++) { if (LP[lpKeys[li]].test(ent.layer || '')) { C[lpKeys[li]].push(ent); m = true; } }
    if (!m && (ent.type === 'TEXT' || ent.type === 'MTEXT') && ent.text) {
      C.texts.push(ent);
      var tpKeys = Object.keys(TP);
      for (var ti = 0; ti < tpKeys.length && !m; ti++) { if (TP[tpKeys[ti]].test(ent.text)) { C[tpKeys[ti]].push(ent); m = true; } }
    }
    if (!m && ent.type === 'INSERT' && ent.blockName) {
      var bpKeys = Object.keys(BP);
      for (var bi = 0; bi < bpKeys.length && !m; bi++) { if (BP[bpKeys[bi]].test(ent.blockName)) { C[bpKeys[bi]].push(ent); m = true; } }
    }
    // Only classify circles as sprinklers if they're on a fire/system layer, NOT generic layer 0
    if (!m && ent.type === 'CIRCLE' && ent.radius && ent.radius < 0.5) {
      var cl = (ent.layer || '0').toUpperCase();
      if (/FIRE|SPRINK|SYSTEM|מתז|ספרינק/i.test(cl) && cl !== '0') { C.sprinklers.push(ent); m = true; }
    }
    if (!m) C.unknown.push(ent);
    if (m) C.stats.classified++;
  }
  return C;
}

// ============ GEOMETRY ============
function analyzeGeometry(classified) {
  var G = { bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, totalArea: 0, maxTravelDistances: [], sprinklerSpacing: [], detectorSpacing: [], extinguisherSpacing: [], hydrantSpacing: [] };
  var all = [].concat(classified.walls, classified.doors, classified.corridors);
  for (var i = 0; i < all.length; i++) {
    var ent = all[i];
    if (ent.x !== undefined) { G.bounds.minX = Math.min(G.bounds.minX, ent.x); G.bounds.maxX = Math.max(G.bounds.maxX, ent.x); G.bounds.minY = Math.min(G.bounds.minY, ent.y); G.bounds.maxY = Math.max(G.bounds.maxY, ent.y); }
    if (ent.x2 !== undefined) { G.bounds.minX = Math.min(G.bounds.minX, ent.x2); G.bounds.maxX = Math.max(G.bounds.maxX, ent.x2); G.bounds.minY = Math.min(G.bounds.minY, ent.y2); G.bounds.maxY = Math.max(G.bounds.maxY, ent.y2); }
  }
  if (G.bounds.minX !== Infinity) G.totalArea = (G.bounds.maxX - G.bounds.minX) * (G.bounds.maxY - G.bounds.minY);
  function sp(items) {
    var p = items.filter(function(e) { return e.x !== undefined; }).map(function(e) { return { x: e.x, y: e.y }; });
    if (p.length < 2) return [];
    return p.map(function(_, i) { var min = Infinity; p.forEach(function(q, j) { if (i !== j) { var d = Math.hypot(p[i].x - q.x, p[i].y - q.y); if (d < min) min = d; } }); return min; }).filter(function(d) { return d < Infinity; });
  }
  G.sprinklerSpacing = sp(classified.sprinklers); G.detectorSpacing = sp(classified.smokeDetectors);
  G.extinguisherSpacing = sp(classified.fireExtinguishers); G.hydrantSpacing = sp(classified.hydrants);
  var exits = [].concat(classified.exits, classified.stairs).filter(function(e) { return e.x !== undefined; });
  if (exits.length > 0 && G.bounds.minX !== Infinity) {
    var sx = (G.bounds.maxX - G.bounds.minX) / 10 || 1, sy = (G.bounds.maxY - G.bounds.minY) / 10 || 1;
    for (var x = G.bounds.minX; x <= G.bounds.maxX; x += sx) for (var y = G.bounds.minY; y <= G.bounds.maxY; y += sy) { var min = Infinity; exits.forEach(function(e) { var d = Math.hypot(x - e.x, y - e.y); if (d < min) min = d; }); G.maxTravelDistances.push(min); }
  }
  return G;
}

// ============ RULES ============
function checkFireSafetyRules(classified, geometry) {
  var R = { overallScore: 0, overallStatus: 'דורש_בדיקה', buildingType: 'מבנה', categories: [], criticalIssues: [], summary: '', summaryHe: '' };
  var allText = classified.texts.map(function(t) { return t.text || ''; }).join(' ');
  if (/office|משרד/i.test(allText)) R.buildingType = 'מבנה משרדים';
  else if (/resid|מגור/i.test(allText)) R.buildingType = 'מבנה מגורים';
  var scores = [];
  function avg(a) { return a.length ? a.reduce(function(s, v) { return s + v; }, 0) / a.length : null; }

  var ac = classified.accessRoads.length, s1 = ac > 0 ? 70 : 20;
  R.categories.push({ id: 1, nameHe: 'דרכי גישה', status: ac > 0 ? 'דורש_בדיקה' : 'נכשל', score: s1, findings: [ac + ' אלמנטי גישה'], recommendations: ac === 0 ? ['לסמן דרך גישה 3.5מ'] : [] }); scores.push(s1);
  var exitC = classified.exits.length + classified.stairs.length, maxT = geometry.maxTravelDistances.length ? Math.max.apply(null, geometry.maxTravelDistances) : null;
  var s2 = 50, f2 = ['יציאות: ' + classified.exits.length, 'מדרגות: ' + classified.stairs.length, 'דלתות: ' + classified.doors.length + ' (אש: ' + classified.fireDoors.length + ')'], r2 = [];
  if (exitC >= 2) { s2 += 30; f2.push('2+ יציאות'); } else { r2.push('נדרשות 2 יציאות'); R.criticalIssues.push('פחות מ-2 יציאות'); }
  if (maxT !== null) { f2.push('מרחק מילוט: ' + maxT.toFixed(1) + 'מ'); if (maxT > 40) { s2 -= 20; r2.push('מרחק>40מ'); } }
  if (classified.fireDoors.length > 0) s2 += 10; else r2.push('לסמן דלתות אש');
  R.categories.push({ id: 2, nameHe: 'דרכי מילוט ויציאות', status: s2 >= 70 ? 'עובר' : s2 >= 40 ? 'דורש_בדיקה' : 'נכשל', score: Math.min(100, Math.max(0, s2)), findings: f2, recommendations: r2 }); scores.push(s2);
  var s3 = 20; if (classified.smokeDetectors.length > 0) s3 += 25; if (classified.heatDetectors.length > 0) s3 += 10; if (classified.manualCallPoints.length > 0) s3 += 15; if (classified.fireAlarmPanel.length > 0) s3 += 15;
  var ad = avg(geometry.detectorSpacing), f3 = ['גלאי עשן: ' + classified.smokeDetectors.length, 'גלאי חום: ' + classified.heatDetectors.length]; if (ad) f3.push('מרחק גלאים: ' + ad.toFixed(1) + 'מ');
  R.categories.push({ id: 3, nameHe: 'מערכת גילוי', status: s3 >= 70 ? 'עובר' : s3 >= 40 ? 'דורש_בדיקה' : 'נכשל', score: Math.min(100, s3), findings: f3, recommendations: classified.smokeDetectors.length === 0 ? ['להוסיף גלאי עשן'] : [] }); scores.push(s3);
  var s4 = classified.sprinklers.length > 0 ? 50 : 10, aspr = avg(geometry.sprinklerSpacing); if (aspr && aspr <= 4.5) s4 += 30; if (classified.sprinklers.length > 5) s4 += 10;
  var f4 = ['מתזים: ' + classified.sprinklers.length]; if (aspr) f4.push('מרחק: ' + aspr.toFixed(1) + 'מ');
  R.categories.push({ id: 4, nameHe: 'מערכת מתזים', status: s4 >= 70 ? 'עובר' : s4 >= 40 ? 'דורש_בדיקה' : 'נכשל', score: Math.min(100, s4), findings: f4, recommendations: classified.sprinklers.length === 0 ? ['לבדוק חובת מתזים'] : [] }); scores.push(s4);
  var s5 = 20; if (classified.fireExtinguishers.length > 0) s5 += 25; if (classified.hydrants.length > 0) s5 += 25;
  var afe = avg(geometry.extinguisherSpacing), aih = avg(geometry.hydrantSpacing); if (afe && afe <= 25) s5 += 15; if (aih && aih <= 30) s5 += 15;
  var f5 = ['מטפים: ' + classified.fireExtinguishers.length, 'ברזי כיבוי: ' + classified.hydrants.length], r5 = [];
  if (classified.fireExtinguishers.length === 0) r5.push('להוסיף מטפים'); if (classified.hydrants.length === 0) r5.push('להוסיף ברזים');
  R.categories.push({ id: 5, nameHe: 'ציוד כיבוי', status: s5 >= 70 ? 'עובר' : s5 >= 40 ? 'דורש_בדיקה' : 'נכשל', score: Math.min(100, s5), findings: f5, recommendations: r5 }); scores.push(s5);
  var s6 = 30; if (classified.fireWalls.length > 0) s6 += 30; if (classified.fireDoors.length > 0) s6 += 20;
  R.categories.push({ id: 6, nameHe: 'הפרדות אש', status: s6 >= 70 ? 'עובר' : s6 >= 40 ? 'דורש_בדיקה' : 'נכשל', score: s6, findings: ['קירות אש: ' + classified.fireWalls.length, 'דלתות אש: ' + classified.fireDoors.length], recommendations: classified.fireWalls.length === 0 ? ['לסמן קירות אש'] : [] }); scores.push(s6);
  var s7 = 20; if (classified.emergencyLights.length > 0) s7 += 30; if (classified.exitSigns.length > 0) s7 += 30;
  R.categories.push({ id: 7, nameHe: 'תאורת חירום ושילוט', status: s7 >= 70 ? 'עובר' : s7 >= 40 ? 'דורש_בדיקה' : 'נכשל', score: s7, findings: ['תאורת חירום: ' + classified.emergencyLights.length, 'שלטי יציאה: ' + classified.exitSigns.length], recommendations: [] }); scores.push(s7);
  var sv = classified.smokeVents.length, s8 = sv > 0 ? 60 : 15;
  R.categories.push({ id: 8, nameHe: 'שליטה בעשן', status: s8 >= 60 ? 'דורש_בדיקה' : 'נכשל', score: s8, findings: ['פתחי עשן: ' + sv], recommendations: sv === 0 ? ['מערכת שחרור עשן'] : [] }); scores.push(s8);
  var s9 = 20; if (classified.texts.some(function(t) { return /plan|תוכנית/i.test(t.text || ''); })) s9 += 20; if (classified.texts.some(function(t) { return /scale|קנה|1:/i.test(t.text || ''); })) s9 += 20;
  R.categories.push({ id: 9, nameHe: 'תיעוד', status: s9 >= 70 ? 'עובר' : s9 >= 40 ? 'דורש_בדיקה' : 'נכשל', score: Math.min(100, s9), findings: ['טקסטים: ' + classified.texts.length, 'שכבות: ' + Object.keys(classified.stats.byLayer).length], recommendations: [] }); scores.push(s9);

  R.overallScore = Math.round(scores.reduce(function(a, b) { return a + b; }, 0) / scores.length);
  R.overallStatus = R.overallScore >= 70 ? 'עובר' : R.overallScore >= 40 ? 'דורש_בדיקה' : 'נכשל';
  R.summary = 'ניתוח: ' + classified.stats.total + ' אלמנטים (' + classified.stats.classified + ' מסווגים). ציון: ' + R.overallScore + '/100.';
  R.summaryHe = R.summary;
  return R;
}

// ============ SMART BOUNDS (IQR) ============
function computeSmartBounds(entities) {
  // Collect ALL coordinates from geometry (not POINT, not LOGO/FRAME layers)
  var xs = [], ys = [];
  var skipLayers = /^LOGO$|^IDAN_|^TR_|^POINTS|^ZAFON$/i;

  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var layer = (e.layer || '').toUpperCase();
    if (skipLayers.test(layer)) continue; // Skip logo/frame/annotation layers
    if (e.type === 'POINT') continue; // Survey points are often outliers
    if (e.type === 'LINE' && e.x !== undefined && e.x2 !== undefined) {
      // Use both endpoints and midpoint
      xs.push(e.x, e.x2, (e.x + e.x2) / 2);
      ys.push(e.y, e.y2, (e.y + e.y2) / 2);
    } else if (e.type === 'CIRCLE' && e.x !== undefined) {
      xs.push(e.x); ys.push(e.y);
    } else if (e.type === 'ARC' && e.x !== undefined) {
      xs.push(e.x); ys.push(e.y);
    } else if ((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && e.vertices && e.vertices.length > 0) {
      e.vertices.forEach(function(v) { xs.push(v.x); ys.push(v.y); });
    }
    // Intentionally skip TEXT - it's often in title blocks far from the building
  }

  if (xs.length < 4) {
    // Fallback: use everything
    for (var i2 = 0; i2 < entities.length; i2++) {
      var e2 = entities[i2];
      if (e2.x !== undefined) { xs.push(e2.x); ys.push(e2.y); }
      if (e2.x2 !== undefined) { xs.push(e2.x2); ys.push(e2.y2); }
    }
  }

  if (xs.length === 0) return { minX: 0, maxX: 100, minY: 0, maxY: 100 };

  xs.sort(function(a, b) { return a - b; });
  ys.sort(function(a, b) { return a - b; });

  // IQR method: Q1 - 1.5*IQR to Q3 + 1.5*IQR
  var q1x = xs[Math.floor(xs.length * 0.25)];
  var q3x = xs[Math.floor(xs.length * 0.75)];
  var iqrX = q3x - q1x;
  var q1y = ys[Math.floor(ys.length * 0.25)];
  var q3y = ys[Math.floor(ys.length * 0.75)];
  var iqrY = q3y - q1y;

  // Use 1.5x IQR for tight bounds focused on the building
  var minX = q1x - 1.5 * iqrX;
  var maxX = q3x + 1.5 * iqrX;
  var minY = q1y - 1.5 * iqrY;
  var maxY = q3y + 1.5 * iqrY;

  // Sanity: don't clip tighter than P10-P90
  var p5x = xs[Math.floor(xs.length * 0.10)];
  var p95x = xs[Math.floor(xs.length * 0.90)];
  var p5y = ys[Math.floor(ys.length * 0.10)];
  var p95y = ys[Math.floor(ys.length * 0.90)];
  minX = Math.min(minX, p5x);
  maxX = Math.max(maxX, p95x);
  minY = Math.min(minY, p5y);
  maxY = Math.max(maxY, p95y);

  // Ensure minimum size
  if (maxX - minX < 1) { minX -= 50; maxX += 50; }
  if (maxY - minY < 1) { minY -= 50; maxY += 50; }

  // Add 5% margin
  var padX = (maxX - minX) * 0.05;
  var padY = (maxY - minY) * 0.05;

  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

// ============ SVG RENDERER ============
function renderToSVG(parsed, classified, width) {
  width = width || 4000;
  var bounds = computeSmartBounds(parsed.entities);
  var minX = bounds.minX, maxX = bounds.maxX, minY = bounds.minY, maxY = bounds.maxY;

  console.log('  Bounds: X[' + minX.toFixed(1) + ', ' + maxX.toFixed(1) + '] Y[' + minY.toFixed(1) + ', ' + maxY.toFixed(1) + ']');

  var dW = maxX - minX || 1, dH = maxY - minY || 1;
  var legH = 80;
  var imgH = Math.max(400, Math.round(width * (dH / dW)));
  // Cap aspect ratio to prevent extremely tall images
  if (imgH > width * 3) imgH = width * 3;
  var totalH = imgH + legH;
  var scale = Math.min(width / dW, imgH / dH) * 0.95;
  var offX = (width - dW * scale) / 2;
  var offY = (imgH - dH * scale) / 2;

  function tx(x) { return ((x - minX) * scale + offX).toFixed(2); }
  function ty(y) { return (imgH - ((y - minY) * scale + offY)).toFixed(2); }

  // Marker size proportional to drawing content size (not canvas pixels)
  // Target: marker should be about 1/150th of the drawing width
  var mSize = Math.max(3, Math.min(12, dW * scale / 150));

  var COL = { walls: '#1a1a2e', doors: '#16a34a', fireDoors: '#dc2626', stairs: '#0891b2', sprinklers: '#2563eb', smokeDetectors: '#f59e0b', heatDetectors: '#ea580c', fireExtinguishers: '#e11d48', hydrants: '#b91c1c', emergencyLights: '#eab308', exitSigns: '#22c55e', smokeVents: '#8b5cf6', fireWalls: '#ff0000', exits: '#15803d', windows: '#06b6d4', unknown: '#94a3b8' };

  var styles = new Map();
  classified.walls.forEach(function(e) { styles.set(e, { c: COL.walls, w: 2.0 }); });
  classified.doors.forEach(function(e) { styles.set(e, { c: COL.doors, w: 2.5 }); });
  classified.fireDoors.forEach(function(e) { styles.set(e, { c: COL.fireDoors, w: 3, d: '6,3' }); });
  classified.stairs.forEach(function(e) { styles.set(e, { c: COL.stairs, w: 2 }); });
  classified.fireWalls.forEach(function(e) { styles.set(e, { c: COL.fireWalls, w: 3.5, d: '10,5' }); });
  classified.exits.forEach(function(e) { styles.set(e, { c: COL.exits, w: 2.5 }); });
  classified.windows.forEach(function(e) { styles.set(e, { c: COL.windows, w: 1.5 }); });

  // Track which entities are markers (skip in geometry pass)
  var markerSet = new Set();
  [classified.sprinklers, classified.smokeDetectors, classified.heatDetectors, classified.fireExtinguishers, classified.hydrants, classified.emergencyLights, classified.exitSigns, classified.smokeVents].forEach(function(arr) { arr.forEach(function(e) { markerSet.add(e); }); });

  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + totalH + '" viewBox="0 0 ' + width + ' ' + totalH + '">';
  svg += '<rect width="100%" height="100%" fill="#fafbfc"/>';
  svg += '<rect x="4" y="4" width="' + (width - 8) + '" height="' + (imgH - 8) + '" fill="white" stroke="#e2e8f0" rx="4"/>';
  svg += '<defs><style>text{font-family:Arial,sans-serif}</style></defs>';

  // Skip layers that clutter the drawing
  var renderSkip = /^LOGO$|^IDAN_CROSS$|^POINTS$|^POINTS_BETON$/i;

  // Draw geometry
  for (var i = 0; i < parsed.entities.length; i++) {
    var ent = parsed.entities[i];
    if (markerSet.has(ent)) continue;
    var entLayer = (ent.layer || '').toUpperCase();
    if (renderSkip.test(entLayer)) continue; // drawn as markers later
    var s = styles.get(ent);
    var col = s ? s.c : COL.unknown;
    var w = s ? s.w : 0.7;
    var dash = s && s.d ? ' stroke-dasharray="' + s.d + '"' : '';

    if (ent.type === 'LINE' && ent.x !== undefined && ent.x2 !== undefined) {
      svg += '<line x1="' + tx(ent.x) + '" y1="' + ty(ent.y) + '" x2="' + tx(ent.x2) + '" y2="' + ty(ent.y2) + '" stroke="' + col + '" stroke-width="' + w + '"' + dash + ' stroke-linecap="round"/>';
    } else if (ent.type === 'CIRCLE' && ent.radius) {
      var r = Math.max(ent.radius * scale, 1);
      svg += '<circle cx="' + tx(ent.x) + '" cy="' + ty(ent.y) + '" r="' + r.toFixed(1) + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"/>';
    } else if (ent.type === 'ARC' && ent.radius) {
      var ra = Math.max(ent.radius * scale, 1);
      var sa = (ent.startAngle || 0) * Math.PI / 180, ea = (ent.endAngle || 360) * Math.PI / 180;
      var ax1 = tx(ent.x + ent.radius * Math.cos(sa)), ay1 = ty(ent.y + ent.radius * Math.sin(sa));
      var ax2 = tx(ent.x + ent.radius * Math.cos(ea)), ay2 = ty(ent.y + ent.radius * Math.sin(ea));
      var la = ((ent.endAngle || 360) - (ent.startAngle || 0) + 360) % 360 > 180 ? 1 : 0;
      svg += '<path d="M' + ax1 + ',' + ay1 + ' A' + ra + ',' + ra + ' 0 ' + la + ',0 ' + ax2 + ',' + ay2 + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"/>';
    } else if ((ent.type === 'TEXT' || ent.type === 'MTEXT') && ent.text && ent.x !== undefined) {
      var fs = Math.max((ent.height || 0.3) * scale * 0.55, 5);
      if (fs > 40) fs = 40; // cap text size
      var esc = ent.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      svg += '<text x="' + tx(ent.x) + '" y="' + ty(ent.y) + '" font-size="' + fs.toFixed(1) + '" fill="#4b5563">' + esc + '</text>';
    } else if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices && ent.vertices.length > 1) {
      var pts = ent.vertices.map(function(v) { return tx(v.x) + ',' + ty(v.y); }).join(' ');
      svg += '<polyline points="' + pts + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"' + dash + '/>';
    }
  }

  // Fire safety markers
  function dm(items, color, shape) {
    for (var mi = 0; mi < items.length; mi++) {
      var e = items[mi]; if (e.x === undefined) continue;
      var cx = parseFloat(tx(e.x)), cy = parseFloat(ty(e.y));
      // Skip if outside visible area
      if (cx < 0 || cx > width || cy < 0 || cy > imgH) continue;
      if (shape === 'c') svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + mSize + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>';
      else if (shape === 'r') { svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + mSize + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>'; svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (mSize * 0.35) + '" fill="none" stroke="white" stroke-width="0.5"/>'; }
      else if (shape === 's') svg += '<rect x="' + (cx - mSize) + '" y="' + (cy - mSize) + '" width="' + (mSize * 2) + '" height="' + (mSize * 2) + '" fill="' + color + '" stroke="white" stroke-width="0.7" rx="1" opacity="0.85"/>';
      else if (shape === 'd') svg += '<polygon points="' + cx + ',' + (cy - mSize) + ' ' + (cx + mSize) + ',' + cy + ' ' + cx + ',' + (cy + mSize) + ' ' + (cx - mSize) + ',' + cy + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>';
      else if (shape === 't') svg += '<polygon points="' + cx + ',' + (cy - mSize) + ' ' + (cx + mSize) + ',' + (cy + mSize * 0.7) + ' ' + (cx - mSize) + ',' + (cy + mSize * 0.7) + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>';
    }
  }
  dm(classified.sprinklers, COL.sprinklers, 'c');
  dm(classified.smokeDetectors, COL.smokeDetectors, 'r');
  dm(classified.heatDetectors, COL.heatDetectors, 'r');
  dm(classified.fireExtinguishers, COL.fireExtinguishers, 's');
  dm(classified.hydrants, COL.hydrants, 's');
  dm(classified.emergencyLights, COL.emergencyLights, 'd');
  dm(classified.exitSigns, COL.exitSigns, 't');
  dm(classified.smokeVents, COL.smokeVents, 'd');

  // Legend
  var ly = imgH + 6;
  svg += '<rect x="4" y="' + ly + '" width="' + (width - 8) + '" height="' + (legH - 10) + '" fill="white" stroke="#e2e8f0" rx="4"/>';
  svg += '<text x="' + (width / 2) + '" y="' + (ly + 18) + '" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">מקרא - Legend</text>';
  var li = [[COL.walls, 'קירות'], [COL.doors, 'דלתות'], [COL.fireDoors, 'דלתות אש'], [COL.stairs, 'מדרגות'], [COL.sprinklers, 'מתזים'], [COL.smokeDetectors, 'גלאי עשן'], [COL.fireExtinguishers, 'מטפים'], [COL.hydrants, 'ברזי כיבוי'], [COL.emergencyLights, 'תאורת חירום'], [COL.exitSigns, 'שלטי יציאה'], [COL.fireWalls, 'קירות אש'], [COL.smokeVents, 'פתחי עשן']];
  var nc = 6, iw = (width - 40) / nc;
  for (var idx = 0; idx < li.length; idx++) {
    var c2 = idx % nc, r2 = Math.floor(idx / nc);
    var lx = 20 + c2 * iw, liy = ly + 30 + r2 * 20;
    svg += '<rect x="' + lx + '" y="' + liy + '" width="12" height="12" fill="' + li[idx][0] + '" rx="2"/>';
    svg += '<text x="' + (lx + 18) + '" y="' + (liy + 10) + '" fill="#374151" font-size="10">' + li[idx][1] + '</text>';
  }
  svg += '</svg>';
  return svg;
}

// ============ MAIN ============
async function analyzeDXF(filePath) {
  console.log('Vector DXF analysis v3...');
  var parsed = parseDXF(filePath);
  console.log('  Entities: ' + parsed.entities.length + ', Blocks: ' + parsed.blockCount + ', Layers: ' + Object.keys(parsed.layers).length);
  var classified = classifyEntities(parsed);
  console.log('  Classified: ' + classified.stats.classified + '/' + classified.stats.total);
  console.log('  Layers: ' + Object.keys(classified.stats.byLayer).join(', '));
  var geometry = analyzeGeometry(classified);
  var analysis = checkFireSafetyRules(classified, geometry);
  var svg = renderToSVG(parsed, classified, 4000);
  var pngBuffer = null;
  try {
    var sharp = require('sharp');
    pngBuffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 1 }).toBuffer();
    console.log('  PNG: ' + (pngBuffer.length / 1024).toFixed(0) + 'KB');
  } catch (e) { console.log('  sharp unavailable'); }
  return {
    analysis: analysis, svg: svg, pngBuffer: pngBuffer,
    parsed: { entityCount: parsed.entities.length, blockCount: parsed.blockCount, layerCount: Object.keys(parsed.layers).length, layers: parsed.layers },
    vectorData: { layers: Object.keys(classified.stats.byLayer), entityTypes: classified.stats.byType,
      summary: { walls: classified.walls.length, doors: classified.doors.length, fireDoors: classified.fireDoors.length, stairs: classified.stairs.length, exits: classified.exits.length, sprinklers: classified.sprinklers.length, smokeDetectors: classified.smokeDetectors.length, fireExtinguishers: classified.fireExtinguishers.length, hydrants: classified.hydrants.length, emergencyLights: classified.emergencyLights.length, exitSigns: classified.exitSigns.length, smokeVents: classified.smokeVents.length, fireWalls: classified.fireWalls.length, texts: classified.texts.length } }
  };
}

module.exports = { analyzeDXF: analyzeDXF, parseDXF: parseDXF, classifyEntities: classifyEntities, analyzeGeometry: analyzeGeometry, checkFireSafetyRules: checkFireSafetyRules, renderToSVG: renderToSVG };