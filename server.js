/**
 * Fire Safety & Compliance Checker - Server v37
 *
 * TWO MODES:
 * 1. Fire Safety Mode - Existing functionality
 * 2. Compliance Mode - Building permit compliance checking
 *    - Upload reference docs (תקנון, גליון דרישות) → Extract requirements
 *    - Upload plans → Check against extracted requirements
 *
 * HIGH-RES VISION: Puppeteer captures 4096x4096 screenshot from APS Viewer
 * Splits into 9 zones + full image -> Claude Vision analysis
 * DWG: APS upload -> SVF2 -> Puppeteer screenshot -> Vision
 * DXF: Direct parsing (fallback)
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

// DXF Analyzer
const { analyzeDXFComplete } = require('./dxf-analyzer');

// Puppeteer and Sharp for high-res capture
let puppeteer, sharp;
try { puppeteer = require('puppeteer'); } catch (e) { console.log('Puppeteer not available'); }
try { sharp = require('sharp'); } catch (e) { console.log('Sharp not available'); }

// Document parsing
let pdfParse, mammoth, XLSX;
try { pdfParse = require('pdf-parse'); } catch (e) {}
try { mammoth = require('mammoth'); } catch (e) {}
try { XLSX = require('xlsx'); } catch (e) {}

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Environment
const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Directories
const tmpDir = os.tmpdir();
const uploadsDir = path.join(tmpDir, 'uploads');
const screenshotsDir = path.join(tmpDir, 'screenshots');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

// Static screenshots directory for serving images
const publicScreenshotsDir = path.join(__dirname, 'public', 'screenshots');
if (!fs.existsSync(publicScreenshotsDir)) fs.mkdirSync(publicScreenshotsDir, { recursive: true });

// Multer
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

// Reference document upload (for compliance mode)
const referenceUpload = multer({
  dest: uploadsDir,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.txt'].includes(ext)) cb(null, true);
    else cb(new Error('נתמכים רק קבצי PDF, Word, Excel או טקסט'));
  }
});

let savedInstructions = [];

// Store screenshots and zones in memory for serving
const screenshotCache = new Map();

// ===== PROJECT STORAGE FOR COMPLIANCE MODE =====
const projects = new Map();

// Cleanup projects older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, project] of projects) {
    if (project.createdAt < cutoff) {
      console.log(`🧹 Cleaning up old project: ${id}`);
      projects.delete(id);
    }
  }
}, 60 * 60 * 1000);

// ===== COMPLIANCE PROMPTS =====
const REFERENCE_EXTRACTION_PROMPT = `אתה מומחה היתרי בנייה ישראלי. קרא את מסמך הייחוס הזה וחלץ רשימה מובנית של כל הדרישות, כללים ותנאים שמוזכרים.

לכל דרישה חלץ:
- id: מזהה קצר וייחודי (בפורמט REQ-001, REQ-002 וכו')
- category: קטגוריה/שלב (קליטת בקשה, בקרת תכן, טופס 2, טופס 4, כללי)
- description_he: הדרישה בעברית
- check_type: סוג הבדיקה - אחד מ:
  - 'visual_plan_check' - בדיקה ויזואלית בתכנית
  - 'document_exists' - בדיקת קיום מסמך
  - 'measurement_check' - בדיקת מידות/שטחים
  - 'marking_check' - בדיקת סימון בתכנית
  - 'manual' - בדיקה ידנית נדרשת
- details: פרטים ספציפיים (ערכים, מידות)
- regulation_reference: הפניה לחוק/תקן (אם יש)

בנוסף, חלץ גבולות מספריים:
- max_building_area: שטח בנייה מותר
- max_coverage: תכסית מקסימלית (%)
- max_floors: מספר קומות מקסימלי
- max_height: גובה מקסימלי (מ')
- setbacks: קווי בניין (מטרים)
- parking_ratio: יחס חניה (מ"ר לחניה)
- landscape_ratio: שטח גינון (%)

החזר JSON בפורמט:
{
  "requirements": [...],
  "numericLimits": {...},
  "projectInfo": {
    "taba_number": "מספר תב\"ע",
    "location": "מיקום",
    "permitted_uses": ["שימושים מותרים"]
  }
}`;

const COMPLIANCE_CHECK_PROMPT = `אתה בודק היתרי בנייה ישראלי. בדוק את התכנית הזו מול הדרישות הבאות.

=== דרישות לבדיקה ===
{REQUIREMENTS}

=== גבולות מספריים ===
{NUMERIC_LIMITS}

לכל דרישה קבע:
- requirementId: המזהה מהרשימה
- status: אחד מ:
  - 'pass' - התכנית עומדת בדרישה
  - 'fail' - התכנית לא עומדת בדרישה
  - 'needs_review' - נדרשת בדיקה ידנית
  - 'not_applicable' - לא רלוונטי לתכנית זו
- finding_he: מה מצאת (בעברית)
- confidence: רמת ביטחון 0-100
- location_in_plan: איפה בתכנית (אם רלוונטי)

גם זהה:
- plan_type: סוג התכנית (קומת קרקע, חזית, חתך, מפלס וכו')
- detected_measurements: מידות שזוהו
- potential_issues: בעיות פוטנציאליות שלא קשורות לדרישות

החזר JSON בפורמט:
{
  "planType": "...",
  "results": [...],
  "detectedMeasurements": {...},
  "potentialIssues": [...],
  "overallCompliance": 0-100
}`;

// ===== FIRE SAFETY VISION PROMPT =====
const FIRE_SAFETY_VISION_PROMPT = `אתה מומחה בטיחות אש ישראלי. לפניך תוכנית אדריכלית ברזולוציה גבוהה.

נתח את התוכנית וזהה:
1. ספרינקלרים - סמן מיקומים, ספור כמות, בדוק מרחקים
2. גלאי עשן - זהה סוג וכמות
3. דלתות אש - בדוק סימון, כיוון פתיחה
4. יציאות חירום - בדוק סימון, רוחב, נגישות
5. מטפי כיבוי - מיקום ונגישות
6. הידרנטים - מיקום פנימי/חיצוני
7. מדרגות - בדוק הפרדת אש, עישון
8. קירות אש - זהה עמידות אש
9. טקסטים בעברית - קרא את כל הכיתובים

בדוק התאמה ל:
- הוראות נציב כבאות (הנ"כ) 536, 550
- תקנים ישראליים: ת"י 1220, ת"י 1596, ת"י 1227

החזר JSON בפורמט:
{
  "overallScore": 0-100,
  "status": "PASS" | "FAIL" | "NEEDS_REVIEW",
  "summary": "סיכום קצר בעברית",
  "categories": [
    {
      "name": "שם הקטגוריה",
      "score": 0-100,
      "status": "PASS/FAIL/NEEDS_REVIEW",
      "count": "כמות שזוהתה",
      "findings": ["ממצא 1", "ממצא 2"],
      "recommendations": ["המלצה 1", "המלצה 2"]
    }
  ],
  "criticalIssues": ["בעיה קריטית 1"],
  "positiveFindings": ["ממצא חיובי 1"],
  "hebrewTexts": ["טקסט 1", "טקסט 2"],
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
      scope: 'data:read data:write data:create bucket:read bucket:create viewables:read'
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

  console.log(`📤 Uploading: ${fileName} -> ${safeFileName} (${(fileSize/1024/1024).toFixed(1)}MB)`);

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
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  try {
    await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
    );
  } catch (e) {}

  await new Promise(r => setTimeout(r, 3000));

  console.log('🔄 Submitting SVF2 translation...');
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
      console.log('✅ SVF2 ready');
      return manifest;
    }

    if (manifest.status === 'failed') {
      throw new Error('Translation failed');
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`   ${manifest.progress || '0%'} (${elapsed}s)`);
    await new Promise(r => setTimeout(r, 5000));
  }

  throw new Error('Translation timeout');
}

// ===== HIGH-RES SCREENSHOT WITH PUPPETEER =====
async function captureHighResScreenshot(token, urn, outputPath) {
  if (!puppeteer) {
    throw new Error('Puppeteer not available');
  }

  console.log('📸 Capturing high-res screenshot with Puppeteer...');

  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=4096,4096'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 4096, height: 4096 });

    const html = `<!DOCTYPE html>
<html><head>
  <link rel="stylesheet" href="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css">
  <script src="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js"></script>
  <style>
    body { margin: 0; overflow: hidden; background: white; }
    #viewer { width: 100vw; height: 100vh; }
  </style>
</head><body>
  <div id="viewer"></div>
  <script>
    window.onerror = function(e) { console.error('Error:', e); };

    Autodesk.Viewing.Initializer({
      env: 'AutodeskProduction2',
      api: 'streamingV2',
      getAccessToken: function(cb) { cb('${token}', 3600); }
    }, function() {
      var viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById('viewer'), {
        extensions: ['Autodesk.DocumentBrowser']
      });
      viewer.start();

      Autodesk.Viewing.Document.load('urn:${urn}', function(doc) {
        // Try multiple search strategies
        var views = doc.getRoot().search({ type: 'geometry', role: '2d' });
        if (!views.length) views = doc.getRoot().search({ type: 'geometry', role: '3d' });
        if (!views.length) views = doc.getRoot().search({ type: 'geometry' });
        if (!views.length) {
          // Try getting default view
          var defaultView = doc.getRoot().getDefaultGeometry();
          if (defaultView) views = [defaultView];
        }
        if (!views.length) {
          // Last resort: get all viewables
          var allViewables = doc.getRoot().search({ outputType: 'svf2' });
          if (allViewables.length) views = allViewables;
        }

        console.log('Found views:', views.length);

        if (views.length) {
          viewer.loadDocumentNode(doc, views[0]).then(function() {
            viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, function() {
              viewer.fitToView();
              viewer.setBackgroundColor(255, 255, 255, 255, 255, 255);
              viewer.navigation.setZoomTowardsPivot(false);

              setTimeout(function() {
                document.title = 'READY';
              }, 5000);
            });
            // Fallback timeout in case GEOMETRY_LOADED never fires
            setTimeout(function() {
              if (document.title !== 'READY') {
                viewer.fitToView();
                document.title = 'READY';
              }
            }, 30000);
          }).catch(function(err) {
            console.error('Load node error:', err);
            document.title = 'ERROR';
          });
        } else {
          document.title = 'NO_VIEWS';
        }
      }, function(err) {
        console.error('Load error:', err);
        document.title = 'ERROR';
      });
    });
  </script>
</body></html>`;

    await page.setContent(html);

    console.log('   Waiting for viewer to load...');
    await page.waitForFunction(
      () => document.title === 'READY' || document.title === 'NO_VIEWS' || document.title === 'ERROR',
      { timeout: 180000 }
    );

    const title = await page.title();
    if (title === 'ERROR' || title === 'NO_VIEWS') {
      throw new Error(`Viewer failed: ${title}`);
    }

    // Extra wait for rendering
    await new Promise(r => setTimeout(r, 3000));

    console.log('   Taking screenshot...');
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

    fs.writeFileSync(outputPath, screenshot);
    const size = fs.statSync(outputPath).size;
    console.log(`✅ Screenshot saved: ${(size/1024/1024).toFixed(2)}MB`);

    return screenshot;
  } finally {
    await browser.close();
  }
}

// ===== SPLIT INTO 9 ZONES =====
async function splitIntoZones(imageBuffer) {
  if (!sharp) {
    throw new Error('Sharp not available');
  }

  console.log('🔲 Splitting image into 9 zones...');

  const meta = await sharp(imageBuffer).metadata();
  const zoneWidth = Math.floor(meta.width / 3);
  const zoneHeight = Math.floor(meta.height / 3);

  const zones = [];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const zone = await sharp(imageBuffer)
        .extract({
          left: col * zoneWidth,
          top: row * zoneHeight,
          width: zoneWidth,
          height: zoneHeight
        })
        .png()
        .toBuffer();

      zones.push(zone);
      console.log(`   Zone ${row * 3 + col + 1}/9 ✓`);
    }
  }

  return zones;
}

// ===== CLAUDE VISION ANALYSIS =====
async function analyzeWithClaudeVision(fullImage, zones, customPrompt = null) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  console.log('🤖 Sending to Claude Vision (10 images)...');

  // Build image array: full image + 9 zones
  const images = [fullImage, ...zones].map(buf => ({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: buf.toString('base64')
    }
  }));

  const textContent = {
    type: "text",
    text: `${customPrompt || FIRE_SAFETY_VISION_PROMPT}

התמונה הראשונה היא התוכנית המלאה ברזולוציה גבוהה.
9 התמונות הבאות הן זומים על אזורים שונים בתוכנית (רשת 3x3) לקריאת פרטים.

נתח את כל התמונות ביחד וצור דוח מקיף.`
  };

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
        content: [...images, textContent]
      }]
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude API error: ${resp.status} - ${err}`);
  }

  const data = await resp.json();
  const content = data.content[0].text;

  console.log('✅ Vision analysis complete');

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.log('   JSON parse failed, returning raw');
  }

  return {
    overallScore: 50,
    status: 'NEEDS_REVIEW',
    summary: 'ניתוח ויזואלי',
    detailedReport: content
  };
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

  if (!cadEntry) throw new Error('ZIP does not contain CAD file');

  const extractedName = path.basename(cadEntry.entryName);
  const extractedPath = path.join(tmpDir, `extracted_${Date.now()}_${extractedName}`);
  fs.writeFileSync(extractedPath, cadEntry.getData());

  return { filePath: extractedPath, originalName: extractedName };
}

// ===== DXF FALLBACK =====
async function analyzeDXFWithClaude(filePath, customPrompt) {
  const analysis = await analyzeDXFComplete(filePath);

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
        content: `${customPrompt || FIRE_SAFETY_VISION_PROMPT}\n\n=== נתוני DXF ===\n${analysis.reportText}`
      }]
    })
  });

  if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
  const data = await resp.json();
  const content = data.content[0].text;

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { report: JSON.parse(jsonMatch[0]), analysis };
  } catch (e) {}

  return {
    report: { overallScore: 50, status: 'NEEDS_REVIEW', detailedReport: content },
    analysis
  };
}

// ===== STATIC FILES =====
app.use(express.static('public'));

// ===== API ROUTES =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '37.0.0',
    puppeteer: puppeteer ? 'available' : 'not installed',
    sharp: sharp ? 'available' : 'not installed',
    aps: APS_CLIENT_ID ? 'configured' : 'not configured',
    claude: ANTHROPIC_API_KEY ? 'configured' : 'not configured',
    modes: ['fire-safety', 'compliance'],
    activeProjects: projects.size
  });
});

app.post('/api/upload-instructions', instructionUpload.single('instructionFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const ext = path.extname(req.file.originalname).toLowerCase();
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

// Parse instruction file without saving (for frontend)
app.post('/api/parse-instruction', instructionUpload.single('instructionFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let content = '';

    if (ext === '.pdf' && pdfParse) {
      content = (await pdfParse(fs.readFileSync(req.file.path))).text;
    } else if ((ext === '.docx' || ext === '.doc') && mammoth) {
      content = (await mammoth.extractRawText({ path: req.file.path })).value;
    } else if ((ext === '.xlsx' || ext === '.xls') && XLSX) {
      const workbook = XLSX.readFile(req.file.path);
      content = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return XLSX.utils.sheet_to_txt(sheet);
      }).join('\n');
    } else {
      content = fs.readFileSync(req.file.path, 'utf8');
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, content });
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

// ===== PREVIEW ENDPOINT =====
app.get('/api/preview/:id', (req, res) => {
  const id = req.params.id.replace('.png', '');
  const zoneIndex = req.query.zone !== undefined ? parseInt(req.query.zone) : null;

  const cached = screenshotCache.get(id);
  if (!cached) {
    return res.status(404).json({ error: 'Preview not found' });
  }

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600');

  if (zoneIndex !== null && cached.zones && cached.zones[zoneIndex]) {
    res.send(cached.zones[zoneIndex]);
  } else if (cached.full) {
    res.send(cached.full);
  } else {
    res.status(404).json({ error: 'Image not found' });
  }
});

// ===== COMPLIANCE MODE: REFERENCE UPLOAD =====
app.post('/api/reference/upload', referenceUpload.array('referenceFiles', 10), async (req, res) => {
  const startTime = Date.now();
  let tempFiles = [];

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'לא הועלו קבצים' });
    }

    console.log('\n========================================');
    console.log('📋 COMPLIANCE MODE - Reference Upload');
    console.log(`📁 ${req.files.length} files uploaded`);
    console.log('========================================\n');

    // Extract text from all files
    let allText = '';
    const fileNames = [];

    for (const file of req.files) {
      tempFiles.push(file.path);
      const ext = path.extname(file.originalname).toLowerCase();
      fileNames.push(file.originalname);
      let content = '';

      try {
        if (ext === '.pdf' && pdfParse) {
          const pdfData = await pdfParse(fs.readFileSync(file.path));
          content = pdfData.text;
        } else if ((ext === '.docx' || ext === '.doc') && mammoth) {
          const result = await mammoth.extractRawText({ path: file.path });
          content = result.value;
        } else if ((ext === '.xlsx' || ext === '.xls') && XLSX) {
          const workbook = XLSX.readFile(file.path);
          content = workbook.SheetNames.map(name => {
            const sheet = workbook.Sheets[name];
            return XLSX.utils.sheet_to_txt(sheet);
          }).join('\n');
        } else {
          content = fs.readFileSync(file.path, 'utf8');
        }

        allText += `\n\n=== ${file.originalname} ===\n${content}`;
        console.log(`   ✓ ${file.originalname}: ${content.length} chars`);
      } catch (e) {
        console.log(`   ✗ ${file.originalname}: ${e.message}`);
      }
    }

    if (!allText.trim()) {
      throw new Error('לא ניתן היה לחלץ טקסט מהקבצים');
    }

    console.log(`📄 Total extracted: ${allText.length} chars`);

    // Send to Claude for requirement extraction
    console.log('🤖 Sending to Claude for requirement extraction...');

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
          content: `${REFERENCE_EXTRACTION_PROMPT}\n\n=== תוכן המסמכים ===\n${allText.substring(0, 100000)}`
        }]
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Claude API error: ${resp.status} - ${err}`);
    }

    const data = await resp.json();
    const content = data.content[0].text;

    // Parse JSON response
    let extracted;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON in response');
      }
    } catch (e) {
      console.log('   JSON parse failed, creating minimal structure');
      extracted = {
        requirements: [],
        numericLimits: {},
        projectInfo: {}
      };
    }

    // Create project
    const projectId = uuidv4();
    const project = {
      id: projectId,
      createdAt: Date.now(),
      fileNames,
      requirements: extracted.requirements || [],
      numericLimits: extracted.numericLimits || {},
      projectInfo: extracted.projectInfo || {},
      planResults: []
    };

    projects.set(projectId, project);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Extracted ${project.requirements.length} requirements in ${totalTime}s`);

    // Cleanup temp files
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

    res.json({
      success: true,
      projectId,
      fileNames,
      requirementsExtracted: project.requirements.length,
      requirements: project.requirements,
      numericLimits: project.numericLimits,
      projectInfo: project.projectInfo,
      processingTime: `${totalTime}s`
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    res.status(500).json({ error: error.message });
  }
});

// ===== COMPLIANCE MODE: GET PROJECT =====
app.get('/api/reference/:projectId', (req, res) => {
  const project = projects.get(req.params.projectId);

  if (!project) {
    return res.status(404).json({ error: 'פרויקט לא נמצא' });
  }

  res.json({
    success: true,
    projectId: project.id,
    createdAt: project.createdAt,
    fileNames: project.fileNames,
    requirementsCount: project.requirements.length,
    requirements: project.requirements,
    numericLimits: project.numericLimits,
    projectInfo: project.projectInfo,
    planResults: project.planResults
  });
});

// ===== COMPLIANCE MODE: ANALYZE PLAN =====
app.post('/api/plans/analyze', upload.single('planFile'), async (req, res) => {
  const startTime = Date.now();
  let tempFiles = [];

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'לא הועלה קובץ תכנית' });
    }

    const projectId = req.body.projectId;
    if (!projectId) {
      return res.status(400).json({ error: 'חסר מזהה פרויקט' });
    }

    const project = projects.get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'פרויקט לא נמצא - יש להעלות מסמכי ייחוס תחילה' });
    }

    console.log('\n========================================');
    console.log('📐 COMPLIANCE MODE - Plan Analysis');
    console.log(`📁 ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log(`📋 Project: ${projectId} (${project.requirements.length} requirements)`);
    console.log('========================================\n');

    tempFiles.push(req.file.path);

    // Extract from ZIP if needed
    let { filePath, originalName } = extractFromZip(req.file.path, req.file.originalname);
    if (filePath !== req.file.path) tempFiles.push(filePath);

    const ext = path.extname(originalName).toLowerCase();
    let fullImage, zones, screenshotUrl, screenshotId;

    // ===== DWG/DWF: High-Res Vision Pipeline =====
    if ((ext === '.dwg' || ext === '.dwf') && puppeteer && sharp && APS_CLIENT_ID) {
      console.log('🎯 Using High-Res Vision Pipeline');

      try {
        // APS Upload & Translate
        const token = await getAPSToken();
        const bucketKey = await ensureBucket(token);
        const urn = await uploadToAPS(token, bucketKey, filePath, originalName);
        await translateToSVF2(token, urn);

        // Get fresh token for viewer
        const viewerToken = await getAPSToken();

        // Capture high-res screenshot
        screenshotId = uuidv4();
        const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
        fullImage = await captureHighResScreenshot(viewerToken, urn, screenshotPath);

        screenshotUrl = `/screenshots/${screenshotId}.png`;
        zones = await splitIntoZones(fullImage);
        screenshotCache.set(screenshotId, { full: fullImage, zones });
      } catch (visionError) {
        console.log(`⚠️ Vision pipeline failed: ${visionError.message}`);
        console.log('📝 Falling back to text-based analysis...');
        // Set empty image data - will use text-based analysis
        fullImage = null;
        zones = [];
      }
    }
    // ===== DXF: Parse and render =====
    else if (ext === '.dxf') {
      console.log('📐 DXF: Direct analysis');
      // For DXF, we'll analyze without image for now
      fullImage = null;
      zones = [];
    }
    else {
      throw new Error('פורמט לא נתמך. השתמש ב-DWG, DXF או DWF.');
    }

    // Build compliance check prompt
    const requirementsJson = JSON.stringify(project.requirements.slice(0, 50), null, 2);
    const limitsJson = JSON.stringify(project.numericLimits, null, 2);
    const compliancePrompt = COMPLIANCE_CHECK_PROMPT
      .replace('{REQUIREMENTS}', requirementsJson)
      .replace('{NUMERIC_LIMITS}', limitsJson);

    console.log('🤖 Sending to Claude for compliance check...');

    let complianceResult;

    if (fullImage && zones.length > 0) {
      // Vision-based analysis
      const images = [fullImage, ...zones].map(buf => ({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: buf.toString('base64')
        }
      }));

      const textContent = {
        type: "text",
        text: `${compliancePrompt}\n\nהתמונה הראשונה היא התכנית המלאה. 9 התמונות הבאות הן זומים על אזורים שונים.`
      };

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
            content: [...images, textContent]
          }]
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Claude API error: ${resp.status} - ${err}`);
      }

      const data = await resp.json();
      const content = data.content[0].text;

      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          complianceResult = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        complianceResult = { results: [], overallCompliance: 50, planType: 'לא ידוע' };
      }
    } else if (ext === '.dxf') {
      // Text-based analysis for DXF
      const analysis = await analyzeDXFComplete(filePath);

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
            content: `${compliancePrompt}\n\n=== נתוני DXF ===\n${analysis.reportText}`
          }]
        })
      });

      if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
      const data = await resp.json();
      const content = data.content[0].text;

      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          complianceResult = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        complianceResult = { results: [], overallCompliance: 50, planType: 'לא ידוע' };
      }
    } else {
      // DWG/DWF without vision - text-based requirements check only
      console.log('📝 Using text-based compliance check (no image available)');

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
            content: `${compliancePrompt}\n\nהערה: לא ניתן היה לעבד את התכנית ויזואלית. אנא סמן את כל הדרישות הוויזואליות כ-needs_review והסבר שנדרשת בדיקה ידנית.\n\nשם הקובץ: ${originalName}`
          }]
        })
      });

      if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
      const data = await resp.json();
      const content = data.content[0].text;

      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          complianceResult = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        complianceResult = {
          results: project.requirements.map(req => ({
            requirementId: req.id,
            status: 'needs_review',
            finding_he: 'לא ניתן היה לעבד את התכנית - נדרשת בדיקה ידנית',
            confidence: 0
          })),
          overallCompliance: 0,
          planType: 'לא ידוע - נדרשת בדיקה ידנית'
        };
      }
    }

    // Store result in project
    const planResult = {
      id: uuidv4(),
      fileName: originalName,
      analyzedAt: Date.now(),
      screenshotUrl,
      screenshotId,
      planType: complianceResult.planType || 'לא ידוע',
      results: complianceResult.results || [],
      overallCompliance: complianceResult.overallCompliance || 0,
      detectedMeasurements: complianceResult.detectedMeasurements || {},
      potentialIssues: complianceResult.potentialIssues || []
    };

    project.planResults.push(planResult);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Compliance check complete in ${totalTime}s - Score: ${planResult.overallCompliance}%`);

    // Cleanup temp files
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

    res.json({
      success: true,
      planId: planResult.id,
      fileName: originalName,
      planType: planResult.planType,
      screenshotUrl,
      screenshotId,
      results: planResult.results,
      overallCompliance: planResult.overallCompliance,
      detectedMeasurements: planResult.detectedMeasurements,
      potentialIssues: planResult.potentialIssues,
      processingTime: `${totalTime}s`
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    res.status(500).json({ error: error.message });
  }
});

// ===== MAIN ANALYSIS ENDPOINT =====
app.post('/api/analyze', upload.single('dwgFile'), async (req, res) => {
  const startTime = Date.now();
  let tempFiles = [];
  let screenshotUrl = null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    console.log('\n========================================');
    console.log('🔥 FIRE SAFETY ANALYSIS v35 (Vision)');
    console.log(`📁 ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log('========================================\n');

    tempFiles.push(req.file.path);

    // Extract from ZIP if needed
    let { filePath, originalName } = extractFromZip(req.file.path, req.file.originalname);
    if (filePath !== req.file.path) tempFiles.push(filePath);

    const ext = path.extname(originalName).toLowerCase();
    let report, analysisData;

    // Get custom prompt if specified
    let customPrompt = null;
    if (req.body.instructionId && req.body.instructionId !== 'fire-safety') {
      const instr = savedInstructions.find(i => i.id === req.body.instructionId);
      if (instr) customPrompt = instr.content;
    }

    // ===== DWG/DWF: High-Res Vision Pipeline =====
    if ((ext === '.dwg' || ext === '.dwf') && puppeteer && sharp && APS_CLIENT_ID) {
      console.log('🎯 Using High-Res Vision Pipeline');

      // APS Upload & Translate
      const token = await getAPSToken();
      const bucketKey = await ensureBucket(token);
      const urn = await uploadToAPS(token, bucketKey, filePath, originalName);
      await translateToSVF2(token, urn);

      // Get fresh token for viewer
      const viewerToken = await getAPSToken();

      // Capture high-res screenshot
      const screenshotId = uuidv4();
      const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
      const fullImage = await captureHighResScreenshot(viewerToken, urn, screenshotPath);

      // Set URL for frontend
      screenshotUrl = `/screenshots/${screenshotId}.png`;

      // Split into zones
      const zones = await splitIntoZones(fullImage);

      // Store in cache for preview endpoint
      screenshotCache.set(screenshotId, { full: fullImage, zones });

      // Analyze with Claude Vision
      report = await analyzeWithClaudeVision(fullImage, zones, customPrompt);

      analysisData = {
        method: 'High-Res Vision (4096x4096)',
        screenshotUrl,
        zones: 9,
        imagesAnalyzed: 10
      };
    }

    // ===== DXF: Direct parsing =====
    else if (ext === '.dxf') {
      console.log('📐 Using DXF parsing pipeline');

      const result = await analyzeDXFWithClaude(filePath, customPrompt);
      report = result.report;

      analysisData = {
        method: 'DXF Vector Parsing',
        entities: result.analysis.parsed.totalEntities,
        layers: Object.keys(result.analysis.tree.layers).length,
        texts: result.analysis.parsed.texts.length
      };
    }

    // ===== Fallback for DWG without Vision =====
    else if (ext === '.dwg' || ext === '.dwf') {
      throw new Error('Vision pipeline requires Puppeteer and APS. Use DXF format instead.');
    }

    else {
      throw new Error('Unsupported format. Use DWG, DXF, or DWF.');
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Complete in ${totalTime}s - Score: ${report.overallScore}`);

    // Cleanup temp files (but keep screenshot)
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

    // Extract screenshotId from URL for zone requests
    const screenshotId = screenshotUrl ? screenshotUrl.replace('/screenshots/', '').replace('.png', '') : null;

    // Build response matching frontend expectations
    // Frontend reads: data.analysis.overallScore, data.analysis.categories, etc.
    // Frontend reads: data.filename (lowercase), data.processingTime
    res.json({
      success: true,
      filename: originalName,
      fileName: originalName,  // Keep both for compatibility
      processingTime: `${totalTime}s`,
      analysisTime: totalTime,
      screenshotUrl,
      screenshotId,
      analysisMethod: analysisData.method?.includes('Vision') ? 'vision-high-res' : 'vector',
      // Put the report data in 'analysis' field - this is what frontend reads
      analysis: {
        overallScore: report.overallScore || 0,
        overallStatus: report.status || report.overallStatus || 'NEEDS_REVIEW',
        buildingType: report.buildingType || '',
        categories: report.categories || [],
        criticalIssues: report.criticalIssues || [],
        positiveFindings: report.positiveFindings || [],
        summary: report.summary || report.detailedReport || '',
        summaryHe: report.summaryHe || report.summary || report.detailedReport || '',
        hebrewTexts: report.hebrewTexts || []
      },
      // Keep raw data for debugging
      metadata: analysisData,
      rawReport: report
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
  console.log('🏛️ FIRE SAFETY & COMPLIANCE CHECKER v37');
  console.log('========================================');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📸 Puppeteer: ${puppeteer ? '✅ ready' : '❌ not installed'}`);
  console.log(`🖼️  Sharp: ${sharp ? '✅ ready' : '❌ not installed'}`);
  console.log(`☁️  APS: ${APS_CLIENT_ID ? '✅ configured' : '❌ not configured'}`);
  console.log(`🤖 Claude: ${ANTHROPIC_API_KEY ? '✅ ready' : '❌ not configured'}`);
  console.log('========================================');
  console.log('🔥 Fire Safety Mode: DWG → Vision Analysis');
  console.log('📋 Compliance Mode: Reference Docs → Requirements → Plan Check');
  console.log('========================================\n');
});

server.timeout = 900000;
server.keepAliveTimeout = 600000;
