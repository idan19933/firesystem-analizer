// dxf-analyzer.js v4 - Optimized for 1M+ entity DXF files
const fs = require('fs');
const readline = require('readline');

// ============ STREAMING PARSER ============
// Process DXF file line-by-line without loading entire token array into memory

async function parseDXFStreaming(filePath) {
  return new Promise((resolve, reject) => {
    console.log('  Starting streaming parse...');

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    // State machine
    let lineNum = 0;
    let pendingCode = null;
    let currentSection = null;
    let sectionName = null;
    let inBlock = false;
    let currentBlockName = null;
    let currentBlockBaseX = 0;
    let currentBlockBaseY = 0;
    let blockEntities = [];

    // Storage - only keep what we need
    const blocks = {};
    const entities = [];
    const layers = {};

    // Entity parsing state
    let parsingEntity = false;
    let entityType = null;
    let entityData = {};
    let entityVerts = [];
    let curVx = null;

    // Debug: track first entities for layer debugging
    let debugEntities = [];
    const DEBUG_LIMIT = 20;

    // Track section boundaries
    let afterSectionMarker = false;
    let expectSectionName = false;

    // Layers parsing state
    let parsingLayer = false;
    let layerData = {};

    const ENTITY_TYPES = new Set(['LINE', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'INSERT', 'LWPOLYLINE', 'POLYLINE', 'SOLID', 'ELLIPSE', 'POINT', 'SPLINE']);

    function finalizeEntity() {
      if (!parsingEntity || !entityType) return;

      // Finalize polyline vertices
      if ((entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') && curVx !== null) {
        entityVerts.push({ x: curVx, y: 0 });
      }
      if (entityVerts.length > 0) {
        entityData.vertices = entityVerts;
      }

      entityData.type = entityType;

      // Debug: capture first entities
      if (debugEntities.length < DEBUG_LIMIT) {
        debugEntities.push({
          type: entityData.type,
          layer: entityData.layer || '(none)',
          text: entityData.text || null,
          blockName: entityData.blockName || null
        });
      }

      if (inBlock && currentBlockName) {
        blockEntities.push(entityData);
      } else if (currentSection === 'ENTITIES') {
        entities.push(entityData);
      }

      // Reset
      parsingEntity = false;
      entityType = null;
      entityData = {};
      entityVerts = [];
      curVx = null;
    }

    function processToken(code, value) {
      // Section handling
      if (code === 0) {
        if (value === 'SECTION') {
          afterSectionMarker = true;
          expectSectionName = true;
          return;
        }
        if (value === 'ENDSEC') {
          finalizeEntity();
          currentSection = null;
          return;
        }
        if (value === 'EOF') {
          finalizeEntity();
          return;
        }

        // Block handling
        if (currentSection === 'BLOCKS') {
          if (value === 'BLOCK') {
            finalizeEntity();
            inBlock = true;
            currentBlockName = null;
            currentBlockBaseX = 0;
            currentBlockBaseY = 0;
            blockEntities = [];
            return;
          }
          if (value === 'ENDBLK') {
            finalizeEntity();
            if (currentBlockName) {
              blocks[currentBlockName] = {
                entities: blockEntities,
                baseX: currentBlockBaseX,
                baseY: currentBlockBaseY
              };
            }
            inBlock = false;
            currentBlockName = null;
            blockEntities = [];
            return;
          }
        }

        // Layer handling in TABLES
        if (currentSection === 'TABLES') {
          if (value === 'LAYER') {
            parsingLayer = true;
            layerData = { name: '', color: 7, ltype: 'CONTINUOUS' };
            return;
          }
          if (parsingLayer && value !== 'LAYER') {
            // End of layer definition
            if (layerData.name) {
              layers[layerData.name] = { color: layerData.color, ltype: layerData.ltype };
            }
            parsingLayer = false;
            layerData = {};
          }
        }

        // Entity parsing
        if (ENTITY_TYPES.has(value)) {
          finalizeEntity();
          parsingEntity = true;
          entityType = value;
          entityData = {};
          entityVerts = [];
          curVx = null;
        } else {
          finalizeEntity();
        }
        return;
      }

      // Section name capture
      if (expectSectionName && code === 2) {
        currentSection = value;
        sectionName = value;
        expectSectionName = false;
        afterSectionMarker = false;
        return;
      }

      // Block properties
      if (inBlock && !parsingEntity) {
        if (code === 2) currentBlockName = value;
        else if (code === 10) currentBlockBaseX = parseFloat(value);
        else if (code === 20) currentBlockBaseY = parseFloat(value);
        return;
      }

      // Layer properties
      if (parsingLayer) {
        if (code === 2) layerData.name = value;
        else if (code === 62) layerData.color = parseInt(value);
        else if (code === 6) layerData.ltype = value;
        return;
      }

      // Entity properties
      if (parsingEntity) {
        if (code === 8) entityData.layer = value;
        else if (code === 6) entityData.linetype = value;
        else if (code === 62) entityData.color = parseInt(value);
        else if (code === 10) {
          if (entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') {
            if (curVx !== null) entityVerts.push({ x: curVx, y: 0 });
            curVx = parseFloat(value);
          } else {
            entityData.x = parseFloat(value);
          }
        }
        else if (code === 20) {
          if ((entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') && curVx !== null) {
            entityVerts.push({ x: curVx, y: parseFloat(value) });
            curVx = null;
          } else {
            entityData.y = parseFloat(value);
          }
        }
        else if (code === 11) entityData.x2 = parseFloat(value);
        else if (code === 21) entityData.y2 = parseFloat(value);
        else if (code === 40) { entityData.radius = parseFloat(value); entityData.height = parseFloat(value); }
        else if (code === 41) entityData.scaleX = parseFloat(value);
        else if (code === 42) entityData.scaleY = parseFloat(value);
        else if (code === 50) { entityData.startAngle = parseFloat(value); entityData.rotation = parseFloat(value); }
        else if (code === 51) entityData.endAngle = parseFloat(value);
        else if (code === 1) entityData.text = value;
        else if (code === 2) entityData.blockName = value;
        else if (code === 70) entityData.flags = parseInt(value);
      }
    }

    rl.on('line', (line) => {
      lineNum++;
      const trimmed = line.trim();

      if (pendingCode === null) {
        const code = parseInt(trimmed);
        if (!isNaN(code)) {
          pendingCode = code;
        }
      } else {
        processToken(pendingCode, trimmed);
        pendingCode = null;
      }
    });

    rl.on('close', () => {
      finalizeEntity();

      // Debug output: first 20 entities
      console.log('  DEBUG: First ' + debugEntities.length + ' entities:');
      debugEntities.forEach((e, i) => {
        console.log('    [' + i + '] type=' + e.type + ', layer=' + e.layer + (e.text ? ', text=' + e.text.substring(0, 30) : '') + (e.blockName ? ', block=' + e.blockName : ''));
      });

      console.log('  Raw parse complete: ' + entities.length + ' entities, ' + Object.keys(blocks).length + ' blocks, ' + Object.keys(layers).length + ' layers');

      // Expand block references
      const expanded = [];
      function expand(ents, ox, oy, sx, sy, depth) {
        if (depth > 5) return;
        for (let i = 0; i < ents.length; i++) {
          const ent = ents[i];
          if (ent.type === 'INSERT' && blocks[ent.blockName]) {
            const b = blocks[ent.blockName];
            const isx = (ent.scaleX || 1) * sx;
            const isy = (ent.scaleY || 1) * sy;
            expand(b.entities, (ent.x || 0) + ox - b.baseX * isx, (ent.y || 0) + oy - b.baseY * isy, isx, isy, depth + 1);
          } else {
            const e = {};
            for (const key in ent) e[key] = ent[key];
            if (e.x !== undefined) { e.x = e.x * sx + ox; e.y = (e.y || 0) * sy + oy; }
            if (e.x2 !== undefined) { e.x2 = e.x2 * sx + ox; e.y2 = (e.y2 || 0) * sy + oy; }
            if (e.radius !== undefined) e.radius = e.radius * Math.abs(sx);
            if (e.vertices) e.vertices = e.vertices.map(v => ({ x: v.x * sx + ox, y: v.y * sy + oy }));
            expanded.push(e);
          }
        }
      }
      expand(entities, 0, 0, 1, 1, 0);

      console.log('  Expanded: ' + expanded.length + ' entities');

      resolve({
        entities: expanded,
        blocks: blocks,
        layers: layers,
        raw: entities,
        blockCount: Object.keys(blocks).length
      });
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

// ============ CLASSIFIER ============
function classifyEntities(parsed) {
  const C = {
    walls: [], doors: [], fireDoors: [], windows: [], stairs: [], elevators: [],
    corridors: [], rooms: [], exits: [], sprinklers: [], smokeDetectors: [],
    heatDetectors: [], fireExtinguishers: [], hydrants: [], fireAlarmPanel: [],
    manualCallPoints: [], emergencyLights: [], exitSigns: [], smokeVents: [],
    fireWalls: [], accessRoads: [], texts: [], unknown: [],
    stats: { total: 0, classified: 0, byLayer: {}, byType: {} }
  };

  // Layer patterns - support Hebrew encoding variants
  const LP = {
    walls: /wall|קיר|A[-_]?WALL|^KIR$|WALL[-_]/i,
    doors: /^door|דלת|A[-_]?DOOR|^DELET$|DOOR[-_]/i,
    fireDoors: /fire.?door|דלת.?אש|FD[-_]/i,
    windows: /window|חלון|^HALON$|WIN[-_]/i,
    stairs: /stair|מדרגות|^MADREGOT$|STAIR[-_]/i,
    elevators: /elev|lift|מעלית|^MAALIT$|ELEV[-_]/i,
    sprinklers: /sprink|מתז|ספרינק|FIRE[-_]S|SPR[-_]/i,
    smokeDetectors: /smoke.?det|גלאי.?עשן|SD[-_]|SMOKE/i,
    heatDetectors: /heat.?det|גלאי.?חום|HD[-_]|HEAT/i,
    fireExtinguishers: /exting|מטפ|FE[-_]|EXTINGUISH/i,
    hydrants: /hydrant|ברז.?כיבוי|הידרנט|IH[-_]|FH[-_]|HYD/i,
    fireAlarmPanel: /alarm.?panel|רכזת|PANEL/i,
    manualCallPoints: /call.?point|MCP/i,
    emergencyLights: /emerg.?light|תאורת.?חירום|EC[-_]|EMERG/i,
    exitSigns: /exit.?sign|שלט.?יציאה|EXIT[-_]S/i,
    smokeVents: /smoke.?vent|שחרור.?עשן|SV[-_]|VENT/i,
    fireWalls: /fire.?wall|קיר.?אש|FIRE[-_]W|FW[-_]/i,
    accessRoads: /access|גישה|FIRE[-_]ACC|^KVISH$|^DEREH|ROAD/i
  };

  const TP = {
    doors: /door|דלת/i,
    fireDoors: /fire.?door|דלת.?אש|FD[-_]?\d/i,
    exits: /exit|יציאה|מוצא/i,
    stairs: /stair|מדרגות/i,
    sprinklers: /^S$|sprink|מתז/i,
    smokeDetectors: /^SD$|גלאי.?עשן/i,
    fireExtinguishers: /^FE$|מטפ/i,
    hydrants: /^IH$|^EH$|הידרנט|ברז/i,
    emergencyLights: /^EC$|חירום/i,
    exitSigns: /^EXIT$/i,
    smokeVents: /^SV$/i,
    rooms: /office|משרד|חדר|room/i
  };

  const BP = {
    doors: /door|DR[-_]/i,
    fireDoors: /FD[-_]/i,
    sprinklers: /sprink|SPR[-_]/i,
    smokeDetectors: /SD[-_]|DETECT/i,
    fireExtinguishers: /FE[-_]/i,
    hydrants: /HYD[-_]|IH[-_]/i,
    stairs: /STAIR/i,
    elevators: /ELEV|LIFT/i,
    exitSigns: /EXIT/i
  };

  const lpKeys = Object.keys(LP);
  const tpKeys = Object.keys(TP);
  const bpKeys = Object.keys(BP);

  for (let i = 0; i < parsed.entities.length; i++) {
    const ent = parsed.entities[i];
    C.stats.total++;

    const layer = (ent.layer || '0').toUpperCase();
    C.stats.byLayer[layer] = (C.stats.byLayer[layer] || 0) + 1;
    C.stats.byType[ent.type] = (C.stats.byType[ent.type] || 0) + 1;

    let matched = false;

    // Match by layer name
    for (let li = 0; li < lpKeys.length && !matched; li++) {
      if (LP[lpKeys[li]].test(ent.layer || '')) {
        C[lpKeys[li]].push(ent);
        matched = true;
      }
    }

    // Match text content
    if (!matched && (ent.type === 'TEXT' || ent.type === 'MTEXT') && ent.text) {
      C.texts.push(ent);
      for (let ti = 0; ti < tpKeys.length && !matched; ti++) {
        if (TP[tpKeys[ti]].test(ent.text)) {
          C[tpKeys[ti]].push(ent);
          matched = true;
        }
      }
    }

    // Match by block name
    if (!matched && ent.type === 'INSERT' && ent.blockName) {
      for (let bi = 0; bi < bpKeys.length && !matched; bi++) {
        if (BP[bpKeys[bi]].test(ent.blockName)) {
          C[bpKeys[bi]].push(ent);
          matched = true;
        }
      }
    }

    // Only classify circles as sprinklers if on fire/system layer
    if (!matched && ent.type === 'CIRCLE' && ent.radius && ent.radius < 0.5) {
      const cl = (ent.layer || '0').toUpperCase();
      if (/FIRE|SPRINK|SYSTEM|מתז|ספרינק/i.test(cl) && cl !== '0') {
        C.sprinklers.push(ent);
        matched = true;
      }
    }

    if (!matched) C.unknown.push(ent);
    if (matched) C.stats.classified++;
  }

  // Log layer statistics
  const sortedLayers = Object.entries(C.stats.byLayer)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  console.log('  Top 20 layers by entity count:');
  sortedLayers.forEach(([name, count]) => {
    console.log('    ' + name + ': ' + count);
  });

  return C;
}

// ============ GEOMETRY ============
function analyzeGeometry(classified) {
  const G = {
    bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    totalArea: 0,
    maxTravelDistances: [],
    sprinklerSpacing: [],
    detectorSpacing: [],
    extinguisherSpacing: [],
    hydrantSpacing: []
  };

  const all = [].concat(classified.walls, classified.doors, classified.corridors);
  for (let i = 0; i < all.length; i++) {
    const ent = all[i];
    if (ent.x !== undefined) {
      G.bounds.minX = Math.min(G.bounds.minX, ent.x);
      G.bounds.maxX = Math.max(G.bounds.maxX, ent.x);
      G.bounds.minY = Math.min(G.bounds.minY, ent.y);
      G.bounds.maxY = Math.max(G.bounds.maxY, ent.y);
    }
    if (ent.x2 !== undefined) {
      G.bounds.minX = Math.min(G.bounds.minX, ent.x2);
      G.bounds.maxX = Math.max(G.bounds.maxX, ent.x2);
      G.bounds.minY = Math.min(G.bounds.minY, ent.y2);
      G.bounds.maxY = Math.max(G.bounds.maxY, ent.y2);
    }
  }

  if (G.bounds.minX !== Infinity) {
    G.totalArea = (G.bounds.maxX - G.bounds.minX) * (G.bounds.maxY - G.bounds.minY);
  }

  function computeSpacing(items) {
    const p = items.filter(e => e.x !== undefined).map(e => ({ x: e.x, y: e.y }));
    if (p.length < 2) return [];
    // Sample for large sets to avoid O(n^2)
    const sample = p.length > 1000 ? p.filter((_, i) => i % Math.ceil(p.length / 1000) === 0) : p;
    return sample.map((pt, i) => {
      let min = Infinity;
      for (let j = 0; j < sample.length; j++) {
        if (i !== j) {
          const d = Math.hypot(pt.x - sample[j].x, pt.y - sample[j].y);
          if (d < min) min = d;
        }
      }
      return min;
    }).filter(d => d < Infinity);
  }

  G.sprinklerSpacing = computeSpacing(classified.sprinklers);
  G.detectorSpacing = computeSpacing(classified.smokeDetectors);
  G.extinguisherSpacing = computeSpacing(classified.fireExtinguishers);
  G.hydrantSpacing = computeSpacing(classified.hydrants);

  const exits = [].concat(classified.exits, classified.stairs).filter(e => e.x !== undefined);
  if (exits.length > 0 && G.bounds.minX !== Infinity) {
    const sx = (G.bounds.maxX - G.bounds.minX) / 10 || 1;
    const sy = (G.bounds.maxY - G.bounds.minY) / 10 || 1;
    for (let x = G.bounds.minX; x <= G.bounds.maxX; x += sx) {
      for (let y = G.bounds.minY; y <= G.bounds.maxY; y += sy) {
        let min = Infinity;
        exits.forEach(e => {
          const d = Math.hypot(x - e.x, y - e.y);
          if (d < min) min = d;
        });
        G.maxTravelDistances.push(min);
      }
    }
  }

  return G;
}

// ============ RULES ============
function checkFireSafetyRules(classified, geometry) {
  const R = {
    overallScore: 0,
    overallStatus: 'דורש_בדיקה',
    buildingType: 'מבנה',
    categories: [],
    criticalIssues: [],
    summary: '',
    summaryHe: ''
  };

  const allText = classified.texts.map(t => t.text || '').join(' ');
  if (/office|משרד/i.test(allText)) R.buildingType = 'מבנה משרדים';
  else if (/resid|מגור/i.test(allText)) R.buildingType = 'מבנה מגורים';

  const scores = [];
  const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

  // Category 1: Access Roads
  const ac = classified.accessRoads.length;
  let s1 = ac > 0 ? 70 : 20;
  R.categories.push({
    id: 1, nameHe: 'דרכי גישה',
    status: ac > 0 ? 'דורש_בדיקה' : 'נכשל',
    score: s1,
    findings: [ac + ' אלמנטי גישה'],
    recommendations: ac === 0 ? ['לסמן דרך גישה 3.5מ'] : []
  });
  scores.push(s1);

  // Category 2: Escape Routes
  const exitC = classified.exits.length + classified.stairs.length;
  const maxT = geometry.maxTravelDistances.length ? Math.max(...geometry.maxTravelDistances) : null;
  let s2 = 50;
  const f2 = ['יציאות: ' + classified.exits.length, 'מדרגות: ' + classified.stairs.length, 'דלתות: ' + classified.doors.length + ' (אש: ' + classified.fireDoors.length + ')'];
  const r2 = [];
  if (exitC >= 2) { s2 += 30; f2.push('2+ יציאות'); }
  else { r2.push('נדרשות 2 יציאות'); R.criticalIssues.push('פחות מ-2 יציאות'); }
  if (maxT !== null) {
    f2.push('מרחק מילוט: ' + maxT.toFixed(1) + 'מ');
    if (maxT > 40) { s2 -= 20; r2.push('מרחק>40מ'); }
  }
  if (classified.fireDoors.length > 0) s2 += 10;
  else r2.push('לסמן דלתות אש');
  R.categories.push({
    id: 2, nameHe: 'דרכי מילוט ויציאות',
    status: s2 >= 70 ? 'עובר' : s2 >= 40 ? 'דורש_בדיקה' : 'נכשל',
    score: Math.min(100, Math.max(0, s2)),
    findings: f2, recommendations: r2
  });
  scores.push(s2);

  // Category 3: Detection System
  let s3 = 20;
  if (classified.smokeDetectors.length > 0) s3 += 25;
  if (classified.heatDetectors.length > 0) s3 += 10;
  if (classified.manualCallPoints.length > 0) s3 += 15;
  if (classified.fireAlarmPanel.length > 0) s3 += 15;
  const ad = avg(geometry.detectorSpacing);
  const f3 = ['גלאי עשן: ' + classified.smokeDetectors.length, 'גלאי חום: ' + classified.heatDetectors.length];
  if (ad) f3.push('מרחק גלאים: ' + ad.toFixed(1) + 'מ');
  R.categories.push({
    id: 3, nameHe: 'מערכת גילוי',
    status: s3 >= 70 ? 'עובר' : s3 >= 40 ? 'דורש_בדיקה' : 'נכשל',
    score: Math.min(100, s3),
    findings: f3,
    recommendations: classified.smokeDetectors.length === 0 ? ['להוסיף גלאי עשן'] : []
  });
  scores.push(s3);

  // Category 4: Sprinkler System
  let s4 = classified.sprinklers.length > 0 ? 50 : 10;
  const aspr = avg(geometry.sprinklerSpacing);
  if (aspr && aspr <= 4.5) s4 += 30;
  if (classified.sprinklers.length > 5) s4 += 10;
  const f4 = ['מתזים: ' + classified.sprinklers.length];
  if (aspr) f4.push('מרחק: ' + aspr.toFixed(1) + 'מ');
  R.categories.push({
    id: 4, nameHe: 'מערכת מתזים',
    status: s4 >= 70 ? 'עובר' : s4 >= 40 ? 'דורש_בדיקה' : 'נכשל',
    score: Math.min(100, s4),
    findings: f4,
    recommendations: classified.sprinklers.length === 0 ? ['לבדוק חובת מתזים'] : []
  });
  scores.push(s4);

  // Category 5: Fire Fighting Equipment
  let s5 = 20;
  if (classified.fireExtinguishers.length > 0) s5 += 25;
  if (classified.hydrants.length > 0) s5 += 25;
  const afe = avg(geometry.extinguisherSpacing);
  const aih = avg(geometry.hydrantSpacing);
  if (afe && afe <= 25) s5 += 15;
  if (aih && aih <= 30) s5 += 15;
  const f5 = ['מטפים: ' + classified.fireExtinguishers.length, 'ברזי כיבוי: ' + classified.hydrants.length];
  const r5 = [];
  if (classified.fireExtinguishers.length === 0) r5.push('להוסיף מטפים');
  if (classified.hydrants.length === 0) r5.push('להוסיף ברזים');
  R.categories.push({
    id: 5, nameHe: 'ציוד כיבוי',
    status: s5 >= 70 ? 'עובר' : s5 >= 40 ? 'דורש_בדיקה' : 'נכשל',
    score: Math.min(100, s5),
    findings: f5, recommendations: r5
  });
  scores.push(s5);

  // Category 6: Fire Separation
  let s6 = 30;
  if (classified.fireWalls.length > 0) s6 += 30;
  if (classified.fireDoors.length > 0) s6 += 20;
  R.categories.push({
    id: 6, nameHe: 'הפרדות אש',
    status: s6 >= 70 ? 'עובר' : s6 >= 40 ? 'דורש_בדיקה' : 'נכשל',
    score: s6,
    findings: ['קירות אש: ' + classified.fireWalls.length, 'דלתות אש: ' + classified.fireDoors.length],
    recommendations: classified.fireWalls.length === 0 ? ['לסמן קירות אש'] : []
  });
  scores.push(s6);

  // Category 7: Emergency Lighting
  let s7 = 20;
  if (classified.emergencyLights.length > 0) s7 += 30;
  if (classified.exitSigns.length > 0) s7 += 30;
  R.categories.push({
    id: 7, nameHe: 'תאורת חירום ושילוט',
    status: s7 >= 70 ? 'עובר' : s7 >= 40 ? 'דורש_בדיקה' : 'נכשל',
    score: s7,
    findings: ['תאורת חירום: ' + classified.emergencyLights.length, 'שלטי יציאה: ' + classified.exitSigns.length],
    recommendations: []
  });
  scores.push(s7);

  // Category 8: Smoke Control
  const sv = classified.smokeVents.length;
  let s8 = sv > 0 ? 60 : 15;
  R.categories.push({
    id: 8, nameHe: 'שליטה בעשן',
    status: s8 >= 60 ? 'דורש_בדיקה' : 'נכשל',
    score: s8,
    findings: ['פתחי עשן: ' + sv],
    recommendations: sv === 0 ? ['מערכת שחרור עשן'] : []
  });
  scores.push(s8);

  // Category 9: Documentation
  let s9 = 20;
  if (classified.texts.some(t => /plan|תוכנית/i.test(t.text || ''))) s9 += 20;
  if (classified.texts.some(t => /scale|קנה|1:/i.test(t.text || ''))) s9 += 20;
  R.categories.push({
    id: 9, nameHe: 'תיעוד',
    status: s9 >= 70 ? 'עובר' : s9 >= 40 ? 'דורש_בדיקה' : 'נכשל',
    score: Math.min(100, s9),
    findings: ['טקסטים: ' + classified.texts.length, 'שכבות: ' + Object.keys(classified.stats.byLayer).length],
    recommendations: []
  });
  scores.push(s9);

  R.overallScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  R.overallStatus = R.overallScore >= 70 ? 'עובר' : R.overallScore >= 40 ? 'דורש_בדיקה' : 'נכשל';
  R.summary = 'ניתוח: ' + classified.stats.total + ' אלמנטים (' + classified.stats.classified + ' מסווגים). ציון: ' + R.overallScore + '/100.';
  R.summaryHe = R.summary;

  return R;
}

// ============ SMART BOUNDS (IQR) ============
function computeSmartBounds(entities, maxSample) {
  maxSample = maxSample || 100000;

  // Sample entities if too many
  let sample = entities;
  if (entities.length > maxSample) {
    const step = Math.ceil(entities.length / maxSample);
    sample = entities.filter((_, i) => i % step === 0);
    console.log('  Bounds sampling: ' + entities.length + ' → ' + sample.length);
  }

  const xs = [], ys = [];
  const skipLayers = /^LOGO$|^IDAN_|^TR_|^POINTS|^ZAFON$/i;

  for (let i = 0; i < sample.length; i++) {
    const e = sample[i];
    const layer = (e.layer || '').toUpperCase();
    if (skipLayers.test(layer)) continue;
    if (e.type === 'POINT') continue;

    if (e.type === 'LINE' && e.x !== undefined && e.x2 !== undefined) {
      xs.push(e.x, e.x2);
      ys.push(e.y, e.y2);
    } else if ((e.type === 'CIRCLE' || e.type === 'ARC') && e.x !== undefined) {
      xs.push(e.x);
      ys.push(e.y);
    } else if ((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && e.vertices && e.vertices.length > 0) {
      // Sample vertices for large polylines
      const verts = e.vertices.length > 100 ? e.vertices.filter((_, i) => i % Math.ceil(e.vertices.length / 100) === 0) : e.vertices;
      verts.forEach(v => { xs.push(v.x); ys.push(v.y); });
    }
  }

  if (xs.length < 4) {
    for (let i2 = 0; i2 < sample.length; i2++) {
      const e2 = sample[i2];
      if (e2.x !== undefined) { xs.push(e2.x); ys.push(e2.y); }
      if (e2.x2 !== undefined) { xs.push(e2.x2); ys.push(e2.y2); }
    }
  }

  if (xs.length === 0) return { minX: 0, maxX: 100, minY: 0, maxY: 100 };

  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);

  const q1x = xs[Math.floor(xs.length * 0.25)];
  const q3x = xs[Math.floor(xs.length * 0.75)];
  const iqrX = q3x - q1x;
  const q1y = ys[Math.floor(ys.length * 0.25)];
  const q3y = ys[Math.floor(ys.length * 0.75)];
  const iqrY = q3y - q1y;

  let minX = q1x - 1.5 * iqrX;
  let maxX = q3x + 1.5 * iqrX;
  let minY = q1y - 1.5 * iqrY;
  let maxY = q3y + 1.5 * iqrY;

  const p5x = xs[Math.floor(xs.length * 0.10)];
  const p95x = xs[Math.floor(xs.length * 0.90)];
  const p5y = ys[Math.floor(ys.length * 0.10)];
  const p95y = ys[Math.floor(ys.length * 0.90)];
  minX = Math.min(minX, p5x);
  maxX = Math.max(maxX, p95x);
  minY = Math.min(minY, p5y);
  maxY = Math.max(maxY, p95y);

  if (maxX - minX < 1) { minX -= 50; maxX += 50; }
  if (maxY - minY < 1) { minY -= 50; maxY += 50; }

  const padX = (maxX - minX) * 0.05;
  const padY = (maxY - minY) * 0.05;

  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

// ============ SVG RENDERER (OPTIMIZED) ============
function renderToSVG(entities, classified, width) {
  width = width || 4000;
  const MAX_RENDER_ENTITIES = 300000;

  // Downsample if too many entities
  let entitiesToRender = entities;
  if (entities.length > MAX_RENDER_ENTITIES) {
    const step = Math.ceil(entities.length / MAX_RENDER_ENTITIES);
    entitiesToRender = entities.filter((_, i) => i % step === 0);
    console.log('  Downsampled for rendering: ' + entities.length + ' → ' + entitiesToRender.length);
  }

  const bounds = computeSmartBounds(entitiesToRender);
  const minX = bounds.minX, maxX = bounds.maxX, minY = bounds.minY, maxY = bounds.maxY;

  console.log('  Bounds: X[' + minX.toFixed(1) + ', ' + maxX.toFixed(1) + '] Y[' + minY.toFixed(1) + ', ' + maxY.toFixed(1) + ']');

  const dW = maxX - minX || 1, dH = maxY - minY || 1;
  const legH = 80;
  let imgH = Math.max(400, Math.round(width * (dH / dW)));
  if (imgH > width * 3) imgH = width * 3;
  const totalH = imgH + legH;
  const scale = Math.min(width / dW, imgH / dH) * 0.95;
  const offX = (width - dW * scale) / 2;
  const offY = (imgH - dH * scale) / 2;

  const tx = (x) => ((x - minX) * scale + offX).toFixed(2);
  const ty = (y) => (imgH - ((y - minY) * scale + offY)).toFixed(2);

  const mSize = Math.max(3, Math.min(12, dW * scale / 150));

  const COL = {
    walls: '#1a1a2e', doors: '#16a34a', fireDoors: '#dc2626', stairs: '#0891b2',
    sprinklers: '#2563eb', smokeDetectors: '#f59e0b', heatDetectors: '#ea580c',
    fireExtinguishers: '#e11d48', hydrants: '#b91c1c', emergencyLights: '#eab308',
    exitSigns: '#22c55e', smokeVents: '#8b5cf6', fireWalls: '#ff0000',
    exits: '#15803d', windows: '#06b6d4', unknown: '#94a3b8'
  };

  // Build style map for classified entities
  const styles = new Map();
  classified.walls.forEach(e => styles.set(e, { c: COL.walls, w: 2.0 }));
  classified.doors.forEach(e => styles.set(e, { c: COL.doors, w: 2.5 }));
  classified.fireDoors.forEach(e => styles.set(e, { c: COL.fireDoors, w: 3, d: '6,3' }));
  classified.stairs.forEach(e => styles.set(e, { c: COL.stairs, w: 2 }));
  classified.fireWalls.forEach(e => styles.set(e, { c: COL.fireWalls, w: 3.5, d: '10,5' }));
  classified.exits.forEach(e => styles.set(e, { c: COL.exits, w: 2.5 }));
  classified.windows.forEach(e => styles.set(e, { c: COL.windows, w: 1.5 }));

  // Track marker entities
  const markerSet = new Set();
  [classified.sprinklers, classified.smokeDetectors, classified.heatDetectors,
   classified.fireExtinguishers, classified.hydrants, classified.emergencyLights,
   classified.exitSigns, classified.smokeVents].forEach(arr => arr.forEach(e => markerSet.add(e)));

  const renderSkip = /^LOGO$|^IDAN_CROSS$|^POINTS$|^POINTS_BETON$/i;

  // Use array and join for efficient string building
  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + totalH + '" viewBox="0 0 ' + width + ' ' + totalH + '">');
  parts.push('<rect width="100%" height="100%" fill="#fafbfc"/>');
  parts.push('<rect x="4" y="4" width="' + (width - 8) + '" height="' + (imgH - 8) + '" fill="white" stroke="#e2e8f0" rx="4"/>');
  parts.push('<defs><style>text{font-family:Arial,sans-serif}</style></defs>');

  // Draw geometry
  for (let i = 0; i < entitiesToRender.length; i++) {
    const ent = entitiesToRender[i];
    if (markerSet.has(ent)) continue;
    const entLayer = (ent.layer || '').toUpperCase();
    if (renderSkip.test(entLayer)) continue;

    const s = styles.get(ent);
    const col = s ? s.c : COL.unknown;
    const w = s ? s.w : 0.7;
    const dash = s && s.d ? ' stroke-dasharray="' + s.d + '"' : '';

    if (ent.type === 'LINE' && ent.x !== undefined && ent.x2 !== undefined) {
      parts.push('<line x1="' + tx(ent.x) + '" y1="' + ty(ent.y) + '" x2="' + tx(ent.x2) + '" y2="' + ty(ent.y2) + '" stroke="' + col + '" stroke-width="' + w + '"' + dash + ' stroke-linecap="round"/>');
    } else if (ent.type === 'CIRCLE' && ent.radius) {
      const r = Math.max(ent.radius * scale, 1);
      parts.push('<circle cx="' + tx(ent.x) + '" cy="' + ty(ent.y) + '" r="' + r.toFixed(1) + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"/>');
    } else if (ent.type === 'ARC' && ent.radius) {
      const ra = Math.max(ent.radius * scale, 1);
      const sa = (ent.startAngle || 0) * Math.PI / 180;
      const ea = (ent.endAngle || 360) * Math.PI / 180;
      const ax1 = tx(ent.x + ent.radius * Math.cos(sa));
      const ay1 = ty(ent.y + ent.radius * Math.sin(sa));
      const ax2 = tx(ent.x + ent.radius * Math.cos(ea));
      const ay2 = ty(ent.y + ent.radius * Math.sin(ea));
      const la = ((ent.endAngle || 360) - (ent.startAngle || 0) + 360) % 360 > 180 ? 1 : 0;
      parts.push('<path d="M' + ax1 + ',' + ay1 + ' A' + ra + ',' + ra + ' 0 ' + la + ',0 ' + ax2 + ',' + ay2 + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"/>');
    } else if ((ent.type === 'TEXT' || ent.type === 'MTEXT') && ent.text && ent.x !== undefined) {
      let fs = Math.max((ent.height || 0.3) * scale * 0.55, 5);
      if (fs > 40) fs = 40;
      const esc = ent.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      parts.push('<text x="' + tx(ent.x) + '" y="' + ty(ent.y) + '" font-size="' + fs.toFixed(1) + '" fill="#4b5563">' + esc + '</text>');
    } else if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices && ent.vertices.length > 1) {
      const pts = ent.vertices.map(v => tx(v.x) + ',' + ty(v.y)).join(' ');
      parts.push('<polyline points="' + pts + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"' + dash + '/>');
    }
  }

  // Fire safety markers
  function drawMarkers(items, color, shape) {
    for (let mi = 0; mi < items.length; mi++) {
      const e = items[mi];
      if (e.x === undefined) continue;
      const cx = parseFloat(tx(e.x)), cy = parseFloat(ty(e.y));
      if (cx < 0 || cx > width || cy < 0 || cy > imgH) continue;

      if (shape === 'c') {
        parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + mSize + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>');
      } else if (shape === 'r') {
        parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + mSize + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>');
        parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (mSize * 0.35) + '" fill="none" stroke="white" stroke-width="0.5"/>');
      } else if (shape === 's') {
        parts.push('<rect x="' + (cx - mSize) + '" y="' + (cy - mSize) + '" width="' + (mSize * 2) + '" height="' + (mSize * 2) + '" fill="' + color + '" stroke="white" stroke-width="0.7" rx="1" opacity="0.85"/>');
      } else if (shape === 'd') {
        parts.push('<polygon points="' + cx + ',' + (cy - mSize) + ' ' + (cx + mSize) + ',' + cy + ' ' + cx + ',' + (cy + mSize) + ' ' + (cx - mSize) + ',' + cy + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>');
      } else if (shape === 't') {
        parts.push('<polygon points="' + cx + ',' + (cy - mSize) + ' ' + (cx + mSize) + ',' + (cy + mSize * 0.7) + ' ' + (cx - mSize) + ',' + (cy + mSize * 0.7) + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>');
      }
    }
  }

  drawMarkers(classified.sprinklers, COL.sprinklers, 'c');
  drawMarkers(classified.smokeDetectors, COL.smokeDetectors, 'r');
  drawMarkers(classified.heatDetectors, COL.heatDetectors, 'r');
  drawMarkers(classified.fireExtinguishers, COL.fireExtinguishers, 's');
  drawMarkers(classified.hydrants, COL.hydrants, 's');
  drawMarkers(classified.emergencyLights, COL.emergencyLights, 'd');
  drawMarkers(classified.exitSigns, COL.exitSigns, 't');
  drawMarkers(classified.smokeVents, COL.smokeVents, 'd');

  // Legend
  const ly = imgH + 6;
  parts.push('<rect x="4" y="' + ly + '" width="' + (width - 8) + '" height="' + (legH - 10) + '" fill="white" stroke="#e2e8f0" rx="4"/>');
  parts.push('<text x="' + (width / 2) + '" y="' + (ly + 18) + '" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">מקרא - Legend</text>');

  const legendItems = [
    [COL.walls, 'קירות'], [COL.doors, 'דלתות'], [COL.fireDoors, 'דלתות אש'],
    [COL.stairs, 'מדרגות'], [COL.sprinklers, 'מתזים'], [COL.smokeDetectors, 'גלאי עשן'],
    [COL.fireExtinguishers, 'מטפים'], [COL.hydrants, 'ברזי כיבוי'],
    [COL.emergencyLights, 'תאורת חירום'], [COL.exitSigns, 'שלטי יציאה'],
    [COL.fireWalls, 'קירות אש'], [COL.smokeVents, 'פתחי עשן']
  ];

  const nc = 6, iw = (width - 40) / nc;
  for (let idx = 0; idx < legendItems.length; idx++) {
    const c2 = idx % nc, r2 = Math.floor(idx / nc);
    const lx = 20 + c2 * iw, liy = ly + 30 + r2 * 20;
    parts.push('<rect x="' + lx + '" y="' + liy + '" width="12" height="12" fill="' + legendItems[idx][0] + '" rx="2"/>');
    parts.push('<text x="' + (lx + 18) + '" y="' + (liy + 10) + '" fill="#374151" font-size="10">' + legendItems[idx][1] + '</text>');
  }

  parts.push('</svg>');

  // Join once at the end
  return parts.join('\n');
}

// ============ MAIN ============
async function analyzeDXF(filePath) {
  console.log('Vector DXF analysis v4 (optimized for 1M+ entities)...');

  // Use streaming parser
  const parsed = await parseDXFStreaming(filePath);
  console.log('  Entities: ' + parsed.entities.length + ', Blocks: ' + parsed.blockCount + ', Layers: ' + Object.keys(parsed.layers).length);

  // Classify
  const classified = classifyEntities(parsed);
  console.log('  Classified: ' + classified.stats.classified + '/' + classified.stats.total);

  // Analyze geometry
  const geometry = analyzeGeometry(classified);

  // Check fire safety rules
  const analysis = checkFireSafetyRules(classified, geometry);

  // Keep reference to entities for SVG rendering
  const entitiesForRender = parsed.entities;

  // Free raw data before heavy SVG rendering
  parsed.raw = null;

  // Render SVG (downsampled if needed)
  const svg = renderToSVG(entitiesForRender, classified, 4000);
  console.log('  SVG generated: ' + (svg.length / 1024).toFixed(0) + 'KB');

  // Convert to PNG
  let pngBuffer = null;
  try {
    const sharp = require('sharp');
    pngBuffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
    console.log('  PNG: ' + (pngBuffer.length / 1024).toFixed(0) + 'KB');
  } catch (e) {
    console.log('  sharp unavailable: ' + e.message);
  }

  // Free entities after rendering
  parsed.entities = null;

  return {
    analysis: analysis,
    svg: svg,
    pngBuffer: pngBuffer,
    parsed: {
      entityCount: entitiesForRender.length,
      blockCount: parsed.blockCount,
      layerCount: Object.keys(parsed.layers).length,
      layers: parsed.layers
    },
    vectorData: {
      layers: Object.keys(classified.stats.byLayer),
      entityTypes: classified.stats.byType,
      summary: {
        walls: classified.walls.length,
        doors: classified.doors.length,
        fireDoors: classified.fireDoors.length,
        stairs: classified.stairs.length,
        exits: classified.exits.length,
        sprinklers: classified.sprinklers.length,
        smokeDetectors: classified.smokeDetectors.length,
        fireExtinguishers: classified.fireExtinguishers.length,
        hydrants: classified.hydrants.length,
        emergencyLights: classified.emergencyLights.length,
        exitSigns: classified.exitSigns.length,
        smokeVents: classified.smokeVents.length,
        fireWalls: classified.fireWalls.length,
        texts: classified.texts.length
      }
    }
  };
}

module.exports = {
  analyzeDXF,
  parseDXFStreaming,
  classifyEntities,
  analyzeGeometry,
  checkFireSafetyRules,
  renderToSVG
};
