// dxf-analyzer.js v13 - COMPLETE FIRE SAFETY ANALYSIS PIPELINE
// Parses DXF, builds object tree, classifies fire safety elements, measures distances

const fs = require('fs');
const readline = require('readline');

// ============ STREAMING PARSER ============
async function streamParseDXF(filePath) {
  return new Promise((resolve, reject) => {
    console.log('  DXF Parser v13 - Full streaming parse...');

    const stats = fs.statSync(filePath);
    console.log(`  File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

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
    let currentBlockEntities = [];

    const blocks = {};
    const layers = {};

    // Store ALL important entities
    const texts = [];
    const circles = [];
    const arcs = [];
    const lines = [];
    const polylines = [];
    const blockRefs = [];
    const dimensions = [];
    const hatches = [];

    let totalEntities = 0;

    let parsingEntity = false;
    let entityType = null;
    let entityData = {};
    let entityVerts = [];
    let curVx = null;

    let expectSectionName = false;
    let parsingLayer = false;
    let layerData = {};

    const ENTITY_TYPES = new Set([
      'LINE', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'INSERT',
      'LWPOLYLINE', 'POLYLINE', 'SOLID', 'ELLIPSE', 'POINT', 'SPLINE',
      'DIMENSION', 'LEADER', 'HATCH', 'ATTRIB', 'ATTDEF'
    ]);

    function finalizeEntity() {
      if (!parsingEntity || !entityType) return;

      totalEntities++;
      entityData.type = entityType;

      // Handle polyline vertices
      if ((entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') && curVx !== null) {
        entityVerts.push({ x: curVx, y: entityData.y || 0 });
      }

      // Check if polyline is closed
      let isClosed = false;
      if (entityVerts.length >= 3) {
        const first = entityVerts[0];
        const last = entityVerts[entityVerts.length - 1];
        isClosed = Math.hypot((first.x || 0) - (last.x || 0), (first.y || 0) - (last.y || 0)) < 0.1;
      }

      const entity = {
        type: entityType,
        layer: entityData.layer || '0',
        x: entityData.x,
        y: entityData.y,
        x2: entityData.x2,
        y2: entityData.y2
      };

      // Store based on type
      switch (entityType) {
        case 'TEXT':
        case 'MTEXT':
        case 'ATTRIB':
        case 'ATTDEF':
          if (entityData.text) {
            texts.push({
              ...entity,
              text: entityData.text,
              height: entityData.height
            });
          }
          break;

        case 'CIRCLE':
          circles.push({
            ...entity,
            radius: entityData.radius
          });
          break;

        case 'ARC':
          arcs.push({
            ...entity,
            radius: entityData.radius,
            startAngle: entityData.startAngle,
            endAngle: entityData.endAngle,
            sweep: Math.abs((entityData.endAngle || 0) - (entityData.startAngle || 0))
          });
          break;

        case 'LINE':
          lines.push(entity);
          break;

        case 'LWPOLYLINE':
        case 'POLYLINE':
          polylines.push({
            ...entity,
            vertices: [...entityVerts],
            closed: isClosed || (entityData.flags & 1) === 1
          });
          break;

        case 'INSERT':
          blockRefs.push({
            ...entity,
            blockName: entityData.blockName,
            scaleX: entityData.scaleX || 1,
            scaleY: entityData.scaleY || 1,
            rotation: entityData.rotation || 0
          });
          break;

        case 'DIMENSION':
          dimensions.push({
            ...entity,
            value: entityData.text,
            dimType: entityData.dimType
          });
          break;

        case 'HATCH':
          hatches.push({
            ...entity,
            pattern: entityData.pattern
          });
          break;
      }

      // If inside a block, also store to block entities
      if (inBlock && currentBlockName) {
        if (!blocks[currentBlockName]) blocks[currentBlockName] = { entities: [] };
        blocks[currentBlockName].entities.push({ type: entityType, ...entityData });
      }

      // Reset
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
            return;
          }
          if (value === 'ENDBLK') {
            finalizeEntity();
            inBlock = false;
            currentBlockName = null;
            return;
          }
        }

        if (currentSection === 'TABLES') {
          if (value === 'LAYER') {
            parsingLayer = true;
            layerData = { name: '', color: 7, frozen: false, off: false };
            return;
          }
          if (parsingLayer && value !== 'LAYER') {
            if (layerData.name) {
              layers[layerData.name] = {
                color: layerData.color,
                frozen: layerData.frozen,
                off: layerData.off
              };
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
        return;
      }

      if (parsingLayer) {
        if (code === 2) layerData.name = value;
        else if (code === 62) layerData.color = parseInt(value);
        else if (code === 70) {
          const flags = parseInt(value);
          layerData.frozen = (flags & 1) !== 0;
          layerData.off = (flags & 4) !== 0;
        }
        return;
      }

      if (parsingEntity) {
        switch (code) {
          case 8: entityData.layer = value; break;
          case 1: entityData.text = value; break;
          case 2: entityData.blockName = value; break;
          case 10:
            if (entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') {
              if (curVx !== null) entityVerts.push({ x: curVx, y: 0 });
              curVx = parseFloat(value);
            } else {
              entityData.x = parseFloat(value);
            }
            break;
          case 20:
            if ((entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') && curVx !== null) {
              entityVerts.push({ x: curVx, y: parseFloat(value) });
              curVx = null;
            } else {
              entityData.y = parseFloat(value);
            }
            break;
          case 11: entityData.x2 = parseFloat(value); break;
          case 21: entityData.y2 = parseFloat(value); break;
          case 40:
            entityData.radius = parseFloat(value);
            entityData.height = parseFloat(value);
            break;
          case 41: entityData.scaleX = parseFloat(value); break;
          case 42: entityData.scaleY = parseFloat(value); break;
          case 50: entityData.startAngle = parseFloat(value); entityData.rotation = parseFloat(value); break;
          case 51: entityData.endAngle = parseFloat(value); break;
          case 70: entityData.flags = parseInt(value); entityData.dimType = parseInt(value); break;
        }
      }
    }

    let lineNumber = 0;
    const logInterval = 500000;

    rl.on('line', (line) => {
      lineNumber++;
      if (lineNumber % logInterval === 0) {
        console.log(`    Parsed ${(lineNumber / 1000000).toFixed(1)}M lines, ${totalEntities} entities...`);
      }

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

      console.log('  Parse complete:');
      console.log(`    Total entities: ${totalEntities}`);
      console.log(`    Texts: ${texts.length}, Circles: ${circles.length}, Arcs: ${arcs.length}`);
      console.log(`    Lines: ${lines.length}, Polylines: ${polylines.length}`);
      console.log(`    Block refs: ${blockRefs.length}, Dimensions: ${dimensions.length}`);
      console.log(`    Layers: ${Object.keys(layers).length}, Blocks defined: ${Object.keys(blocks).length}`);

      resolve({
        texts, circles, arcs, lines, polylines, blockRefs, dimensions, hatches,
        blocks, layers,
        totalEntities
      });
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

// ============ BUILD OBJECT TREE GROUPED BY LAYER ============
function buildObjectTree(parsed) {
  console.log('  Building object tree by layer...');

  const tree = {
    layers: {},
    summary: {
      totalEntities: parsed.totalEntities,
      layerCount: Object.keys(parsed.layers).length,
      textCount: parsed.texts.length,
      circleCount: parsed.circles.length,
      arcCount: parsed.arcs.length
    }
  };

  // Initialize layers
  Object.keys(parsed.layers).forEach(name => {
    tree.layers[name] = {
      info: parsed.layers[name],
      texts: [],
      circles: [],
      arcs: [],
      lines: [],
      polylines: [],
      blockRefs: [],
      dimensions: []
    };
  });

  // Add default layer 0 if not exists
  if (!tree.layers['0']) {
    tree.layers['0'] = {
      info: { color: 7 },
      texts: [], circles: [], arcs: [], lines: [], polylines: [], blockRefs: [], dimensions: []
    };
  }

  // Distribute entities to layers
  const distribute = (entities, targetKey) => {
    entities.forEach(e => {
      const layerName = e.layer || '0';
      if (!tree.layers[layerName]) {
        tree.layers[layerName] = {
          info: { color: 7 },
          texts: [], circles: [], arcs: [], lines: [], polylines: [], blockRefs: [], dimensions: []
        };
      }
      tree.layers[layerName][targetKey].push(e);
    });
  };

  distribute(parsed.texts, 'texts');
  distribute(parsed.circles, 'circles');
  distribute(parsed.arcs, 'arcs');
  distribute(parsed.lines, 'lines');
  distribute(parsed.polylines, 'polylines');
  distribute(parsed.blockRefs, 'blockRefs');
  distribute(parsed.dimensions, 'dimensions');

  // Add block definitions
  tree.blocks = parsed.blocks;

  console.log(`  Object tree built: ${Object.keys(tree.layers).length} layers`);
  return tree;
}

// ============ CLASSIFY FIRE SAFETY ELEMENTS ============
function classifyFireSafety(tree) {
  console.log('  Classifying fire safety elements...');

  const classified = {
    sprinklers: [],
    smokeDetectors: [],
    heatDetectors: [],
    fireExtinguishers: [],
    hydrants: [],
    fireDoors: [],
    exits: [],
    stairs: [],
    fireWalls: [],
    elevators: [],
    corridors: [],
    rooms: [],
    unknown: []
  };

  // Patterns for classification
  const patterns = {
    sprinklers: /ספרינק|מתז|SPRINK|SPR[-_]?\d|HEAD/i,
    smokeDetectors: /גלאי.?עשן|עשן|SMOKE|SD[-_]?\d|DETECTOR/i,
    heatDetectors: /גלאי.?חום|חום|HEAT|HD[-_]?\d/i,
    fireExtinguishers: /מטף|מטפה|EXTING|FE[-_]?\d|FIRE.?EXT/i,
    hydrants: /הידרנט|ברז.?כיבוי|ברז.?אש|HYDRANT|FH|IH|STANDPIPE/i,
    fireDoors: /דלת.?אש|FIRE.?DOOR|FD[-_]?\d|דא/i,
    exits: /יציאה|מוצא|יציאת.?חירום|EXIT|EMERG/i,
    stairs: /מדרגות|STAIR|מדרגות.?חירום/i,
    fireWalls: /קיר.?אש|FIRE.?WALL|FW/i,
    elevators: /מעלית|ELEVATOR|LIFT|EL/i,
    corridors: /מסדרון|CORRIDOR|HALL/i
  };

  // Classify texts
  Object.values(tree.layers).forEach(layer => {
    layer.texts.forEach(text => {
      const content = text.text || '';
      let found = false;

      for (const [category, pattern] of Object.entries(patterns)) {
        if (pattern.test(content)) {
          classified[category].push({
            type: 'text',
            text: content,
            x: text.x,
            y: text.y,
            layer: text.layer
          });
          found = true;
          break;
        }
      }

      if (!found && content.length > 0) {
        classified.unknown.push({ type: 'text', text: content, x: text.x, y: text.y, layer: text.layer });
      }
    });

    // Classify block references
    layer.blockRefs.forEach(ref => {
      const blockName = ref.blockName || '';

      for (const [category, pattern] of Object.entries(patterns)) {
        if (pattern.test(blockName)) {
          classified[category].push({
            type: 'block',
            blockName,
            x: ref.x,
            y: ref.y,
            layer: ref.layer
          });
          break;
        }
      }
    });
  });

  // Classify by layer names
  Object.entries(tree.layers).forEach(([layerName, layer]) => {
    for (const [category, pattern] of Object.entries(patterns)) {
      if (pattern.test(layerName)) {
        // All circles on this layer are likely that category
        layer.circles.forEach(c => {
          classified[category].push({
            type: 'circle',
            x: c.x,
            y: c.y,
            radius: c.radius,
            layer: layerName,
            fromLayerMatch: true
          });
        });
        break;
      }
    }
  });

  // Detect door swings from arcs (90-degree arcs with typical door radius)
  Object.values(tree.layers).forEach(layer => {
    layer.arcs.forEach(arc => {
      const sweep = arc.sweep || 0;
      const radius = arc.radius || 0;
      // Door swings: ~90° sweep, 0.7-1.2m radius
      if (sweep >= 80 && sweep <= 100 && radius >= 0.6 && radius <= 1.5) {
        classified.fireDoors.push({
          type: 'doorSwing',
          x: arc.x,
          y: arc.y,
          radius,
          sweep,
          layer: arc.layer
        });
      }
    });
  });

  // Identify rooms from closed polylines
  Object.values(tree.layers).forEach(layer => {
    layer.polylines.forEach(poly => {
      if (poly.closed && poly.vertices && poly.vertices.length >= 4) {
        // Calculate approximate area
        let area = 0;
        const verts = poly.vertices;
        for (let i = 0; i < verts.length; i++) {
          const j = (i + 1) % verts.length;
          area += (verts[i].x || 0) * (verts[j].y || 0);
          area -= (verts[j].x || 0) * (verts[i].y || 0);
        }
        area = Math.abs(area) / 2;

        // Only include reasonable room sizes (> 1 sqm)
        if (area > 1) {
          classified.rooms.push({
            type: 'room',
            vertices: verts,
            area,
            layer: poly.layer
          });
        }
      }
    });
  });

  console.log('  Classification complete:');
  Object.entries(classified).forEach(([cat, items]) => {
    if (items.length > 0) console.log(`    ${cat}: ${items.length}`);
  });

  return classified;
}

// ============ MEASURE DISTANCES ============
function measureDistances(classified) {
  console.log('  Measuring distances...');

  const measurements = {
    sprinklerSpacing: { min: null, max: null, avg: null, count: 0 },
    detectorSpacing: { min: null, max: null, avg: null, count: 0 },
    exitDistances: [],
    extinguisherCoverage: { maxDistance: null },
    doorWidths: []
  };

  // Helper: calculate distance between two points
  const dist = (p1, p2) => Math.hypot((p1.x || 0) - (p2.x || 0), (p1.y || 0) - (p2.y || 0));

  // Sprinkler spacing
  if (classified.sprinklers.length >= 2) {
    const sprinklers = classified.sprinklers.filter(s => s.x !== undefined);
    const spacings = [];

    sprinklers.forEach((s1, i) => {
      let nearest = Infinity;
      sprinklers.forEach((s2, j) => {
        if (i !== j) {
          const d = dist(s1, s2);
          if (d > 0.1 && d < nearest) nearest = d;
        }
      });
      if (nearest < Infinity) spacings.push(nearest);
    });

    if (spacings.length > 0) {
      measurements.sprinklerSpacing = {
        min: Math.min(...spacings),
        max: Math.max(...spacings),
        avg: spacings.reduce((a, b) => a + b, 0) / spacings.length,
        count: sprinklers.length
      };
    }
  }

  // Smoke detector spacing
  const detectors = [...classified.smokeDetectors, ...classified.heatDetectors];
  if (detectors.length >= 2) {
    const spacings = [];
    detectors.filter(d => d.x !== undefined).forEach((d1, i) => {
      let nearest = Infinity;
      detectors.forEach((d2, j) => {
        if (i !== j && d2.x !== undefined) {
          const d = dist(d1, d2);
          if (d > 0.1 && d < nearest) nearest = d;
        }
      });
      if (nearest < Infinity) spacings.push(nearest);
    });

    if (spacings.length > 0) {
      measurements.detectorSpacing = {
        min: Math.min(...spacings),
        max: Math.max(...spacings),
        avg: spacings.reduce((a, b) => a + b, 0) / spacings.length,
        count: detectors.length
      };
    }
  }

  // Door widths from door swing radii
  classified.fireDoors.filter(d => d.type === 'doorSwing').forEach(door => {
    measurements.doorWidths.push({
      width: door.radius,
      x: door.x,
      y: door.y
    });
  });

  console.log('  Measurements complete');
  return measurements;
}

// ============ BUILD STRUCTURED REPORT DATA FOR CLAUDE ============
function buildReportData(tree, classified, measurements) {
  console.log('  Building structured report data...');

  // Calculate total area from rooms
  const totalArea = classified.rooms.reduce((sum, r) => sum + (r.area || 0), 0);

  const reportData = {
    summary: {
      totalEntities: tree.summary.totalEntities,
      layerCount: tree.summary.layerCount,
      textLabels: tree.summary.textCount,
      estimatedArea: totalArea
    },
    layers: Object.entries(tree.layers).map(([name, layer]) => ({
      name,
      entityCount: layer.texts.length + layer.circles.length + layer.arcs.length +
                   layer.lines.length + layer.polylines.length + layer.blockRefs.length
    })).filter(l => l.entityCount > 0).sort((a, b) => b.entityCount - a.entityCount),

    fireSafety: {
      sprinklers: {
        count: classified.sprinklers.length,
        spacing: measurements.sprinklerSpacing
      },
      smokeDetectors: {
        count: classified.smokeDetectors.length,
        spacing: measurements.detectorSpacing
      },
      heatDetectors: {
        count: classified.heatDetectors.length
      },
      fireExtinguishers: {
        count: classified.fireExtinguishers.length
      },
      hydrants: {
        count: classified.hydrants.length
      },
      fireDoors: {
        count: classified.fireDoors.length,
        doorSwings: classified.fireDoors.filter(d => d.type === 'doorSwing').length,
        widths: measurements.doorWidths
      },
      exits: {
        count: classified.exits.length,
        locations: classified.exits.slice(0, 20)
      },
      stairs: {
        count: classified.stairs.length
      },
      fireWalls: {
        count: classified.fireWalls.length
      },
      elevators: {
        count: classified.elevators.length
      }
    },

    texts: classified.unknown.slice(0, 100).map(t => ({
      text: t.text,
      layer: t.layer,
      position: t.x !== undefined ? `(${t.x.toFixed(0)}, ${t.y.toFixed(0)})` : null
    })),

    rooms: {
      count: classified.rooms.length,
      totalArea,
      largest: classified.rooms.sort((a, b) => b.area - a.area).slice(0, 5).map(r => ({
        area: r.area,
        layer: r.layer
      }))
    },

    blocks: Object.keys(tree.blocks).slice(0, 50)
  };

  return reportData;
}

// ============ FORMAT REPORT DATA AS TEXT FOR CLAUDE ============
function formatReportForClaude(reportData) {
  let text = `=== נתוני תוכנית בטיחות אש ===

סיכום כללי:
- סה"כ אלמנטים: ${reportData.summary.totalEntities.toLocaleString()}
- מספר שכבות: ${reportData.summary.layerCount}
- תוויות טקסט: ${reportData.summary.textLabels}
- שטח משוער: ${reportData.summary.estimatedArea.toFixed(1)} יח' מרובעות

שכבות (${reportData.layers.length}):
${reportData.layers.slice(0, 30).map(l => `  - ${l.name}: ${l.entityCount} אלמנטים`).join('\n')}

=== מערכות בטיחות אש ===

ספרינקלרים: ${reportData.fireSafety.sprinklers.count}
${reportData.fireSafety.sprinklers.count > 0 ? `  - מרחק מינימלי: ${reportData.fireSafety.sprinklers.spacing.min?.toFixed(2) || 'N/A'} יח'
  - מרחק מקסימלי: ${reportData.fireSafety.sprinklers.spacing.max?.toFixed(2) || 'N/A'} יח'
  - מרחק ממוצע: ${reportData.fireSafety.sprinklers.spacing.avg?.toFixed(2) || 'N/A'} יח'` : ''}

גלאי עשן: ${reportData.fireSafety.smokeDetectors.count}
${reportData.fireSafety.smokeDetectors.count > 0 ? `  - מרחק ממוצע: ${reportData.fireSafety.smokeDetectors.spacing.avg?.toFixed(2) || 'N/A'} יח'` : ''}

גלאי חום: ${reportData.fireSafety.heatDetectors.count}

מטפי כיבוי: ${reportData.fireSafety.fireExtinguishers.count}

הידרנטים/ברזי כיבוי: ${reportData.fireSafety.hydrants.count}

דלתות אש: ${reportData.fireSafety.fireDoors.count}
  - כיווני פתיחה מזוהים: ${reportData.fireSafety.fireDoors.doorSwings}
${reportData.fireSafety.fireDoors.widths.length > 0 ? `  - רוחב דלתות: ${reportData.fireSafety.fireDoors.widths.map(d => d.width.toFixed(2)).join(', ')} יח'` : ''}

יציאות חירום: ${reportData.fireSafety.exits.count}
${reportData.fireSafety.exits.locations.length > 0 ? reportData.fireSafety.exits.locations.slice(0, 10).map(e =>
  `  - "${e.text || e.blockName}" ${e.x !== undefined ? `במיקום (${e.x.toFixed(0)}, ${e.y.toFixed(0)})` : ''}`
).join('\n') : ''}

מדרגות: ${reportData.fireSafety.stairs.count}

קירות אש: ${reportData.fireSafety.fireWalls.count}

מעליות: ${reportData.fireSafety.elevators.count}

=== חדרים ===
מספר חדרים מזוהים: ${reportData.rooms.count}
שטח כולל: ${reportData.rooms.totalArea.toFixed(1)} יח' מרובעות
${reportData.rooms.largest.length > 0 ? `החדרים הגדולים:\n${reportData.rooms.largest.map((r, i) =>
  `  ${i + 1}. שטח ${r.area.toFixed(1)} יח' (שכבה: ${r.layer})`
).join('\n')}` : ''}

=== בלוקים מוגדרים ===
${reportData.blocks.length > 0 ? reportData.blocks.join(', ') : 'לא נמצאו בלוקים'}

=== טקסטים נוספים ===
${reportData.texts.slice(0, 50).map(t => `- "${t.text}" [${t.layer}]${t.position ? ` ${t.position}` : ''}`).join('\n')}
`;

  return text;
}

// ============ MAIN ANALYSIS FUNCTION ============
async function analyzeDXFComplete(filePath) {
  console.log('=== DXF Complete Analysis v13 ===');
  console.log(`File: ${filePath}`);

  // 1. Parse
  console.log('\n[1/5] Parsing DXF...');
  const parsed = await streamParseDXF(filePath);

  // 2. Build object tree
  console.log('\n[2/5] Building object tree...');
  const tree = buildObjectTree(parsed);

  // 3. Classify fire safety elements
  console.log('\n[3/5] Classifying fire safety elements...');
  const classified = classifyFireSafety(tree);

  // 4. Measure distances
  console.log('\n[4/5] Measuring distances...');
  const measurements = measureDistances(classified);

  // 5. Build report data
  console.log('\n[5/5] Building report data...');
  const reportData = buildReportData(tree, classified, measurements);
  const reportText = formatReportForClaude(reportData);

  console.log('\n=== Analysis Complete ===');
  console.log(`Report text: ${reportText.length} characters`);

  return {
    reportText,
    reportData,
    classified,
    measurements,
    tree,
    parsed
  };
}

// Legacy export for compatibility
async function analyzeDXF(filePath) {
  const result = await analyzeDXFComplete(filePath);
  return {
    vectorSummary: result.reportText,
    parsed: {
      entityCount: result.parsed.totalEntities,
      textCount: result.parsed.texts.length,
      circleCount: result.parsed.circles.length,
      arcCount: result.parsed.arcs.length,
      lineCount: result.parsed.lines.length,
      polylineCount: result.parsed.polylines.length
    },
    counts: {
      total: result.parsed.totalEntities,
      texts: result.parsed.texts.length,
      circles: result.parsed.circles.length,
      arcs: result.parsed.arcs.length
    }
  };
}

module.exports = {
  analyzeDXFComplete,
  analyzeDXF,
  streamParseDXF,
  buildObjectTree,
  classifyFireSafety,
  measureDistances,
  buildReportData,
  formatReportForClaude
};
