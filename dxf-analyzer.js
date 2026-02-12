// dxf-analyzer.js v12 - PURE TEXT EXTRACTION + RAW DIAGNOSTICS
// NO IMAGES. NO SVG. NO PNG. NO SHARP.
// Parses ALL entities, stores only important ones, counts the rest.

const fs = require('fs');
const readline = require('readline');

// ============ RAW FILE DIAGNOSTICS ============
function runRawDiagnostics(filePath) {
  console.log('\n=== RAW FILE DIAGNOSTICS ===');

  const stats = fs.statSync(filePath);
  console.log(`  File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  // Read raw file content
  console.log('  Reading raw file for diagnostics...');
  const rawContent = fs.readFileSync(filePath, 'utf8');
  console.log(`  Raw content length: ${rawContent.length} characters`);

  // Count entity types by searching for the DXF markers
  // In DXF format: code 0 on one line, then entity type on next line
  const entityMarkers = ['TEXT', 'MTEXT', 'ARC', 'CIRCLE', 'INSERT', 'DIMENSION', 'HATCH', 'SPLINE', 'ATTRIB', 'ATTDEF', 'LINE', 'LWPOLYLINE', 'POLYLINE'];
  console.log('  Scanning for entity type markers...');

  entityMarkers.forEach(marker => {
    // DXF format: \n0\nENTITY_TYPE\n or with spaces/tabs
    const regex = new RegExp(`\\n\\s*0\\s*\\n\\s*${marker}\\s*\\n`, 'gi');
    const matches = rawContent.match(regex) || [];
    if (matches.length > 0) {
      console.log(`  RAW SCAN: Found ${matches.length} ${marker} entities`);
    }
  });

  // Also try alternate pattern (some DXF files have different formatting)
  console.log('  Trying alternate entity patterns...');
  entityMarkers.forEach(marker => {
    // Just count occurrences of the entity name after a 0
    const regex = new RegExp(`^\\s*0\\s*$[\\s\\S]*?^\\s*${marker}\\s*$`, 'gim');
    const matches = rawContent.match(regex) || [];
    if (matches.length > 0) {
      console.log(`  RAW SCAN ALT: Found ${matches.length} ${marker} patterns`);
    }
  });

  // Search for Hebrew text content anywhere in the file
  const hebrewRegex = /[\u0590-\u05FF]+/g;
  const hebrewMatches = rawContent.match(hebrewRegex) || [];
  console.log(`  RAW SCAN: Found ${hebrewMatches.length} Hebrew text fragments`);
  if (hebrewMatches.length > 0) {
    const uniqueHebrew = [...new Set(hebrewMatches)].slice(0, 20);
    console.log(`  RAW SCAN: First 20 unique Hebrew texts:`, uniqueHebrew);
  }

  // Search for common fire safety terms
  const fireTerms = ['EXIT', 'FIRE', 'SD', 'SPR', 'FE', 'FD', 'אש', 'יציאה', 'מטף', 'גלאי', 'ספרינקלר', 'מדרגות', 'חירום'];
  console.log('  Searching for fire safety terms...');
  fireTerms.forEach(term => {
    const regex = new RegExp(term, 'gi');
    const matches = rawContent.match(regex) || [];
    if (matches.length > 0) {
      console.log(`  RAW SCAN: "${term}" appears ${matches.length} times`);
    }
  });

  // Check for code 1 (text content marker in DXF)
  const code1Pattern = /\n\s*1\s*\n([^\n]+)/g;
  const code1Matches = [];
  let match;
  while ((match = code1Pattern.exec(rawContent)) !== null && code1Matches.length < 50) {
    const text = match[1].trim();
    if (text.length > 0 && text.length < 200) {
      code1Matches.push(text);
    }
  }
  console.log(`  RAW SCAN: Found ${code1Matches.length} code-1 text values (first 50)`);
  if (code1Matches.length > 0) {
    console.log(`  RAW SCAN: Sample texts:`, code1Matches.slice(0, 20));
  }

  // Check encoding - look for high bytes
  const binaryContent = fs.readFileSync(filePath, 'latin1');
  const highBytes = binaryContent.match(/[\x80-\xFF]/g) || [];
  console.log(`  RAW SCAN: High bytes (non-ASCII): ${highBytes.length}`);

  // Check for ENTITIES section
  const entitiesSectionMatch = rawContent.match(/\n\s*0\s*\nSECTION\s*\n\s*2\s*\nENTITIES/i);
  console.log(`  RAW SCAN: ENTITIES section found: ${entitiesSectionMatch ? 'YES' : 'NO'}`);

  // Check for BLOCKS section
  const blocksSectionMatch = rawContent.match(/\n\s*0\s*\nSECTION\s*\n\s*2\s*\nBLOCKS/i);
  console.log(`  RAW SCAN: BLOCKS section found: ${blocksSectionMatch ? 'YES' : 'NO'}`);

  // Count total lines
  const lineCount = rawContent.split('\n').length;
  console.log(`  RAW SCAN: Total lines in file: ${lineCount}`);

  console.log('=== END RAW DIAGNOSTICS ===\n');

  return {
    fileSize: stats.size,
    charCount: rawContent.length,
    lineCount,
    hebrewCount: hebrewMatches.length,
    highByteCount: highBytes.length,
    code1Count: code1Matches.length,
    sampleTexts: code1Matches.slice(0, 20)
  };
}

// ============ STREAMING PARSER - PARSES ALL ENTITIES ============
async function parseDXFStreaming(filePath) {
  return new Promise((resolve, reject) => {
    console.log('  DXF Parser v12 - Full parse, no truncation...');

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

    const blocks = {};
    const layers = {};

    // CRITICAL: Store ALL texts and circles, sample arcs, count everything else
    const texts = [];       // Store ALL - CRITICAL for analysis
    const circles = [];     // Store ALL - potential symbols
    const arcSamples = [];  // Store samples for door detection
    const blockRefs = [];   // Store ALL block references

    // Just count these - don't store coordinates
    let lineCount = 0;
    let arcCount = 0;
    let polylineCount = 0;
    let closedPolyCount = 0;
    let otherCount = 0;
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

      // Handle polyline closure detection
      if ((entityType === 'LWPOLYLINE' || entityType === 'POLYLINE') && curVx !== null) {
        entityVerts.push({ x: curVx, y: 0 });
      }
      if (entityVerts.length >= 3) {
        const first = entityVerts[0];
        const last = entityVerts[entityVerts.length - 1];
        const isClosed = Math.hypot(first.x - last.x, first.y - last.y) < 0.1;
        if (isClosed) closedPolyCount++;
      }

      // Store based on type - KEEP ALL important entities
      switch (entityType) {
        case 'TEXT':
        case 'MTEXT':
        case 'ATTRIB':
        case 'ATTDEF':
          // ALWAYS store ALL text entities - these are CRITICAL
          if (entityData.text) {
            texts.push({
              text: entityData.text,
              x: entityData.x,
              y: entityData.y,
              layer: entityData.layer || '0',
              height: entityData.height
            });
          }
          break;

        case 'CIRCLE':
          // ALWAYS store ALL circles - potential fire safety symbols
          circles.push({
            x: entityData.x,
            y: entityData.y,
            r: entityData.radius,
            layer: entityData.layer || '0'
          });
          break;

        case 'ARC':
          arcCount++;
          // Keep samples for door swing detection (90° arcs with typical door radius)
          if (arcSamples.length < 1000) {
            const sweep = Math.abs((entityData.endAngle || 0) - (entityData.startAngle || 0));
            const r = entityData.radius || 0;
            // Door swings: ~90° sweep, 0.7-1.5m radius
            if (sweep >= 80 && sweep <= 100 && r >= 0.5 && r <= 2.0) {
              arcSamples.push({
                x: entityData.x,
                y: entityData.y,
                r: r,
                sweep: sweep,
                layer: entityData.layer || '0'
              });
            }
          }
          break;

        case 'INSERT':
          // Store ALL block references - they indicate symbols
          blockRefs.push({
            blockName: entityData.blockName,
            x: entityData.x,
            y: entityData.y,
            layer: entityData.layer || '0'
          });
          break;

        case 'LINE':
          lineCount++;
          // Don't store coordinates - just count
          break;

        case 'LWPOLYLINE':
        case 'POLYLINE':
          polylineCount++;
          // Don't store coordinates - just count
          break;

        default:
          otherCount++;
      }

      // Reset for next entity
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
            if (currentBlockName) {
              blocks[currentBlockName] = true; // Just track that block exists
            }
            inBlock = false;
            currentBlockName = null;
            return;
          }
        }

        if (currentSection === 'TABLES') {
          if (value === 'LAYER') {
            parsingLayer = true;
            layerData = { name: '', color: 7 };
            return;
          }
          if (parsingLayer && value !== 'LAYER') {
            if (layerData.name) {
              layers[layerData.name] = { color: layerData.color };
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
          case 40:
            entityData.radius = parseFloat(value);
            entityData.height = parseFloat(value);
            break;
          case 50: entityData.startAngle = parseFloat(value); break;
          case 51: entityData.endAngle = parseFloat(value); break;
        }
      }
    }

    // Progress logging
    let lineNumber = 0;
    const logInterval = 500000;

    rl.on('line', (line) => {
      lineNumber++;
      if (lineNumber % logInterval === 0) {
        console.log(`    Parsed ${(lineNumber / 1000000).toFixed(1)}M lines, ${totalEntities} entities, ${texts.length} texts...`);
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
      console.log(`    TEXT/MTEXT: ${texts.length}`);
      console.log(`    CIRCLE: ${circles.length}`);
      console.log(`    ARC: ${arcCount} (${arcSamples.length} door-like samples)`);
      console.log(`    LINE: ${lineCount}`);
      console.log(`    POLYLINE: ${polylineCount} (${closedPolyCount} closed)`);
      console.log(`    Block refs: ${blockRefs.length}`);
      console.log(`    Blocks defined: ${Object.keys(blocks).length}`);
      console.log(`    Layers: ${Object.keys(layers).length}`);

      resolve({
        texts,
        circles,
        arcSamples,
        blockRefs,
        blocks: Object.keys(blocks),
        layers: Object.keys(layers),
        counts: {
          total: totalEntities,
          texts: texts.length,
          circles: circles.length,
          arcs: arcCount,
          arcSamples: arcSamples.length,
          lines: lineCount,
          polylines: polylineCount,
          closedPolys: closedPolyCount,
          blockRefs: blockRefs.length,
          blocks: Object.keys(blocks).length,
          layers: Object.keys(layers).length
        }
      });
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

// ============ BUILD TEXT SUMMARY FOR CLAUDE ============
function buildVectorSummary(parsed) {
  const { texts, circles, arcSamples, blockRefs, blocks, layers, counts } = parsed;

  let summary = `
=== DXF VECTOR DATA ANALYSIS ===

ENTITY COUNTS (parsed ${counts.total.toLocaleString()} total entities):
- TEXT/MTEXT labels: ${counts.texts}
- CIRCLE entities: ${counts.circles}
- ARC entities: ${counts.arcs} (${counts.arcSamples} appear to be door swings)
- LINE entities: ${counts.lines.toLocaleString()}
- POLYLINE entities: ${counts.polylines.toLocaleString()} (${counts.closedPolys} closed/rooms)
- Block references: ${counts.blockRefs}
- Blocks defined: ${counts.blocks}
- Layers: ${counts.layers}

LAYERS: ${layers.join(', ') || 'Only layer 0'}

`;

  // ALL TEXT CONTENT - CRITICAL
  summary += `=== ALL TEXT LABELS (${texts.length} found) ===\n`;
  if (texts.length === 0) {
    summary += 'WARNING: No text entities found. The drawing may be using blocks or attributes for labels.\n';
  } else {
    texts.forEach((t, i) => {
      const pos = t.x !== undefined ? ` at (${t.x.toFixed(1)}, ${t.y.toFixed(1)})` : '';
      const layer = t.layer !== '0' ? ` [${t.layer}]` : '';
      summary += `${i + 1}. "${t.text}"${pos}${layer}\n`;
    });
  }

  // CIRCLE PATTERNS (potential symbols)
  summary += `\n=== CIRCLE PATTERNS (${circles.length} circles) ===\n`;
  if (circles.length > 0) {
    // Group by radius
    const byRadius = {};
    circles.forEach(c => {
      if (c.r === undefined) return;
      const rKey = c.r.toFixed(2);
      if (!byRadius[rKey]) byRadius[rKey] = { count: 0, samples: [] };
      byRadius[rKey].count++;
      if (byRadius[rKey].samples.length < 3) {
        byRadius[rKey].samples.push({ x: c.x, y: c.y, layer: c.layer });
      }
    });

    const sorted = Object.entries(byRadius).sort((a, b) => b[1].count - a[1].count);
    sorted.slice(0, 20).forEach(([r, info]) => {
      const samples = info.samples.map(s => `(${s.x?.toFixed(0)},${s.y?.toFixed(0)})`).join(', ');
      summary += `- Radius ${r}: ${info.count} circles`;
      if (info.count >= 10) summary += ' [LIKELY SYMBOL PATTERN]';
      summary += `\n  Samples: ${samples}\n`;
    });
  }

  // ARC SAMPLES (door swings)
  summary += `\n=== DOOR SWING ARCS (${counts.arcSamples} detected) ===\n`;
  if (arcSamples.length > 0) {
    const radii = [...new Set(arcSamples.map(a => a.r?.toFixed(2)))];
    summary += `Door swing radii found: ${radii.join(', ')} units\n`;
    summary += `Estimated door count: ${arcSamples.length}\n`;
  }

  // BLOCK REFERENCES
  summary += `\n=== BLOCK REFERENCES ===\n`;
  if (blockRefs.length === 0) {
    summary += 'No block references found (drawing may be exploded).\n';
  } else {
    const blockCounts = {};
    blockRefs.forEach(b => {
      blockCounts[b.blockName] = (blockCounts[b.blockName] || 0) + 1;
    });
    Object.entries(blockCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .forEach(([name, count]) => {
        summary += `- ${name}: ${count} instances\n`;
      });
  }

  // FIRE SAFETY KEYWORD SEARCH
  summary += `\n=== FIRE SAFETY KEYWORDS FOUND ===\n`;
  const fireKeywords = {
    'ספרינקלר/מתז': /ספרינק|מתז|SPRINK|SPR[-_]?\d/i,
    'גלאי עשן': /גלאי.?עשן|עשן|SMOKE|SD[-_]?\d/i,
    'גלאי חום': /גלאי.?חום|חום|HEAT|HD[-_]?\d/i,
    'מטף כיבוי': /מטף|מטפה|EXTING|FE[-_]?\d/i,
    'הידרנט': /הידרנט|ברז.?כיבוי|ברז.?אש|HYDRANT|FH|IH/i,
    'יציאה/מוצא': /יציאה|מוצא|EXIT/i,
    'מדרגות': /מדרגות|STAIR/i,
    'דלת אש': /דלת.?אש|FIRE.?DOOR|FD/i,
    'חירום': /חירום|EMERGENCY|EMERG/i,
    'קיר אש': /קיר.?אש|FIRE.?WALL/i,
    'מעלית': /מעלית|ELEVATOR|LIFT/i,
  };

  Object.entries(fireKeywords).forEach(([name, pattern]) => {
    const matches = texts.filter(t => pattern.test(t.text || ''));
    if (matches.length > 0) {
      summary += `\n${name}: ${matches.length} labels\n`;
      matches.slice(0, 5).forEach(m => {
        summary += `  - "${m.text}" at (${m.x?.toFixed(0)}, ${m.y?.toFixed(0)})\n`;
      });
    }
  });

  // Check block names for fire safety
  const fireBlockPattern = /SPRINK|SMOKE|FIRE|EXIT|EXTING|HYDRANT|DETECT|ALARM|SPR|SD|FE|FH|FD/i;
  const fireBlocks = blocks.filter(b => fireBlockPattern.test(b));
  if (fireBlocks.length > 0) {
    summary += `\nFire-related blocks: ${fireBlocks.join(', ')}\n`;
  }

  // Check block references for fire safety
  const fireRefs = blockRefs.filter(b => fireBlockPattern.test(b.blockName || ''));
  if (fireRefs.length > 0) {
    const refCounts = {};
    fireRefs.forEach(r => { refCounts[r.blockName] = (refCounts[r.blockName] || 0) + 1; });
    summary += `\nFire-related block placements:\n`;
    Object.entries(refCounts).forEach(([name, count]) => {
      summary += `  - ${name}: ${count} instances\n`;
    });
  }

  return summary;
}

// ============ MAIN FUNCTION - NO IMAGES ============
async function analyzeDXF(filePath) {
  console.log('DXF Analysis v12 - Pure text extraction (NO IMAGES)...');

  // STEP 1: Run raw diagnostics BEFORE parsing
  const diagnostics = runRawDiagnostics(filePath);

  // STEP 2: Parse with streaming
  const parsed = await parseDXFStreaming(filePath);

  console.log('  Building vector summary for Claude...');
  const vectorSummary = buildVectorSummary(parsed);

  console.log(`  Summary: ${vectorSummary.length} characters`);

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
    console.log('  Memory cleaned');
  }

  return {
    vectorSummary,
    parsed: {
      entityCount: parsed.counts.total,
      textCount: parsed.counts.texts,
      circleCount: parsed.counts.circles,
      arcCount: parsed.counts.arcs,
      lineCount: parsed.counts.lines,
      polylineCount: parsed.counts.polylines,
      closedPolyCount: parsed.counts.closedPolys,
      blockRefCount: parsed.counts.blockRefs,
      blockCount: parsed.counts.blocks,
      layerCount: parsed.counts.layers
    },
    counts: parsed.counts
  };
}

module.exports = {
  analyzeDXF,
  parseDXFStreaming,
  buildVectorSummary
};
