/**
 * Fire Safety Checker - Server v28
 * DXF: Pure vector analysis (direct parsing)
 * DWG: APS upload -> translate -> extract properties -> Claude
 * Fixes: Metadata retry after SVF2, fresh token, property 202 handling
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// DXF Complete Analyzer
const { analyzeDXFComplete } = require('./dxf-analyzer');

// Document parsing libraries
let pdfParse, mammoth, XLSX;
try { pdfParse = require('pdf-parse'); } catch (e) {}
try { mammoth = require('mammoth'); } catch (e) {}
try { XLSX = require('xlsx'); } catch (e) {}

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Environment variables
const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Directories
const tmpDir = os.tmpdir();
const uploadsDir = path.join(tmpDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer - accept DWG, DXF, ZIP
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.dwg', '.dxf', '.zip'].includes(ext)) cb(null, true);
    else cb(new Error('רק קבצי DWG, DXF או ZIP'));
  }
});

const instructionUpload = multer({ dest: uploadsDir, limits: { fileSize: 50 * 1024 * 1024 } });

let savedInstructions = [];

// ===== FIRE SAFETY PROMPT =====
const FIRE_SAFETY_PROMPT = `אתה מומחה בטיחות אש ישראלי. נתח את נתוני תוכנית הבטיחות וצור דוח מקצועי בעברית.

הנחיות לניתוח:
1. בדוק התאמה לתקנות הבטיחות באש הישראליות
2. בדוק התאמה להוראות נציב כבאות (הנ"כ) 536, 550
3. בדוק התאמה לתקנים ישראליים: ת"י 1220, ת"י 1596, ת"י 1227

קטגוריות: ספרינקלרים, גלאי עשן, גלאי חום, מטפי כיבוי, הידרנטים, דלתות אש, יציאות חירום, מדרגות, קירות אש, מערכות התראה.

החזר JSON:
{
  "overallScore": 0-100,
  "status": "PASS" | "FAIL" | "NEEDS_REVIEW",
  "summary": "סיכום קצר",
  "categories": [{"name": "...", "score": 0-100, "status": "...", "findings": [], "recommendations": []}],
  "criticalIssues": [],
  "positiveFindings": [],
  "detailedReport": "דוח מפורט בעברית"
}`;

// ===== APS AUTHENTICATION =====
async function getAPSToken() {
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    throw new Error('APS credentials not configured');
  }

  const resp = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APS_CLIENT_ID,
      client_secret: APS_CLIENT_SECRET,
      scope: 'data:read data:write data:create bucket:read bucket:create'
    })
  });

  if (!resp.ok) throw new Error(`APS auth failed: ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

// ===== APS BUCKET =====
async function ensureBucket(token) {
  const bucketKey = `firechecker-${APS_CLIENT_ID.toLowerCase().substring(0, 8)}`;

  // Check if exists
  const checkResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/details`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (checkResp.ok) return bucketKey;

  // Create bucket
  const createResp = await fetch('https://developer.api.autodesk.com/oss/v2/buckets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      bucketKey,
      policyKey: 'transient'
    })
  });

  if (!createResp.ok && createResp.status !== 409) {
    throw new Error(`Bucket creation failed: ${createResp.status}`);
  }

  return bucketKey;
}

// ===== APS MULTIPART UPLOAD =====
async function uploadToAPS(token, bucketKey, filePath, fileName) {
  const fileSize = fs.statSync(filePath).size;
  const safeFileName = encodeURIComponent(fileName.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const PART_SIZE = 5 * 1024 * 1024;
  const numParts = Math.ceil(fileSize / PART_SIZE);

  console.log(`📤 Uploading ${(fileSize / 1024 / 1024).toFixed(1)}MB in ${numParts} parts...`);

  // Get signed URLs
  const signedResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}/signeds3upload?parts=${numParts}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!signedResp.ok) throw new Error(`Failed to get signed URLs: ${signedResp.status}`);
  const signedData = await signedResp.json();

  // Upload parts
  const fileData = fs.readFileSync(filePath);
  const eTags = [];

  for (let i = 0; i < numParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, fileSize);
    const partData = fileData.slice(start, end);

    const partResp = await fetch(signedData.urls[i], {
      method: 'PUT',
      headers: { 'Content-Length': partData.length.toString() },
      body: partData
    });

    if (!partResp.ok) throw new Error(`Part ${i + 1} upload failed: ${partResp.status}`);
    eTags.push(partResp.headers.get('ETag'));
    console.log(`   Part ${i + 1}/${numParts} uploaded`);
  }

  // Complete upload
  const completeResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}/signeds3upload`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uploadKey: signedData.uploadKey })
    }
  );

  if (!completeResp.ok) throw new Error(`Upload completion failed: ${completeResp.status}`);
  const result = await completeResp.json();

  const urn = Buffer.from(result.objectId).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  console.log(`✅ Upload complete. URN: ${urn.substring(0, 30)}...`);
  return urn;
}

// ===== APS TRANSLATION (with skip-if-already-done) =====
async function translateToSVF2(token, urn) {
  // BUG FIX #2: Check if already translated
  try {
    const existingResp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (existingResp.ok) {
      const manifest = await existingResp.json();
      const svf2 = manifest.derivatives?.find(d => d.outputType === 'svf2');
      if (svf2 && svf2.status === 'success') {
        console.log('✅ File already translated - skipping translation job');
        return manifest;
      }
    }
  } catch (e) {
    // No existing manifest, proceed with translation
  }

  console.log('🔄 Starting translation job...');
  const resp = await fetch('https://developer.api.autodesk.com/modelderivative/v2/designdata/job', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ads-force': 'true'
    },
    body: JSON.stringify({
      input: { urn },
      output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] }
    })
  });

  if (!resp.ok) {
    const error = await resp.text();
    throw new Error(`Translation job failed: ${resp.status} - ${error}`);
  }

  return await waitForTranslation(token, urn);
}

// ===== WAIT FOR TRANSLATION (BUG FIX #1: check SVF2 derivative) =====
async function waitForTranslation(token, urn) {
  const maxWait = 15 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const manifest = await resp.json();

    // Check if overall manifest is done
    if (manifest.status === 'success' || manifest.status === 'complete') {
      console.log('✅ Translation complete (manifest status)');
      return manifest;
    }

    // BUG FIX #1: Check if SVF2 derivative is done (even if overall is "inprogress")
    const svf2 = manifest.derivatives?.find(d => d.outputType === 'svf2');
    if (svf2 && svf2.status === 'success') {
      console.log('✅ SVF2 derivative complete - proceeding to extraction');
      return manifest;
    }

    if (manifest.status === 'failed') {
      const errorMsg = manifest.derivatives?.find(d => d.status === 'failed')?.messages?.[0]?.message || 'Unknown error';
      throw new Error(`Translation failed: ${errorMsg}`);
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`   Translation: ${manifest.progress || '0%'} (${elapsed}s)`);
    await new Promise(r => setTimeout(r, 5000));
  }

  throw new Error('Translation timeout');
}

// ===== APS METADATA EXTRACTION (with retries) =====
async function getMetadataWithRetry(token, urn) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await resp.json();
    const viewCount = data.data?.metadata?.length || 0;
    console.log(`   Metadata attempt ${attempt + 1}: status=${resp.status}, views=${viewCount}`);

    if (viewCount > 0) {
      console.log('METADATA RAW:', JSON.stringify(data, null, 2));
      return data;
    }

    console.log('   No views yet, waiting 10s...');
    await new Promise(r => setTimeout(r, 10000));
  }
  throw new Error('Metadata not available after retries');
}

async function getPropertiesWithRetry(token, urn, guid) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties?forceget=true`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    console.log(`   Properties attempt ${attempt + 1}: status=${resp.status}`);

    if (resp.status === 200) {
      return await resp.json();
    }
    if (resp.status === 202) {
      console.log('   Properties processing, waiting 15s...');
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    const errorText = await resp.text();
    console.log(`   Properties error: ${resp.status} - ${errorText}`);
    break;
  }
  return null;
}

async function getAPSTree(token, urn, guid) {
  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) return null;
  return await resp.json();
}

// ===== EXTRACT ALL APS DATA =====
async function extractAPSData(urn) {
  console.log('📊 Extracting APS data...');

  // Wait for metadata indexing after SVF2 completes
  console.log('   Waiting 10s for metadata indexing...');
  await new Promise(r => setTimeout(r, 10000));

  // Get fresh token (upload token may have expired)
  console.log('   Getting fresh token...');
  const freshToken = await getAPSToken();

  // Get metadata with retry
  const metadata = await getMetadataWithRetry(freshToken, urn);
  const views = metadata.data?.metadata || [];
  console.log(`   Found ${views.length} views`);

  let allObjects = [];
  let treeSummary = {};

  for (const view of views) {
    console.log(`   Processing view: ${view.name} (${view.role})`);

    // Get properties with retry
    try {
      const props = await getPropertiesWithRetry(freshToken, urn, view.guid);
      if (props) {
        const objects = props.data?.collection || [];
        allObjects.push(...objects);
        console.log(`   Objects from ${view.name}: ${objects.length}`);
      }
    } catch (e) {
      console.log(`   Properties error: ${e.message}`);
    }

    // Get tree structure
    try {
      const tree = await getAPSTree(freshToken, urn, view.guid);
      if (tree?.data?.objects) {
        const countTypes = (nodes) => {
          nodes.forEach(n => {
            treeSummary[n.name] = (treeSummary[n.name] || 0) + 1;
            if (n.objects) countTypes(n.objects);
          });
        };
        countTypes(tree.data.objects);
      }
    } catch (e) {}
  }

  console.log(`✅ Total objects extracted: ${allObjects.length}`);
  return { objects: allObjects, treeSummary, viewCount: views.length };
}

// ===== BUILD DWG REPORT TEXT =====
function buildDWGReportText(apsData) {
  const { objects, treeSummary, viewCount } = apsData;

  // Categorize objects
  const categories = {
    sprinklers: [],
    smokeDetectors: [],
    fireDoors: [],
    exits: [],
    fireExtinguishers: [],
    hydrants: [],
    texts: [],
    blocks: [],
    other: []
  };

  const patterns = {
    sprinklers: /sprink|ספרינק|מתז|head/i,
    smokeDetectors: /smoke|detector|גלאי|עשן/i,
    fireDoors: /fire.?door|דלת.?אש/i,
    exits: /exit|יציאה|מוצא/i,
    fireExtinguishers: /extinguisher|מטף/i,
    hydrants: /hydrant|הידרנט|ברז/i
  };

  objects.forEach(obj => {
    const name = obj.name || '';
    const props = obj.properties || {};
    let categorized = false;

    for (const [cat, pattern] of Object.entries(patterns)) {
      if (pattern.test(name) || pattern.test(JSON.stringify(props))) {
        categories[cat].push({ name, props });
        categorized = true;
        break;
      }
    }

    if (!categorized) {
      if (/text|mtext/i.test(name)) categories.texts.push({ name, props });
      else if (/block|insert/i.test(name)) categories.blocks.push({ name, props });
      else categories.other.push({ name, props });
    }
  });

  let report = `=== נתוני DWG מ-Autodesk APS ===

סיכום כללי:
- מספר אובייקטים: ${objects.length}
- מספר תצוגות: ${viewCount}

מבנה התוכנית:
${Object.entries(treeSummary).slice(0, 20).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}

=== מערכות בטיחות אש ===

ספרינקלרים: ${categories.sprinklers.length}
${categories.sprinklers.slice(0, 10).map(s => `  - ${s.name}`).join('\n')}

גלאי עשן: ${categories.smokeDetectors.length}
${categories.smokeDetectors.slice(0, 10).map(s => `  - ${s.name}`).join('\n')}

דלתות אש: ${categories.fireDoors.length}
${categories.fireDoors.slice(0, 10).map(s => `  - ${s.name}`).join('\n')}

יציאות חירום: ${categories.exits.length}
${categories.exits.slice(0, 10).map(s => `  - ${s.name}`).join('\n')}

מטפי כיבוי: ${categories.fireExtinguishers.length}
הידרנטים: ${categories.hydrants.length}

=== טקסטים ===
${categories.texts.slice(0, 30).map(t => `- ${t.name}`).join('\n')}

=== בלוקים ===
${categories.blocks.slice(0, 30).map(b => `- ${b.name}`).join('\n')}
`;

  return { report, categories };
}

// ===== EXTRACT FROM ZIP =====
function extractFromZip(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.zip') return { filePath, originalName };

  console.log('📦 Extracting from ZIP...');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  const cadEntry = entries.find(e => {
    if (e.isDirectory) return false;
    const eExt = path.extname(e.entryName).toLowerCase();
    return ['.dwg', '.dxf'].includes(eExt);
  });

  if (!cadEntry) throw new Error('ZIP does not contain DWG or DXF file');

  const extractedName = path.basename(cadEntry.entryName);
  const extractedPath = path.join(tmpDir, `extracted_${Date.now()}_${extractedName}`);
  fs.writeFileSync(extractedPath, cadEntry.getData());

  console.log(`✅ Extracted: ${extractedName}`);
  return { filePath: extractedPath, originalName: extractedName };
}

// ===== GENERATE REPORT WITH CLAUDE =====
async function generateReport(reportText, customPrompt = null) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: `${customPrompt || FIRE_SAFETY_PROMPT}\n\n=== נתוני התוכנית ===\n${reportText}`
      }]
    })
  });

  if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
  const data = await resp.json();
  const content = data.content[0].text;

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}

  return { overallScore: 50, status: 'NEEDS_REVIEW', summary: 'ניתוח חלקי', detailedReport: content };
}

// ===== STATIC FILES =====
app.use(express.static('public'));

// ===== API ROUTES =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '28.0.0',
    aps: APS_CLIENT_ID ? 'configured' : 'not configured',
    claude: ANTHROPIC_API_KEY ? 'configured' : 'not configured'
  });
});

app.post('/api/upload-instructions', instructionUpload.single('instructionFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const ext = path.extname(req.file.path).toLowerCase();
    let content = '';
    if (ext === '.pdf' && pdfParse) content = (await pdfParse(fs.readFileSync(req.file.path))).text;
    else if ((ext === '.docx' || ext === '.doc') && mammoth) content = (await mammoth.extractRawText({ path: req.file.path })).value;
    else content = fs.readFileSync(req.file.path, 'utf8');

    const instruction = { id: uuidv4(), name: req.body.name || req.file.originalname, content, createdAt: new Date().toISOString() };
    savedInstructions.push(instruction);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, instruction: { id: instruction.id, name: instruction.name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instructions', (req, res) => {
  res.json(savedInstructions.map(i => ({ id: i.id, name: i.name })));
});

app.delete('/api/instructions/:id', (req, res) => {
  savedInstructions = savedInstructions.filter(i => i.id !== req.params.id);
  res.json({ success: true });
});

// ===== MAIN ANALYSIS ENDPOINT =====
app.post('/api/analyze', upload.single('dwgFile'), async (req, res) => {
  const startTime = Date.now();
  let tempFiles = [];

  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    console.log('\n========================================');
    console.log('🔥 FIRE SAFETY ANALYSIS v27');
    console.log(`📁 ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log('========================================\n');

    tempFiles.push(req.file.path);

    // Extract from ZIP if needed
    const { filePath, originalName } = extractFromZip(req.file.path, req.file.originalname);
    if (filePath !== req.file.path) tempFiles.push(filePath);

    const ext = path.extname(originalName).toLowerCase();
    let reportText, analysisData;

    if (ext === '.dxf') {
      // ===== DXF PATH: Direct parsing =====
      console.log('📐 DXF detected - using direct vector parsing');
      const analysis = await analyzeDXFComplete(filePath);
      reportText = analysis.reportText;
      analysisData = {
        method: 'DXF Vector Parsing',
        entities: analysis.parsed.totalEntities,
        layers: Object.keys(analysis.tree.layers).length,
        texts: analysis.parsed.texts.length,
        fireSafety: analysis.reportData.fireSafety
      };

    } else if (ext === '.dwg') {
      // ===== DWG PATH: APS extraction =====
      console.log('🏗️ DWG detected - using APS extraction');

      if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
        throw new Error('APS credentials not configured. Use DXF format instead.');
      }

      const token = await getAPSToken();
      const bucketKey = await ensureBucket(token);
      const urn = await uploadToAPS(token, bucketKey, filePath, originalName);
      await translateToSVF2(token, urn);
      const apsData = await extractAPSData(urn);
      const dwgReport = buildDWGReportText(apsData);

      reportText = dwgReport.report;
      analysisData = {
        method: 'APS Property Extraction',
        objects: apsData.objects.length,
        views: apsData.viewCount,
        fireSafety: {
          sprinklers: { count: dwgReport.categories.sprinklers.length },
          smokeDetectors: { count: dwgReport.categories.smokeDetectors.length },
          fireDoors: { count: dwgReport.categories.fireDoors.length },
          exits: { count: dwgReport.categories.exits.length }
        }
      };

    } else {
      throw new Error('Unsupported file format. Use DWG or DXF.');
    }

    // Generate Claude report
    console.log('\n🤖 Generating Claude report...');
    let customPrompt = null;
    if (req.body.instructionId && req.body.instructionId !== 'fire-safety') {
      const instr = savedInstructions.find(i => i.id === req.body.instructionId);
      if (instr) customPrompt = instr.content;
    }

    const report = await generateReport(reportText, customPrompt);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Complete in ${totalTime}s - Score: ${report.overallScore}`);

    // Cleanup
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

    res.json({
      success: true,
      fileName: originalName,
      analysisTime: totalTime,
      analysis: analysisData,
      report
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    res.status(500).json({ error: error.message });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('🔥 FIRE SAFETY CHECKER v27');
  console.log('========================================');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📐 DXF: Direct vector parsing`);
  console.log(`🏗️ DWG: APS extraction (${APS_CLIENT_ID ? 'ready' : 'not configured'})`);
  console.log(`🤖 Claude: ${ANTHROPIC_API_KEY ? 'ready' : 'not configured'}`);
  console.log('========================================\n');
});

server.timeout = 900000; // 15 minutes
server.keepAliveTimeout = 600000; // 10 minutes
