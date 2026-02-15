/**
 * Fire Safety Checker - Server v34
 * HYBRID: Local libredwg first, APS fallback
 * DWG: Try dwg2dxf (libredwg) -> if fails, use APS
 * DXF: Direct parsing with dxf-analyzer
 * DWF: Extract from ZIP and parse embedded data
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
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

// Multer - accept DWG, DXF, DWF, ZIP
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.dwg', '.dxf', '.dwf', '.zip'].includes(ext)) cb(null, true);
    else cb(new Error('רק קבצי DWG, DXF, DWF או ZIP'));
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

// ===== CHECK LIBREDWG AVAILABILITY =====
function isLibredwgAvailable() {
  try {
    execSync('which dwg2dxf || where dwg2dxf 2>&1', { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    return false;
  }
}

// ===== CONVERT DWG TO DXF USING LIBREDWG =====
function convertDWGtoDXF(dwgPath) {
  const dxfPath = dwgPath.replace(/\.dwg$/i, '.dxf');

  console.log('🔄 Converting DWG to DXF using libredwg...');

  try {
    execSync(`dwg2dxf "${dwgPath}"`, {
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (fs.existsSync(dxfPath)) {
      const size = fs.statSync(dxfPath).size;
      console.log(`✅ Converted to DXF: ${(size / 1024 / 1024).toFixed(2)} MB`);
      return dxfPath;
    }
  } catch (err) {
    console.log(`⚠️ dwg2dxf failed: ${err.message}`);
  }

  // Try dwgread fallback
  try {
    execSync(`dwgread -o "${dxfPath}" "${dwgPath}"`, {
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (fs.existsSync(dxfPath)) {
      const size = fs.statSync(dxfPath).size;
      console.log(`✅ Converted with dwgread: ${(size / 1024 / 1024).toFixed(2)} MB`);
      return dxfPath;
    }
  } catch (err2) {
    console.log(`⚠️ dwgread failed: ${err2.message}`);
  }

  return null; // Return null to signal fallback to APS
}

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

  const checkResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/details`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (checkResp.ok) return bucketKey;

  const createResp = await fetch('https://developer.api.autodesk.com/oss/v2/buckets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ bucketKey, policyKey: 'transient' })
  });

  if (!createResp.ok && createResp.status !== 409) {
    throw new Error(`Bucket creation failed: ${createResp.status}`);
  }

  return bucketKey;
}

// ===== APS UPLOAD =====
async function uploadToAPS(token, bucketKey, filePath, fileName) {
  const fileSize = fs.statSync(filePath).size;
  const ext = path.extname(fileName).toLowerCase();
  const safeFileName = `plan_${Date.now()}${ext}`;

  console.log(`📤 Uploading to APS: ${fileName} -> ${safeFileName}`);

  const PART_SIZE = 5 * 1024 * 1024;
  const numParts = Math.ceil(fileSize / PART_SIZE);

  const signedResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}/signeds3upload?parts=${numParts}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!signedResp.ok) throw new Error(`Failed to get signed URLs: ${signedResp.status}`);
  const signedData = await signedResp.json();

  const fileData = fs.readFileSync(filePath);

  for (let i = 0; i < numParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, fileSize);
    const partData = fileData.slice(start, end);

    const partResp = await fetch(signedData.urls[i], {
      method: 'PUT',
      headers: { 'Content-Length': partData.length.toString() },
      body: partData
    });

    if (!partResp.ok) throw new Error(`Part ${i + 1} upload failed`);
    console.log(`   Part ${i + 1}/${numParts} ✓`);
  }

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

  if (!completeResp.ok) throw new Error('Upload completion failed');
  const result = await completeResp.json();
  const urn = Buffer.from(result.objectId).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  console.log(`✅ Upload complete. URN: ${urn.substring(0, 30)}...`);
  return urn;
}

// ===== APS TRANSLATION =====
async function translateToSVF2(token, urn) {
  // Delete old manifest
  try {
    await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
    );
  } catch (e) {}

  await new Promise(r => setTimeout(r, 3000));

  console.log('🔄 Submitting translation job...');
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

// ===== WAIT FOR TRANSLATION =====
async function waitForTranslation(token, urn) {
  const maxWait = 15 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const manifest = await resp.json();

    if (manifest.status === 'success' || manifest.status === 'complete') {
      console.log('✅ Translation complete');
      return manifest;
    }

    const svf2 = manifest.derivatives?.find(d => d.outputType === 'svf2');
    if (svf2?.status === 'success') {
      console.log('✅ SVF2 derivative complete');
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

// ===== APS METADATA EXTRACTION =====
async function extractAPSData(token, urn) {
  console.log('📊 Extracting APS metadata...');

  // Wait for indexing
  await new Promise(r => setTimeout(r, 10000));

  // Get fresh token
  const freshToken = await getAPSToken();

  // Get metadata views (with retry)
  let views = [];
  for (let i = 0; i < 12; i++) {
    const metaResp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
      { headers: { 'Authorization': `Bearer ${freshToken}` } }
    );
    const metadata = await metaResp.json();
    views = metadata.data?.metadata || [];

    if (views.length > 0) break;
    console.log(`   Waiting for metadata... (attempt ${i + 1})`);
    await new Promise(r => setTimeout(r, 10000));
  }

  console.log(`   Found ${views.length} views`);

  if (views.length === 0) {
    return { objects: [], treeSummary: {}, viewCount: 0 };
  }

  const validGuid = views[0].guid;
  let allObjects = [];
  let treeSummary = {};

  // Get properties (with retry for 202)
  console.log('   Fetching properties...');
  for (let attempt = 1; attempt <= 20; attempt++) {
    const propsResp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${validGuid}/properties?forceget=true`,
      { headers: { 'Authorization': `Bearer ${freshToken}` } }
    );

    if (propsResp.status === 200) {
      const propsData = await propsResp.json();
      allObjects = propsData.data?.collection || [];
      console.log(`   ✅ Found ${allObjects.length} objects`);
      break;
    }

    if (propsResp.status === 202) {
      console.log(`   Properties processing... (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    break;
  }

  // Get tree (with retry for 202)
  console.log('   Fetching object tree...');
  for (let attempt = 1; attempt <= 20; attempt++) {
    const treeResp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${validGuid}?forceget=true`,
      { headers: { 'Authorization': `Bearer ${freshToken}` } }
    );

    if (treeResp.status === 200) {
      const treeData = await treeResp.json();
      if (treeData?.data?.objects) {
        const countTypes = (nodes) => {
          nodes.forEach(n => {
            treeSummary[n.name] = (treeSummary[n.name] || 0) + 1;
            if (n.objects) countTypes(n.objects);
          });
        };
        countTypes(treeData.data.objects);
      }
      break;
    }

    if (treeResp.status === 202) {
      console.log(`   Tree processing... (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    break;
  }

  return { objects: allObjects, treeSummary, viewCount: views.length };
}

// ===== BUILD APS REPORT TEXT =====
function buildAPSReportText(apsData) {
  const { objects, treeSummary, viewCount } = apsData;

  const categories = {
    sprinklers: [], smokeDetectors: [], fireDoors: [], exits: [],
    fireExtinguishers: [], hydrants: [], texts: [], blocks: [], other: []
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

  let report = `=== נתוני DWG מ-APS ===

סיכום:
- אובייקטים: ${objects.length}
- תצוגות: ${viewCount}

מבנה:
${Object.entries(treeSummary).slice(0, 20).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}

=== מערכות בטיחות אש ===
ספרינקלרים: ${categories.sprinklers.length}
גלאי עשן: ${categories.smokeDetectors.length}
דלתות אש: ${categories.fireDoors.length}
יציאות חירום: ${categories.exits.length}
מטפי כיבוי: ${categories.fireExtinguishers.length}
הידרנטים: ${categories.hydrants.length}

=== טקסטים ===
${categories.texts.slice(0, 50).map(t => `- ${t.name}`).join('\n')}

=== בלוקים ===
${categories.blocks.slice(0, 50).map(b => `- ${b.name}`).join('\n')}
`;

  return { report, categories };
}

// ===== EXTRACT DWF =====
function extractDWF(dwfPath) {
  console.log('📦 Extracting DWF...');

  const zip = new AdmZip(dwfPath);
  const entries = zip.getEntries();

  let extractedData = { manifest: null, sections: [], graphics: [], texts: [] };

  entries.forEach(entry => {
    const name = entry.entryName;

    if (name.toLowerCase().includes('manifest') && name.endsWith('.xml')) {
      extractedData.manifest = entry.getData().toString('utf8');
    }

    if (name.endsWith('.xml') && !name.includes('manifest')) {
      try {
        const content = entry.getData().toString('utf8');
        extractedData.sections.push({ name, content });
        const textMatches = content.match(/<Text[^>]*>([^<]+)<\/Text>/gi) || [];
        textMatches.forEach(match => {
          const text = match.replace(/<[^>]+>/g, '').trim();
          if (text.length > 0) extractedData.texts.push(text);
        });
      } catch (e) {}
    }

    if (name.match(/\.(w2d|f2d)$/i)) {
      extractedData.graphics.push({ name, size: entry.header.size });
    }
  });

  return extractedData;
}

// ===== BUILD DWF REPORT =====
function buildDWFReportText(dwfData) {
  const fireSafety = {
    sprinklers: 0, smokeDetectors: 0, exits: 0,
    fireDoors: 0, extinguishers: 0, hydrants: 0
  };

  dwfData.texts.forEach(text => {
    const lower = text.toLowerCase();
    if (/sprink|ספרינק|מתז/.test(lower)) fireSafety.sprinklers++;
    if (/smoke|גלאי|עשן/.test(lower)) fireSafety.smokeDetectors++;
    if (/exit|יציאה|מוצא/.test(lower)) fireSafety.exits++;
    if (/fire.?door|דלת.?אש/.test(lower)) fireSafety.fireDoors++;
    if (/extinguisher|מטף/.test(lower)) fireSafety.extinguishers++;
    if (/hydrant|הידרנט|ברז.?כיבוי/.test(lower)) fireSafety.hydrants++;
  });

  let report = `=== נתוני DWF ===
גרפיקה: ${dwfData.graphics.length}
סקשנים: ${dwfData.sections.length}
טקסטים: ${dwfData.texts.length}

=== טקסטים ===
${dwfData.texts.slice(0, 100).join('\n')}

=== בטיחות אש ===
ספרינקלרים: ${fireSafety.sprinklers}
גלאי עשן: ${fireSafety.smokeDetectors}
יציאות: ${fireSafety.exits}
דלתות אש: ${fireSafety.fireDoors}
מטפים: ${fireSafety.extinguishers}
הידרנטים: ${fireSafety.hydrants}
`;

  return { report, fireSafety };
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
    return ['.dwg', '.dxf', '.dwf'].includes(eExt);
  });

  if (!cadEntry) throw new Error('ZIP does not contain DWG, DXF, or DWF file');

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
    version: '34.0.0',
    libredwg: isLibredwgAvailable() ? 'installed' : 'not installed',
    aps: APS_CLIENT_ID ? 'configured (fallback)' : 'not configured',
    claude: ANTHROPIC_API_KEY ? 'configured' : 'not configured',
    mode: 'Hybrid: libredwg primary, APS fallback'
  });
});

app.post('/api/upload-instructions', instructionUpload.single('instructionFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let content = '';
    if (ext === '.pdf' && pdfParse) content = (await pdfParse(fs.readFileSync(req.file.path))).text;
    else if ((ext === '.docx' || ext === '.doc') && mammoth) content = (await mammoth.extractRawText({ path: req.file.path })).value;
    else if ((ext === '.xlsx' || ext === '.xls') && XLSX) {
      const workbook = XLSX.readFile(req.file.path);
      content = workbook.SheetNames.map(name => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join('\n\n');
    }
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
    console.log('🔥 FIRE SAFETY ANALYSIS v34 (Hybrid)');
    console.log(`📁 ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log('========================================\n');

    tempFiles.push(req.file.path);

    // Extract from ZIP if needed
    let { filePath, originalName } = extractFromZip(req.file.path, req.file.originalname);
    if (filePath !== req.file.path) tempFiles.push(filePath);

    let ext = path.extname(originalName).toLowerCase();
    let reportText, analysisData;

    // ===== DWG: Try libredwg first, then APS fallback =====
    if (ext === '.dwg') {
      console.log('📐 DWG detected');

      // Try libredwg first
      if (isLibredwgAvailable()) {
        console.log('   Trying libredwg conversion...');
        const dxfPath = convertDWGtoDXF(filePath);

        if (dxfPath) {
          tempFiles.push(dxfPath);
          console.log('   ✅ Libredwg succeeded, parsing DXF...');
          const analysis = await analyzeDXFComplete(dxfPath);
          reportText = analysis.reportText;
          analysisData = {
            method: 'libredwg + DXF Parsing',
            entities: analysis.parsed.totalEntities,
            layers: Object.keys(analysis.tree.layers).length,
            texts: analysis.parsed.texts.length,
            fireSafety: analysis.reportData.fireSafety
          };
        }
      }

      // APS fallback if libredwg failed or unavailable
      if (!reportText) {
        if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
          throw new Error('libredwg failed and APS not configured. Cannot process DWG file.');
        }

        console.log('   ⚠️ Libredwg unavailable/failed, using APS fallback...');
        const token = await getAPSToken();
        const bucketKey = await ensureBucket(token);
        const urn = await uploadToAPS(token, bucketKey, filePath, originalName);
        await translateToSVF2(token, urn);
        const apsData = await extractAPSData(token, urn);
        const apsReport = buildAPSReportText(apsData);

        reportText = apsReport.report;
        analysisData = {
          method: 'APS Cloud Extraction',
          objects: apsData.objects.length,
          views: apsData.viewCount,
          fireSafety: {
            sprinklers: { count: apsReport.categories.sprinklers.length },
            smokeDetectors: { count: apsReport.categories.smokeDetectors.length },
            fireDoors: { count: apsReport.categories.fireDoors.length },
            exits: { count: apsReport.categories.exits.length }
          }
        };
      }
    }

    // ===== DXF: Direct parsing =====
    else if (ext === '.dxf') {
      console.log('📐 Parsing DXF...');
      const analysis = await analyzeDXFComplete(filePath);
      reportText = analysis.reportText;
      analysisData = {
        method: 'DXF Vector Parsing',
        entities: analysis.parsed.totalEntities,
        layers: Object.keys(analysis.tree.layers).length,
        texts: analysis.parsed.texts.length,
        fireSafety: analysis.reportData.fireSafety
      };
    }

    // ===== DWF: Extract and parse =====
    else if (ext === '.dwf') {
      console.log('📦 Extracting DWF...');
      const dwfData = extractDWF(filePath);
      const dwfReport = buildDWFReportText(dwfData);
      reportText = dwfReport.report;
      analysisData = {
        method: 'DWF Extraction',
        graphics: dwfData.graphics.length,
        sections: dwfData.sections.length,
        texts: dwfData.texts.length,
        fireSafety: dwfReport.fireSafety
      };
    }

    else {
      throw new Error('Unsupported format. Use DWG, DXF, or DWF.');
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
  const libredwg = isLibredwgAvailable();

  console.log('\n========================================');
  console.log('🔥 FIRE SAFETY CHECKER v34 (Hybrid)');
  console.log('========================================');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📐 DXF: Direct vector parsing`);
  console.log(`🔄 DWG Primary: libredwg (${libredwg ? '✅ installed' : '❌ not installed'})`);
  console.log(`☁️  DWG Fallback: APS (${APS_CLIENT_ID ? '✅ configured' : '❌ not configured'})`);
  console.log(`📦 DWF: ZIP extraction`);
  console.log(`🤖 Claude: ${ANTHROPIC_API_KEY ? '✅ ready' : '❌ not configured'}`);
  console.log('========================================\n');
});

server.timeout = 900000;
server.keepAliveTimeout = 600000;
