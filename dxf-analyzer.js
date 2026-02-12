// dxf-analyzer.js v8 - Rendering only, Claude Vision does the analysis
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// Hard limits to prevent OOM
const MAX_ENTITIES_AFTER_EXPANSION = 500000;
const MAX_ENTITIES_FOR_SVG = 200000;

// ============ STREAMING PARSER ============
async function parseDXFStreaming(filePath) {
  return new Promise((resolve, reject) => {
    console.log('  Starting streaming parse v7 (geometry-based)...');

    const fileStream = fs.createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 64 * 1024
    });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let pendingCode = null;
    let currentSection = null;
    let inBlock = false;
    let currentBlockName = null;
    let currentBlockBaseX = 0;
    let currentBlockBaseY = 0;
    let blockEntities = [];

    const blocks = {};
    const entities = [];
    const layers = {};

    let parsingEntity = false;
    let entityType = null;
    let entityData = {};
    let entityVerts = [];
    let curVx = null;

    let expectSectionName = false;
    let parsingLayer = false;
    let layerData = {};

    const ENTITY_TYPES = new Set(['LINE', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'INSERT', 'LWPOLYLINE', 'POLYLINE', 'SOLID', 'ELLIPSE', 'POINT', 'SPLINE']);

    function finalizeEntity() {
      if (!parsingEntity || !entityType) return;

      if ((entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') && curVx !== null) {
        entityVerts.push({ x: curVx, y: 0 });
      }
      if (entityVerts.length > 0) {
        entityData.vertices = entityVerts;
      }

      entityData.type = entityType;

      if (inBlock && currentBlockName) {
        blockEntities.push(entityData);
      } else if (currentSection === 'ENTITIES') {
        entities.push(entityData);
      }

      parsingEntity = false;
      entityType = null;
      entityData = {};
      entityVerts = [];
      curVx = null;
    }

    function processToken(code, value) {
      if (code === 0) {
        if (value === 'SECTION') {
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
                entities: blockEntities.slice(), // Copy array
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

        if (currentSection === 'TABLES') {
          if (value === 'LAYER') {
            parsingLayer = true;
            layerData = { name: '', color: 7, ltype: 'CONTINUOUS' };
            return;
          }
          if (parsingLayer && value !== 'LAYER') {
            if (layerData.name) {
              layers[layerData.name] = { color: layerData.color, ltype: layerData.ltype };
            }
            parsingLayer = false;
            layerData = {};
          }
        }

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

      if (expectSectionName && code === 2) {
        currentSection = value;
        expectSectionName = false;
        return;
      }

      if (inBlock && !parsingEntity) {
        if (code === 2) currentBlockName = value;
        else if (code === 10) currentBlockBaseX = parseFloat(value);
        else if (code === 20) currentBlockBaseY = parseFloat(value);
        return;
      }

      if (parsingLayer) {
        if (code === 2) layerData.name = value;
        else if (code === 62) layerData.color = parseInt(value);
        else if (code === 6) layerData.ltype = value;
        return;
      }

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
      const trimmed = line.trim();
      if (pendingCode === null) {
        const code = parseInt(trimmed);
        if (!isNaN(code)) pendingCode = code;
      } else {
        processToken(pendingCode, trimmed);
        pendingCode = null;
      }
    });

    rl.on('close', () => {
      finalizeEntity();

      // ========== DEBUG: BLOCKS SECTION ==========
      const blockNames = Object.keys(blocks);
      console.log('\n  ===== DEBUG: BLOCKS SECTION =====');
      console.log('  Total blocks: ' + blockNames.length);

      blockNames.slice(0, 10).forEach(bname => {
        const b = blocks[bname];
        console.log('\n  BLOCK: "' + bname + '" (' + b.entities.length + ' entities, base: ' + b.baseX.toFixed(2) + ',' + b.baseY.toFixed(2) + ')');

        // Show first 10 entities in this block
        b.entities.slice(0, 10).forEach((ent, i) => {
          console.log('    [' + i + '] type=' + ent.type +
            ', layer="' + (ent.layer || '(none)') + '"' +
            (ent.text ? ', text="' + ent.text.substring(0, 20) + '"' : '') +
            (ent.blockName ? ', block="' + ent.blockName + '"' : ''));
        });
        if (b.entities.length > 10) {
          console.log('    ... and ' + (b.entities.length - 10) + ' more entities');
        }
      });

      // ========== DEBUG: LAYER TABLE ==========
      console.log('\n  ===== DEBUG: LAYER TABLE =====');
      const layerNames = Object.keys(layers);
      console.log('  Total layers defined: ' + layerNames.length);
      layerNames.slice(0, 30).forEach(lname => {
        const l = layers[lname];
        console.log('    Layer: "' + lname + '" color=' + l.color + ' ltype=' + l.ltype);
      });
      if (layerNames.length > 30) {
        console.log('    ... and ' + (layerNames.length - 30) + ' more layers');
      }

      // ========== DEBUG: INSERT ENTITIES ==========
      console.log('\n  ===== DEBUG: INSERT ENTITIES (before expansion) =====');
      const inserts = entities.filter(e => e.type === 'INSERT');
      console.log('  Total INSERT entities: ' + inserts.length);
      inserts.slice(0, 20).forEach((ins, i) => {
        console.log('    [' + i + '] block="' + ins.blockName +
          '", layer="' + (ins.layer || '0') +
          '", pos=(' + (ins.x || 0).toFixed(2) + ',' + (ins.y || 0).toFixed(2) + ')' +
          ', scale=(' + (ins.scaleX || 1) + ',' + (ins.scaleY || 1) + ')' +
          ', rot=' + (ins.rotation || 0));
      });
      if (inserts.length > 20) {
        console.log('    ... and ' + (inserts.length - 20) + ' more INSERTs');
      }

      console.log('\n  Raw parse: ' + entities.length + ' entities, ' +
        Object.keys(blocks).length + ' blocks, ' +
        Object.keys(layers).length + ' layers');

      // ========== BLOCK EXPANSION WITH LAYER INHERITANCE ==========
      const expanded = [];
      let expandedCount = 0;
      let truncated = false;

      // Track layer inheritance stats
      let inheritedLayers = 0;
      let ownLayers = 0;

      function expand(ents, ox, oy, sx, sy, depth, parentLayer) {
        if (depth > 5) return;
        if (truncated) return;

        for (let i = 0; i < ents.length; i++) {
          if (expandedCount >= MAX_ENTITIES_AFTER_EXPANSION) {
            truncated = true;
            console.log('  WARNING: Hit ' + MAX_ENTITIES_AFTER_EXPANSION + ' entity limit, truncating');
            return;
          }

          const ent = ents[i];

          if (ent.type === 'INSERT' && blocks[ent.blockName]) {
            const b = blocks[ent.blockName];
            const isx = (ent.scaleX || 1) * sx;
            const isy = (ent.scaleY || 1) * sy;

            // Pass down the INSERT's layer as parent layer for nested entities
            // If INSERT has layer "0", use the parent's layer instead
            const insertLayer = (ent.layer && ent.layer !== '0') ? ent.layer : parentLayer;

            expand(b.entities,
              (ent.x || 0) * sx + ox - b.baseX * isx,
              (ent.y || 0) * sy + oy - b.baseY * isy,
              isx, isy, depth + 1, insertLayer);
          } else {
            // CRITICAL: Determine the correct layer
            // Priority: entity's own layer (if not "0") > parent INSERT's layer > "0"
            let finalLayer;
            if (ent.layer && ent.layer !== '0') {
              finalLayer = ent.layer;
              ownLayers++;
            } else if (parentLayer && parentLayer !== '0') {
              finalLayer = parentLayer;
              inheritedLayers++;
            } else {
              finalLayer = ent.layer || '0';
            }

            const e = {
              type: ent.type,
              layer: finalLayer,
              linetype: ent.linetype,
              color: ent.color
            };

            if (ent.x !== undefined) {
              e.x = ent.x * sx + ox;
              e.y = (ent.y || 0) * sy + oy;
            }
            if (ent.x2 !== undefined) {
              e.x2 = ent.x2 * sx + ox;
              e.y2 = (ent.y2 || 0) * sy + oy;
            }
            if (ent.radius !== undefined) e.radius = ent.radius * Math.abs(sx);
            if (ent.text !== undefined) e.text = ent.text;
            if (ent.height !== undefined) e.height = ent.height;
            if (ent.blockName !== undefined) e.blockName = ent.blockName;
            if (ent.startAngle !== undefined) e.startAngle = ent.startAngle;
            if (ent.endAngle !== undefined) e.endAngle = ent.endAngle;
            if (ent.rotation !== undefined) e.rotation = ent.rotation;

            if (ent.vertices) {
              e.vertices = ent.vertices.map(v => ({
                x: v.x * sx + ox,
                y: v.y * sy + oy
              }));
            }

            expanded.push(e);
            expandedCount++;
          }
        }
      }

      // Start expansion with no parent layer
      expand(entities, 0, 0, 1, 1, 0, null);

      console.log('\n  ===== EXPANSION RESULTS =====');
      console.log('  Expanded: ' + expanded.length + ' entities' + (truncated ? ' (TRUNCATED)' : ''));
      console.log('  Entities with own layer: ' + ownLayers);
      console.log('  Entities inheriting parent layer: ' + inheritedLayers);

      // Debug: Show layer distribution after expansion
      const layerCounts = {};
      expanded.forEach(e => {
        const l = e.layer || '0';
        layerCounts[l] = (layerCounts[l] || 0) + 1;
      });
      const sortedLayers = Object.entries(layerCounts).sort((a, b) => b[1] - a[1]);
      console.log('\n  ===== LAYER DISTRIBUTION (after expansion) =====');
      console.log('  Unique layers: ' + sortedLayers.length);
      sortedLayers.slice(0, 30).forEach(([name, count]) => {
        console.log('    "' + name + '": ' + count);
      });

      // ========== DEBUG: ALL TEXT CONTENT ==========
      const allTexts = expanded
        .filter(e => e.type === 'TEXT' || e.type === 'MTEXT')
        .map(e => e.text)
        .filter(Boolean);
      const uniqueTexts = [...new Set(allTexts)];
      console.log('\n  ===== DEBUG: TEXT CONTENT IN FILE =====');
      console.log('  Total text entities: ' + allTexts.length);
      console.log('  Unique text values: ' + uniqueTexts.length);
      console.log('  First 100 unique texts:');
      uniqueTexts.slice(0, 100).forEach((txt, i) => {
        // Truncate long texts for logging
        const display = txt.length > 60 ? txt.substring(0, 60) + '...' : txt;
        console.log('    [' + i + '] "' + display + '"');
      });

      // Log fire-safety related texts specifically
      const fireKeywords = /אש|כיבוי|מטף|ספרינק|גלאי|עשן|יציאה|מילוט|חירום|EXIT|FIRE|SD|FE|IH|SPR|SMOKE|SPRINK|EXTINGU|HYDRANT|ALARM|DETECT/i;
      const fireTexts = uniqueTexts.filter(t => fireKeywords.test(t));
      if (fireTexts.length > 0) {
        console.log('\n  Fire-safety related texts found (' + fireTexts.length + '):');
        fireTexts.slice(0, 30).forEach(txt => {
          console.log('    * "' + txt + '"');
        });
      }

      entities.length = 0;

      resolve({
        entities: expanded,
        blocks: blocks,
        layers: layers,
        blockCount: Object.keys(blocks).length,
        truncated: truncated
      });
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

// ============ CLASSIFIER (v7 - Geometry & Text based for flattened DXF) ============
function classifyEntities(parsed) {
  const C = {
    walls: [], doors: [], fireDoors: [], windows: [], stairs: [], elevators: [],
    corridors: [], rooms: [], exits: [], sprinklers: [], smokeDetectors: [],
    heatDetectors: [], fireExtinguishers: [], hydrants: [], fireAlarmPanel: [],
    manualCallPoints: [], emergencyLights: [], exitSigns: [], smokeVents: [],
    fireWalls: [], accessRoads: [], texts: [], unknown: [],
    stats: { total: 0, classified: 0, byLayer: {}, byType: {} }
  };

  // Check if this is a flattened file (mostly layer "0")
  const layerCounts = {};
  parsed.entities.forEach(e => {
    const l = e.layer || '0';
    layerCounts[l] = (layerCounts[l] || 0) + 1;
  });
  const layer0Count = layerCounts['0'] || 0;
  const isFlattened = layer0Count > parsed.entities.length * 0.9;

  console.log('  Classification mode: ' + (isFlattened ? 'GEOMETRY-BASED (flattened file)' : 'LAYER-BASED'));

  // ===== STEP 1: Collect all text entities and build spatial index =====
  const textEntities = [];
  const textPositions = []; // For spatial proximity search

  // Text patterns for classification
  const TEXT_PATTERNS = {
    sprinklers: /ספרינק|מתז|SPRINK|SPR[-_]?\d|^S\d+$|^S$/i,
    smokeDetectors: /גלאי.?עשן|עשן|SMOKE|SD[-_]?\d|^SD$/i,
    heatDetectors: /גלאי.?חום|חום|HEAT|HD[-_]?\d|^HD$/i,
    fireExtinguishers: /מטף|מטפה|כיבוי|EXTING|FE[-_]?\d|^FE$/i,
    hydrants: /הידרנט|ברז.?כיבוי|ברז.?אש|HYDRANT|IH[-_]?\d|^IH$|^FH$/i,
    exits: /יציאה|יציאת.?חירום|מוצא|EXIT/i,
    exitSigns: /שלט.?יציאה|EXIT.?SIGN/i,
    emergencyLights: /תאורת.?חירום|תאורה.?חירום|אור.?חירום|EMERGENCY|EC[-_]?\d/i,
    stairs: /מדרגות|חדר.?מדרגות|STAIR/i,
    fireDoors: /דלת.?אש|אש.?דלת|FIRE.?DOOR|FD[-_]?\d/i,
    doors: /דלת|DOOR|^D\d+$/i,
    fireAlarmPanel: /רכזת|לוח.?בקרה|ALARM.?PANEL|FACP/i,
    manualCallPoints: /לחצן.?אש|MCP|CALL.?POINT/i,
    smokeVents: /שחרור.?עשן|פתח.?עשן|SMOKE.?VENT|SV[-_]?\d/i,
    fireWalls: /קיר.?אש|FIRE.?WALL/i,
    accessRoads: /דרך.?גישה|גישה.?כבאות|ACCESS|FIRE.?LANE/i,
    elevators: /מעלית|ELEV|LIFT/i,
    windows: /חלון|WINDOW/i
  };

  // Layer patterns (still used if layers exist)
  const LAYER_PATTERNS = {
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

  // ===== STEP 2: First pass - collect texts and classify by text content =====
  const textPatternKeys = Object.keys(TEXT_PATTERNS);
  const layerPatternKeys = Object.keys(LAYER_PATTERNS);

  for (let i = 0; i < parsed.entities.length; i++) {
    const ent = parsed.entities[i];
    C.stats.total++;

    const layer = (ent.layer || '0').toUpperCase();
    C.stats.byLayer[layer] = (C.stats.byLayer[layer] || 0) + 1;
    C.stats.byType[ent.type] = (C.stats.byType[ent.type] || 0) + 1;

    // Collect text entities
    if ((ent.type === 'TEXT' || ent.type === 'MTEXT') && ent.text) {
      C.texts.push(ent);
      textEntities.push(ent);
      if (ent.x !== undefined) {
        textPositions.push({ x: ent.x, y: ent.y, text: ent.text, ent: ent });
      }

      // Classify text by content
      let matched = false;
      for (let ti = 0; ti < textPatternKeys.length && !matched; ti++) {
        const key = textPatternKeys[ti];
        if (TEXT_PATTERNS[key].test(ent.text)) {
          C[key].push(ent);
          C.stats.classified++;
          matched = true;
        }
      }
      continue; // Text entities handled
    }
  }

  console.log('  Found ' + textEntities.length + ' text entities for proximity classification');

  // ===== STEP 3: Build spatial index of fire-safety related texts =====
  const fireTextPositions = textPositions.filter(tp => {
    const t = tp.text;
    return /ספרינק|מתז|גלאי|עשן|חום|מטף|הידרנט|ברז|יציאה|חירום|אש|SPRINK|SMOKE|HEAT|FIRE|EXIT|FE|SD|HD|IH|SPR/i.test(t);
  });
  console.log('  Fire-safety text markers for proximity: ' + fireTextPositions.length);

  // Helper: find nearest text to a point
  function findNearestFireText(x, y, maxDist) {
    let nearest = null;
    let minDist = maxDist;
    for (let i = 0; i < fireTextPositions.length; i++) {
      const tp = fireTextPositions[i];
      const d = Math.hypot(x - tp.x, y - tp.y);
      if (d < minDist) {
        minDist = d;
        nearest = tp;
      }
    }
    return nearest;
  }

  // ===== STEP 4: Second pass - classify geometry =====
  for (let i = 0; i < parsed.entities.length; i++) {
    const ent = parsed.entities[i];

    // Skip already-processed text entities
    if (ent.type === 'TEXT' || ent.type === 'MTEXT') continue;

    let matched = false;
    const layer = ent.layer || '0';

    // Try layer-based classification first (if not flattened)
    if (!isFlattened && layer !== '0') {
      for (let li = 0; li < layerPatternKeys.length && !matched; li++) {
        const key = layerPatternKeys[li];
        if (LAYER_PATTERNS[key].test(layer)) {
          C[key].push(ent);
          C.stats.classified++;
          matched = true;
        }
      }
    }

    if (matched) continue;

    // ===== GEOMETRY-BASED CLASSIFICATION =====

    // Small circles = likely sprinklers or detectors
    if (ent.type === 'CIRCLE' && ent.radius !== undefined) {
      const r = ent.radius;

      // Very small circles (< 0.3 units) = sprinklers/detectors
      if (r < 0.3 && r > 0.01) {
        // Check proximity to fire-related text
        if (ent.x !== undefined) {
          const nearText = findNearestFireText(ent.x, ent.y, 5); // 5 unit radius
          if (nearText) {
            if (/ספרינק|מתז|SPRINK|SPR/i.test(nearText.text)) {
              C.sprinklers.push(ent);
              C.stats.classified++;
              matched = true;
            } else if (/גלאי.?עשן|עשן|SMOKE|SD/i.test(nearText.text)) {
              C.smokeDetectors.push(ent);
              C.stats.classified++;
              matched = true;
            } else if (/גלאי.?חום|חום|HEAT|HD/i.test(nearText.text)) {
              C.heatDetectors.push(ent);
              C.stats.classified++;
              matched = true;
            }
          }
          // If no nearby text but small circle, assume sprinkler (common in fire plans)
          if (!matched && r < 0.15) {
            C.sprinklers.push(ent);
            C.stats.classified++;
            matched = true;
          }
        }
      }

      // Medium circles might be other fire equipment
      if (!matched && r >= 0.3 && r < 1.0) {
        if (ent.x !== undefined) {
          const nearText = findNearestFireText(ent.x, ent.y, 3);
          if (nearText) {
            if (/מטף|EXTING|FE/i.test(nearText.text)) {
              C.fireExtinguishers.push(ent);
              C.stats.classified++;
              matched = true;
            } else if (/הידרנט|ברז|HYDRANT|IH|FH/i.test(nearText.text)) {
              C.hydrants.push(ent);
              C.stats.classified++;
              matched = true;
            }
          }
        }
      }
    }

    // Arcs near small gaps = door swings
    if (!matched && ent.type === 'ARC' && ent.radius !== undefined) {
      const r = ent.radius;
      // Door swing arcs are typically 0.8-1.2m radius (90 degree swing)
      if (r >= 0.7 && r <= 1.5) {
        const startAngle = ent.startAngle || 0;
        const endAngle = ent.endAngle || 0;
        const sweep = Math.abs(endAngle - startAngle);
        // 90-degree swing is typical for doors
        if (sweep >= 80 && sweep <= 100) {
          C.doors.push(ent);
          C.stats.classified++;
          matched = true;
        }
      }
    }

    // Polylines - analyze shape
    if (!matched && (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices && ent.vertices.length >= 3) {
      const verts = ent.vertices;
      const n = verts.length;

      // Check if closed (last point near first point)
      const closed = n >= 4 && Math.hypot(verts[0].x - verts[n-1].x, verts[0].y - verts[n-1].y) < 0.1;

      if (closed && n === 4 || n === 5) {
        // Calculate bounding box
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        verts.forEach(v => {
          minX = Math.min(minX, v.x);
          maxX = Math.max(maxX, v.x);
          minY = Math.min(minY, v.y);
          maxY = Math.max(maxY, v.y);
        });
        const w = maxX - minX;
        const h = maxY - minY;

        // Door-sized rectangle: roughly 0.8-1.2m x 0.04-0.15m (door leaf)
        if ((w >= 0.7 && w <= 1.3 && h >= 0.03 && h <= 0.2) ||
            (h >= 0.7 && h <= 1.3 && w >= 0.03 && w <= 0.2)) {
          C.doors.push(ent);
          C.stats.classified++;
          matched = true;
        }

        // Fire extinguisher box: roughly 0.2-0.4m square
        if (!matched && w >= 0.15 && w <= 0.5 && h >= 0.15 && h <= 0.5 && Math.abs(w - h) < 0.1) {
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const nearText = findNearestFireText(cx, cy, 3);
          if (nearText && /מטף|EXTING|FE/i.test(nearText.text)) {
            C.fireExtinguishers.push(ent);
            C.stats.classified++;
            matched = true;
          }
        }
      }

      // Stair pattern: many short parallel segments
      if (!matched && n >= 6) {
        // Check if segments are roughly parallel and evenly spaced (stair treads)
        let parallelCount = 0;
        for (let j = 0; j < n - 2; j++) {
          const dx1 = verts[j+1].x - verts[j].x;
          const dy1 = verts[j+1].y - verts[j].y;
          const dx2 = verts[j+2].x - verts[j+1].x;
          const dy2 = verts[j+2].y - verts[j+1].y;
          const len1 = Math.hypot(dx1, dy1);
          const len2 = Math.hypot(dx2, dy2);
          if (len1 > 0.1 && len2 > 0.1 && len1 < 2 && len2 < 2) {
            // Check if roughly perpendicular (stair treads alternate direction)
            const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
            if (Math.abs(dot) < 0.3) parallelCount++;
          }
        }
        if (parallelCount >= 4) {
          C.stairs.push(ent);
          C.stats.classified++;
          matched = true;
        }
      }
    }

    // Lines - long lines might be walls
    if (!matched && ent.type === 'LINE' && ent.x !== undefined && ent.x2 !== undefined) {
      const len = Math.hypot(ent.x2 - ent.x, ent.y2 - ent.y);
      // Long lines (> 2m) are likely walls
      if (len > 2) {
        C.walls.push(ent);
        C.stats.classified++;
        matched = true;
      }
    }

    if (!matched) {
      C.unknown.push(ent);
    }
  }

  console.log('  Classified: ' + C.stats.classified + '/' + C.stats.total);
  console.log('  Classification breakdown:');
  console.log('    Sprinklers: ' + C.sprinklers.length);
  console.log('    Smoke detectors: ' + C.smokeDetectors.length);
  console.log('    Heat detectors: ' + C.heatDetectors.length);
  console.log('    Fire extinguishers: ' + C.fireExtinguishers.length);
  console.log('    Hydrants: ' + C.hydrants.length);
  console.log('    Doors: ' + C.doors.length);
  console.log('    Fire doors: ' + C.fireDoors.length);
  console.log('    Stairs: ' + C.stairs.length);
  console.log('    Exits: ' + C.exits.length);
  console.log('    Exit signs: ' + C.exitSigns.length);
  console.log('    Emergency lights: ' + C.emergencyLights.length);
  console.log('    Walls: ' + C.walls.length);
  console.log('    Texts: ' + C.texts.length);
  console.log('    Unknown: ' + C.unknown.length);

  return C;
}

// ============ SMART BOUNDS ============
// Note: analyzeGeometry and checkFireSafetyRules removed in v8
// Scoring is now done by Claude Vision in server.js
function computeSmartBounds(entities) {
  const maxSample = 50000;
  let sample = entities;
  if (entities.length > maxSample) {
    const step = Math.ceil(entities.length / maxSample);
    sample = entities.filter((_, i) => i % step === 0);
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
      const verts = e.vertices.length > 50 ? e.vertices.filter((_, i) => i % Math.ceil(e.vertices.length / 50) === 0) : e.vertices;
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

// ============ SVG RENDERER ============
async function renderToSVGFile(entities, classified, width, outputPath) {
  width = width || 4000;

  let entitiesToRender = entities;
  if (entities.length > MAX_ENTITIES_FOR_SVG) {
    const step = Math.ceil(entities.length / MAX_ENTITIES_FOR_SVG);
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

  const styles = new Map();
  classified.walls.forEach(e => styles.set(e, { c: COL.walls, w: 2.0 }));
  classified.doors.forEach(e => styles.set(e, { c: COL.doors, w: 2.5 }));
  classified.fireDoors.forEach(e => styles.set(e, { c: COL.fireDoors, w: 3, d: '6,3' }));
  classified.stairs.forEach(e => styles.set(e, { c: COL.stairs, w: 2 }));
  classified.fireWalls.forEach(e => styles.set(e, { c: COL.fireWalls, w: 3.5, d: '10,5' }));
  classified.exits.forEach(e => styles.set(e, { c: COL.exits, w: 2.5 }));
  classified.windows.forEach(e => styles.set(e, { c: COL.windows, w: 1.5 }));

  const markerSet = new Set();
  [classified.sprinklers, classified.smokeDetectors, classified.heatDetectors,
   classified.fireExtinguishers, classified.hydrants, classified.emergencyLights,
   classified.exitSigns, classified.smokeVents].forEach(arr => arr.forEach(e => markerSet.add(e)));

  const renderSkip = /^LOGO$|^IDAN_CROSS$|^POINTS$|^POINTS_BETON$/i;

  return new Promise((resolve, reject) => {
    const svgStream = fs.createWriteStream(outputPath);
    svgStream.on('error', reject);
    svgStream.on('finish', () => resolve(outputPath));

    svgStream.write('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + totalH + '" viewBox="0 0 ' + width + ' ' + totalH + '">\n');
    svgStream.write('<rect width="100%" height="100%" fill="#fafbfc"/>\n');
    svgStream.write('<rect x="4" y="4" width="' + (width - 8) + '" height="' + (imgH - 8) + '" fill="white" stroke="#e2e8f0" rx="4"/>\n');
    svgStream.write('<defs><style>text{font-family:Arial,sans-serif}</style></defs>\n');

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
        svgStream.write('<line x1="' + tx(ent.x) + '" y1="' + ty(ent.y) + '" x2="' + tx(ent.x2) + '" y2="' + ty(ent.y2) + '" stroke="' + col + '" stroke-width="' + w + '"' + dash + ' stroke-linecap="round"/>\n');
      } else if (ent.type === 'CIRCLE' && ent.radius) {
        const r = Math.max(ent.radius * scale, 1);
        svgStream.write('<circle cx="' + tx(ent.x) + '" cy="' + ty(ent.y) + '" r="' + r.toFixed(1) + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"/>\n');
      } else if (ent.type === 'ARC' && ent.radius) {
        const ra = Math.max(ent.radius * scale, 1);
        const sa = (ent.startAngle || 0) * Math.PI / 180;
        const ea = (ent.endAngle || 360) * Math.PI / 180;
        const ax1 = tx(ent.x + ent.radius * Math.cos(sa));
        const ay1 = ty(ent.y + ent.radius * Math.sin(sa));
        const ax2 = tx(ent.x + ent.radius * Math.cos(ea));
        const ay2 = ty(ent.y + ent.radius * Math.sin(ea));
        const la = ((ent.endAngle || 360) - (ent.startAngle || 0) + 360) % 360 > 180 ? 1 : 0;
        svgStream.write('<path d="M' + ax1 + ',' + ay1 + ' A' + ra + ',' + ra + ' 0 ' + la + ',0 ' + ax2 + ',' + ay2 + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"/>\n');
      } else if ((ent.type === 'TEXT' || ent.type === 'MTEXT') && ent.text && ent.x !== undefined) {
        let fs = Math.max((ent.height || 0.3) * scale * 0.55, 5);
        if (fs > 40) fs = 40;
        const esc = ent.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        svgStream.write('<text x="' + tx(ent.x) + '" y="' + ty(ent.y) + '" font-size="' + fs.toFixed(1) + '" fill="#4b5563">' + esc + '</text>\n');
      } else if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices && ent.vertices.length > 1) {
        const pts = ent.vertices.map(v => tx(v.x) + ',' + ty(v.y)).join(' ');
        svgStream.write('<polyline points="' + pts + '" stroke="' + col + '" fill="none" stroke-width="' + w + '"' + dash + '/>\n');
      }
    }

    function writeMarkers(items, color, shape) {
      for (let mi = 0; mi < items.length; mi++) {
        const e = items[mi];
        if (e.x === undefined) continue;
        const cx = parseFloat(tx(e.x)), cy = parseFloat(ty(e.y));
        if (cx < 0 || cx > width || cy < 0 || cy > imgH) continue;

        if (shape === 'c') {
          svgStream.write('<circle cx="' + cx + '" cy="' + cy + '" r="' + mSize + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>\n');
        } else if (shape === 'r') {
          svgStream.write('<circle cx="' + cx + '" cy="' + cy + '" r="' + mSize + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>\n');
          svgStream.write('<circle cx="' + cx + '" cy="' + cy + '" r="' + (mSize * 0.35) + '" fill="none" stroke="white" stroke-width="0.5"/>\n');
        } else if (shape === 's') {
          svgStream.write('<rect x="' + (cx - mSize) + '" y="' + (cy - mSize) + '" width="' + (mSize * 2) + '" height="' + (mSize * 2) + '" fill="' + color + '" stroke="white" stroke-width="0.7" rx="1" opacity="0.85"/>\n');
        } else if (shape === 'd') {
          svgStream.write('<polygon points="' + cx + ',' + (cy - mSize) + ' ' + (cx + mSize) + ',' + cy + ' ' + cx + ',' + (cy + mSize) + ' ' + (cx - mSize) + ',' + cy + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>\n');
        } else if (shape === 't') {
          svgStream.write('<polygon points="' + cx + ',' + (cy - mSize) + ' ' + (cx + mSize) + ',' + (cy + mSize * 0.7) + ' ' + (cx - mSize) + ',' + (cy + mSize * 0.7) + '" fill="' + color + '" stroke="white" stroke-width="0.7" opacity="0.85"/>\n');
        }
      }
    }

    writeMarkers(classified.sprinklers, COL.sprinklers, 'c');
    writeMarkers(classified.smokeDetectors, COL.smokeDetectors, 'r');
    writeMarkers(classified.heatDetectors, COL.heatDetectors, 'r');
    writeMarkers(classified.fireExtinguishers, COL.fireExtinguishers, 's');
    writeMarkers(classified.hydrants, COL.hydrants, 's');
    writeMarkers(classified.emergencyLights, COL.emergencyLights, 'd');
    writeMarkers(classified.exitSigns, COL.exitSigns, 't');
    writeMarkers(classified.smokeVents, COL.smokeVents, 'd');

    const ly = imgH + 6;
    svgStream.write('<rect x="4" y="' + ly + '" width="' + (width - 8) + '" height="' + (legH - 10) + '" fill="white" stroke="#e2e8f0" rx="4"/>\n');
    svgStream.write('<text x="' + (width / 2) + '" y="' + (ly + 18) + '" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">מקרא - Legend</text>\n');

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
      svgStream.write('<rect x="' + lx + '" y="' + liy + '" width="12" height="12" fill="' + legendItems[idx][0] + '" rx="2"/>\n');
      svgStream.write('<text x="' + (lx + 18) + '" y="' + (liy + 10) + '" fill="#374151" font-size="10">' + legendItems[idx][1] + '</text>\n');
    }

    svgStream.write('</svg>\n');
    svgStream.end();
  });
}

// ============ MAIN ============
// v8: Rendering only - scoring is done by Claude Vision in server.js
async function analyzeDXF(filePath) {
  console.log('Vector DXF rendering v8 (Claude Vision will analyze)...');
  console.log('  Memory limits: ' + MAX_ENTITIES_AFTER_EXPANSION + ' entities max, ' + MAX_ENTITIES_FOR_SVG + ' for SVG');

  let parsed = await parseDXFStreaming(filePath);
  console.log('  Entities: ' + parsed.entities.length + ', Blocks: ' + parsed.blockCount + ', Layers: ' + Object.keys(parsed.layers).length);

  // Classify for rendering purposes only (coloring different element types)
  let classified = classifyEntities(parsed);

  // Store metadata before rendering
  const entityCount = parsed.entities.length;
  const blockCount = parsed.blockCount;
  const layerCount = Object.keys(parsed.layers).length;
  const layersCopy = { ...parsed.layers };

  // Collect vector statistics (supplementary data for Claude)
  const vectorData = {
    layers: Object.keys(classified.stats.byLayer),
    entityTypes: { ...classified.stats.byType },
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
  };

  // Render to SVG then PNG (this is the main output for Claude Vision)
  const tmpDir = os.tmpdir();
  const svgPath = path.join(tmpDir, 'dxf_render_' + Date.now() + '.svg');

  await renderToSVGFile(parsed.entities, classified, 4000, svgPath);
  console.log('  SVG written to: ' + svgPath);

  // Aggressive memory cleanup
  parsed.entities = null;
  parsed.blocks = null;
  parsed = null;

  classified.walls = null;
  classified.doors = null;
  classified.fireDoors = null;
  classified.windows = null;
  classified.stairs = null;
  classified.elevators = null;
  classified.corridors = null;
  classified.rooms = null;
  classified.exits = null;
  classified.sprinklers = null;
  classified.smokeDetectors = null;
  classified.heatDetectors = null;
  classified.fireExtinguishers = null;
  classified.hydrants = null;
  classified.fireAlarmPanel = null;
  classified.manualCallPoints = null;
  classified.emergencyLights = null;
  classified.exitSigns = null;
  classified.smokeVents = null;
  classified.fireWalls = null;
  classified.accessRoads = null;
  classified.texts = null;
  classified.unknown = null;
  classified = null;

  if (global.gc) {
    global.gc();
    console.log('  Manual GC triggered');
  }

  // Convert SVG to PNG for Claude Vision
  let pngBuffer = null;
  let svg = null;

  try {
    const sharp = require('sharp');
    pngBuffer = await sharp(svgPath).png({ compressionLevel: 6 }).toBuffer();
    console.log('  PNG: ' + (pngBuffer.length / 1024).toFixed(0) + 'KB');
    svg = fs.readFileSync(svgPath, 'utf8');
    console.log('  SVG: ' + (svg.length / 1024).toFixed(0) + 'KB');
  } catch (e) {
    console.log('  sharp/svg error: ' + e.message);
    try {
      svg = fs.readFileSync(svgPath, 'utf8');
    } catch (e2) {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text x="10" y="50">Error rendering</text></svg>';
    }
  }

  try {
    fs.unlinkSync(svgPath);
  } catch (e) {}

  // Return rendered image and metadata (NO hardcoded analysis - Claude does that)
  return {
    svg: svg,
    pngBuffer: pngBuffer,
    parsed: {
      entityCount: entityCount,
      blockCount: blockCount,
      layerCount: layerCount,
      layers: layersCopy
    },
    vectorData: vectorData
  };
}

module.exports = {
  analyzeDXF,
  parseDXFStreaming,
  classifyEntities,
  renderToSVGFile
  // Note: analyzeGeometry and checkFireSafetyRules removed -
  // scoring is now done by Claude Vision in server.js
};
