/**
 * Fire Safety & Compliance Checker - Server v37.9
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
 * DXF: Python ezdxf + matplotlib for high-quality rendering
 *
 * v37.9: Fixed Hebrew text encoding crash in matplotlib, added text sanitizer
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
const { analyzeDXFComplete, streamParseDXF, buildObjectTree, classifyFireSafety } = require('./dxf-analyzer');

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

// ===== FETCH MANIFEST TO FIND VIEWABLES =====
async function getManifestViewables(token, urn) {
  try {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const manifest = await resp.json();

    // Extract all viewable GUIDs from the manifest
    const viewables = [];

    function findViewables(node, path = '') {
      if (node.guid && (node.role === '2d' || node.role === '3d' || node.type === 'geometry')) {
        viewables.push({
          guid: node.guid,
          role: node.role || node.type,
          name: node.name || path,
          path: path
        });
      }
      if (node.children) {
        node.children.forEach((child, i) => findViewables(child, `${path}/${child.name || i}`));
      }
      if (node.derivatives) {
        node.derivatives.forEach((d, i) => findViewables(d, `${path}/derivative${i}`));
      }
    }

    findViewables(manifest);
    console.log(`   Found ${viewables.length} viewables in manifest:`);
    viewables.forEach(v => console.log(`      - ${v.name} (${v.role}) [${v.guid.substring(0, 20)}...]`));

    return viewables;
  } catch (e) {
    console.log(`   Could not fetch manifest viewables: ${e.message}`);
    return [];
  }
}

// ===== HIGH-RES SCREENSHOT WITH PUPPETEER =====
async function captureHighResScreenshot(token, urn, outputPath) {
  if (!puppeteer) {
    throw new Error('Puppeteer not available');
  }

  console.log('📸 Capturing high-res screenshot with Puppeteer...');

  // First, get viewables from manifest for debugging
  const manifestViewables = await getManifestViewables(token, urn);

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

    // Enable console logging from the page
    page.on('console', msg => console.log('   [Viewer]', msg.text()));

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
    window.viewerDebug = {};

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
        var root = doc.getRoot();
        window.viewerDebug.root = root;

        // Log the document structure
        console.log('Document loaded. Root:', root.data.type);

        // Function to recursively find all viewables
        function findAllViewables(node, results, depth) {
          results = results || [];
          depth = depth || 0;
          var indent = '  '.repeat(depth);

          if (node.data) {
            console.log(indent + 'Node: ' + (node.data.name || node.data.type) + ' role=' + node.data.role + ' type=' + node.data.type);
          }

          // Check if this node is viewable
          if (node.data && node.data.role === '2d') {
            results.push({ node: node, type: '2d', name: node.data.name });
          } else if (node.data && node.data.role === '3d') {
            results.push({ node: node, type: '3d', name: node.data.name });
          } else if (node.data && node.data.type === 'geometry') {
            results.push({ node: node, type: 'geometry', name: node.data.name });
          }

          // Recurse into children
          var children = node.children();
          if (children) {
            for (var i = 0; i < children.length; i++) {
              findAllViewables(children[i], results, depth + 1);
            }
          }

          return results;
        }

        var allViewables = findAllViewables(root);
        console.log('Total viewables found: ' + allViewables.length);
        window.viewerDebug.viewables = allViewables;

        // Also try standard search methods
        var views2d = root.search({ type: 'geometry', role: '2d' });
        var views3d = root.search({ type: 'geometry', role: '3d' });
        var viewsAny = root.search({ type: 'geometry' });
        var defaultView = root.getDefaultGeometry();

        console.log('Search results: 2d=' + views2d.length + ' 3d=' + views3d.length + ' any=' + viewsAny.length + ' default=' + !!defaultView);

        // Build priority list of views to try
        var viewsToTry = [];

        // Prefer 2D views (floor plans)
        if (views2d.length) {
          views2d.forEach(function(v) { viewsToTry.push(v); });
        }

        // Then try viewables found by traversal
        allViewables.forEach(function(v) {
          if (viewsToTry.indexOf(v.node) === -1) {
            viewsToTry.push(v.node);
          }
        });

        // Then 3D views
        if (views3d.length) {
          views3d.forEach(function(v) {
            if (viewsToTry.indexOf(v) === -1) viewsToTry.push(v);
          });
        }

        // Then any geometry
        if (viewsAny.length) {
          viewsAny.forEach(function(v) {
            if (viewsToTry.indexOf(v) === -1) viewsToTry.push(v);
          });
        }

        // Default geometry
        if (defaultView && viewsToTry.indexOf(defaultView) === -1) {
          viewsToTry.push(defaultView);
        }

        console.log('Views to try: ' + viewsToTry.length);

        if (viewsToTry.length === 0) {
          console.error('NO VIEWABLES FOUND!');
          document.title = 'NO_VIEWS';
          return;
        }

        // Try to load the first available view
        function tryLoadView(index) {
          if (index >= viewsToTry.length) {
            console.error('All view load attempts failed');
            document.title = 'NO_VIEWS';
            return;
          }

          var viewNode = viewsToTry[index];
          console.log('Trying to load view ' + index + ': ' + (viewNode.data ? viewNode.data.name : 'unknown'));

          viewer.loadDocumentNode(doc, viewNode).then(function() {
            console.log('View loaded successfully!');

            viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, function() {
              console.log('Geometry loaded event fired');
              viewer.fitToView();
              viewer.setBackgroundColor(255, 255, 255, 255, 255, 255);
              viewer.navigation.setZoomTowardsPivot(false);

              setTimeout(function() {
                console.log('Setting READY');
                document.title = 'READY';
              }, 5000);
            });

            // Fallback timeout
            setTimeout(function() {
              if (document.title !== 'READY' && document.title !== 'NO_VIEWS') {
                console.log('Timeout fallback - forcing READY');
                viewer.fitToView();
                document.title = 'READY';
              }
            }, 30000);

          }).catch(function(err) {
            console.error('Failed to load view ' + index + ':', err);
            // Try next view
            tryLoadView(index + 1);
          });
        }

        tryLoadView(0);

      }, function(err) {
        console.error('Document load error:', err);
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
      // Get debug info from page
      const debugInfo = await page.evaluate(() => {
        return {
          viewables: window.viewerDebug?.viewables?.length || 0,
          error: window.viewerDebug?.error
        };
      });
      console.log('   Debug info:', debugInfo);
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

// ===== CONVERT DWG TO DXF =====
async function convertDWGtoDXF(dwgPath) {
  const baseName = path.basename(dwgPath, path.extname(dwgPath));
  const dirName = path.dirname(dwgPath);
  const dxfPath = path.join(dirName, baseName + '.dxf');

  console.log('🔄 Attempting DWG to DXF conversion...');

  // Check which tools are available - use 'command -v' for better cross-platform support
  let availableTools = [];
  const checkCommands = ['dwg2dxf', 'dwgread', 'dwg2SVG', 'ODAFileConverter'];

  for (const cmd of checkCommands) {
    try {
      // Try both 'which' (Linux) and 'where' (Windows) approaches
      try {
        execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, { stdio: 'pipe' });
        availableTools.push(cmd);
      } catch (e) {
        // Command not found, continue
      }
    } catch (e) {}
  }

  if (availableTools.length === 0) {
    console.log('⚠️ No DWG conversion tools available on this system');
    console.log('   Note: DWG files require the APS Vision pipeline for analysis');
    return null;
  }

  console.log(`   Available tools: ${availableTools.join(', ')}`);

  // Method 1: dwg2dxf (simplest)
  if (availableTools.includes('dwg2dxf')) {
    try {
      const result = execSync(`dwg2dxf "${dwgPath}"`, {
        timeout: 120000,
        cwd: dirName,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (fs.existsSync(dxfPath)) {
        const size = fs.statSync(dxfPath).size;
        console.log(`✅ DWG converted to DXF: ${(size/1024).toFixed(0)}KB`);
        return dxfPath;
      }
    } catch (e) {
      console.log(`⚠️ dwg2dxf failed: ${e.message.substring(0, 100)}`);
    }
  }

  // Method 2: dwgread with DXF output
  if (availableTools.includes('dwgread')) {
    try {
      execSync(`dwgread -O DXF "${dwgPath}" -o "${dxfPath}"`, {
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (fs.existsSync(dxfPath)) {
        const size = fs.statSync(dxfPath).size;
        console.log(`✅ DWG converted using dwgread: ${(size/1024).toFixed(0)}KB`);
        return dxfPath;
      }
    } catch (e) {
      console.log(`⚠️ dwgread failed: ${e.message.substring(0, 100)}`);
    }
  }

  // Method 3: ODA File Converter
  if (availableTools.includes('ODAFileConverter')) {
    try {
      execSync(`ODAFileConverter "${dirName}" "${dirName}" ACAD2018 DXF 0 1 "${baseName}.dwg"`, {
        timeout: 120000,
        stdio: 'pipe'
      });

      if (fs.existsSync(dxfPath)) {
        console.log('✅ DWG converted using ODA');
        return dxfPath;
      }
    } catch (e) {
      console.log(`⚠️ ODA failed: ${e.message.substring(0, 100)}`);
    }
  }

  console.log('⚠️ DWG to DXF conversion unavailable - proceeding with vision-only analysis');
  return null;
}

// ===== PYTHON EZDXF RENDERER =====
async function renderDXFWithPython(dxfPath, outputDir) {
  console.log('🐍 Attempting Python ezdxf rendering...');

  const pythonScript = path.join(__dirname, 'analyze_dxf.py');

  // Check if Python script exists
  if (!fs.existsSync(pythonScript)) {
    console.log('⚠️ Python script not found:', pythonScript);
    return null;
  }

  // Check if Python is available - try multiple commands
  let pythonCmd = null;
  const pythonCommands = ['python3', 'python', '/usr/bin/python3', '/usr/bin/python'];

  for (const cmd of pythonCommands) {
    try {
      const version = execSync(`${cmd} --version 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
      console.log(`   Found Python: ${cmd} -> ${version.trim()}`);
      pythonCmd = cmd;
      break;
    } catch (e) {
      // Continue to next command
    }
  }

  if (!pythonCmd) {
    console.log('⚠️ Python not available on this system');
    console.log('   Tried:', pythonCommands.join(', '));
    return null;
  }

  // Check if ezdxf is installed
  try {
    const ezdxfVersion = execSync(`${pythonCmd} -c "import ezdxf; print(ezdxf.__version__)"`, { stdio: 'pipe', encoding: 'utf8' });
    console.log(`   ezdxf version: ${ezdxfVersion.trim()}`);
  } catch (e) {
    console.log('⚠️ ezdxf not installed. Attempting pip install...');
    try {
      execSync(`${pythonCmd} -m pip install ezdxf matplotlib Pillow numpy --user --quiet 2>&1 || ${pythonCmd} -m pip install ezdxf matplotlib Pillow numpy --break-system-packages --quiet 2>&1`, {
        stdio: 'pipe',
        timeout: 180000,
        encoding: 'utf8'
      });
      console.log('   ezdxf installed successfully');
    } catch (e2) {
      console.log('⚠️ Failed to install ezdxf:', e2.message?.substring(0, 200) || 'unknown error');
      return null;
    }
  }

  // Create output directory
  const outputPath = outputDir || path.join(tmpDir, `dxf-render-${Date.now()}`);
  fs.mkdirSync(outputPath, { recursive: true });

  try {
    // Run Python script with JSON output
    const cmd = `${pythonCmd} "${pythonScript}" "${dxfPath}" --output "${outputPath}" --dpi 200 --json`;
    console.log(`   Running: ${pythonCmd} analyze_dxf.py ...`);

    const result = execSync(cmd, {
      timeout: 300000,  // 5 minute timeout for large files
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024  // 50MB buffer
    });

    // Parse JSON output
    const jsonResult = JSON.parse(result.trim());

    if (!jsonResult.success) {
      console.log('⚠️ Python render reported failure');
      return null;
    }

    console.log(`✅ Python render complete in ${jsonResult.processing_time}s`);
    console.log(`   Entities: ${jsonResult.metadata?.total_entities || 'unknown'}`);
    console.log(`   Overview: ${jsonResult.overview}`);
    console.log(`   Zones: ${jsonResult.zones?.length || 0}`);

    // Read the rendered image
    const renderedPath = jsonResult.rendered_image || path.join(outputPath, 'rendered_plan.png');
    if (fs.existsSync(renderedPath)) {
      const imageBuffer = fs.readFileSync(renderedPath);
      console.log(`   Image size: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);

      return {
        buffer: imageBuffer,
        overview: jsonResult.overview,
        zones: jsonResult.zones,
        allImages: jsonResult.all_images,
        metadata: jsonResult.metadata,
        outputDir: outputPath
      };
    } else {
      console.log('⚠️ Rendered image not found at:', renderedPath);
      return null;
    }

  } catch (e) {
    console.log(`⚠️ Python render failed: ${e.message}`);
    if (e.stderr) console.log(`   stderr: ${e.stderr.substring(0, 500)}`);
    return null;
  }
}

// ===== RENDER VECTORS TO IMAGE =====
async function renderVectorsToImage(parsed, classified, outputPath) {
  if (!sharp) {
    console.log('⚠️ Sharp not available for vector rendering');
    return null;
  }

  console.log('🎨 Rendering vectors to image...');

  // Layers to skip for bounds calculation (often contain outliers)
  const skipLayers = ['DEFPOINTS', 'POINTS', 'LOGO', '0'];
  const shouldSkipLayer = (layer) => {
    if (!layer) return false;
    const upper = layer.toUpperCase();
    return skipLayers.includes(upper) ||
           upper.startsWith('IDAN_') ||
           upper.startsWith('TR_') ||
           upper.startsWith('TITLE') ||
           upper.includes('BORDER') ||
           upper.includes('FRAME');
  };

  // Collect coordinates only from geometry entities (not TEXT, POINT, INSERT)
  const xs = [];
  const ys = [];

  const addPoint = (x, y) => {
    if (x !== undefined && y !== undefined && isFinite(x) && isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  };

  // Only use LINE, LWPOLYLINE, ARC, CIRCLE for bounds (skip TEXT, POINT, INSERT/blockRefs)
  parsed.lines.forEach(l => {
    if (!shouldSkipLayer(l.layer)) {
      addPoint(l.x, l.y);
      addPoint(l.x2, l.y2);
    }
  });

  parsed.polylines.forEach(p => {
    if (!shouldSkipLayer(p.layer)) {
      (p.vertices || []).forEach(v => addPoint(v.x, v.y));
    }
  });

  parsed.circles.forEach(c => {
    if (!shouldSkipLayer(c.layer) && c.x !== undefined && c.y !== undefined && c.radius > 0 && c.radius < 10000) {
      addPoint(c.x - c.radius, c.y - c.radius);
      addPoint(c.x + c.radius, c.y + c.radius);
    }
  });

  parsed.arcs.forEach(a => {
    if (!shouldSkipLayer(a.layer) && a.x !== undefined && a.y !== undefined && a.radius > 0 && a.radius < 10000) {
      addPoint(a.x - a.radius, a.y - a.radius);
      addPoint(a.x + a.radius, a.y + a.radius);
    }
  });

  console.log(`   Geometry points for bounds: ${xs.length}`);

  if (xs.length < 4) {
    console.log('⚠️ Not enough geometry points, trying all entities...');
    // Fallback: include all entities
    parsed.texts.forEach(t => addPoint(t.x, t.y));
    parsed.blockRefs.forEach(b => addPoint(b.x, b.y));
  }

  if (xs.length < 4) {
    console.log('⚠️ Not enough points for rendering');
    return null;
  }

  // Sort for IQR calculation
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);

  // Calculate IQR for outlier removal
  const q1IdxX = Math.floor(xs.length * 0.25);
  const q3IdxX = Math.floor(xs.length * 0.75);
  const q1X = xs[q1IdxX];
  const q3X = xs[q3IdxX];
  const iqrX = q3X - q1X;

  const q1IdxY = Math.floor(ys.length * 0.25);
  const q3IdxY = Math.floor(ys.length * 0.75);
  const q1Y = ys[q1IdxY];
  const q3Y = ys[q3IdxY];
  const iqrY = q3Y - q1Y;

  // Use IQR * 1.5 for outlier bounds (standard box plot whiskers)
  let minX = q1X - 1.5 * iqrX;
  let maxX = q3X + 1.5 * iqrX;
  let minY = q1Y - 1.5 * iqrY;
  let maxY = q3Y + 1.5 * iqrY;

  // Clamp to actual data range
  minX = Math.max(minX, xs[0]);
  maxX = Math.min(maxX, xs[xs.length - 1]);
  minY = Math.max(minY, ys[0]);
  maxY = Math.min(maxY, ys[ys.length - 1]);

  let boundsWidth = maxX - minX;
  let boundsHeight = maxY - minY;

  console.log(`   IQR outlier bounds: (${minX.toFixed(1)}, ${minY.toFixed(1)}) to (${maxX.toFixed(1)}, ${maxY.toFixed(1)})`);
  console.log(`   IQR bounds size: ${boundsWidth.toFixed(1)} x ${boundsHeight.toFixed(1)}`);

  // If IQR bounds are too small or invalid, use percentile fallback
  if (boundsWidth < 10 || boundsHeight < 10 || !isFinite(boundsWidth) || !isFinite(boundsHeight)) {
    console.log('⚠️ IQR bounds too small, using 5th-95th percentile...');
    const p5 = Math.floor(xs.length * 0.05);
    const p95 = Math.floor(xs.length * 0.95);
    minX = xs[p5];
    maxX = xs[p95];
    minY = ys[p5];
    maxY = ys[p95];
    boundsWidth = maxX - minX;
    boundsHeight = maxY - minY;
    console.log(`   Percentile bounds: ${boundsWidth.toFixed(1)} x ${boundsHeight.toFixed(1)}`);
  }

  // Still too small? Use full range
  if (boundsWidth < 10 || boundsHeight < 10) {
    console.log('⚠️ Still too small, using full range...');
    minX = xs[0];
    maxX = xs[xs.length - 1];
    minY = ys[0];
    maxY = ys[ys.length - 1];
    boundsWidth = maxX - minX;
    boundsHeight = maxY - minY;
  }

  // Add 5% padding on all sides
  const padX = boundsWidth * 0.05;
  const padY = boundsHeight * 0.05;
  minX -= padX;
  maxX += padX;
  minY -= padY;
  maxY += padY;
  boundsWidth = maxX - minX;
  boundsHeight = maxY - minY;

  console.log('   Render bounds:', { xmin: minX.toFixed(1), xmax: maxX.toFixed(1), ymin: minY.toFixed(1), ymax: maxY.toFixed(1), width: boundsWidth.toFixed(1), height: boundsHeight.toFixed(1) });

  // Image dimensions - minimum 2000x2000, max 4096x4096
  const imgPadding = 50;
  const minDim = 2000;
  const maxDim = 4096;

  // Calculate scale to fit in max dimension
  const scaleX = (maxDim - 2 * imgPadding) / boundsWidth;
  const scaleY = (maxDim - 2 * imgPadding) / boundsHeight;
  const scale = Math.min(scaleX, scaleY);

  // Calculate image size (enforce minimum)
  let imgWidth = Math.ceil(boundsWidth * scale + 2 * imgPadding);
  let imgHeight = Math.ceil(boundsHeight * scale + 2 * imgPadding);
  imgWidth = Math.max(minDim, Math.min(maxDim, imgWidth));
  imgHeight = Math.max(minDim, Math.min(maxDim, imgHeight));

  console.log(`   Image: ${imgWidth}x${imgHeight}, scale: ${scale.toFixed(4)}`);

  // Transform function - DXF is Y-up, SVG is Y-down (flip Y)
  const tx = (x) => {
    const px = imgPadding + (x - minX) * scale;
    return Math.max(0, Math.min(imgWidth, px));
  };
  const ty = (y) => {
    // Flip Y axis: DXF Y-up -> SVG Y-down
    const py = imgHeight - imgPadding - (y - minY) * scale;
    return Math.max(0, Math.min(imgHeight, py));
  };

  // Build SVG
  let svgPaths = [];

  // Draw lines (gray)
  parsed.lines.slice(0, 50000).forEach(l => {
    if (l.x !== undefined && l.y !== undefined && l.x2 !== undefined && l.y2 !== undefined) {
      svgPaths.push(`<line x1="${tx(l.x)}" y1="${ty(l.y)}" x2="${tx(l.x2)}" y2="${ty(l.y2)}" stroke="#444" stroke-width="1"/>`);
    }
  });

  // Draw polylines (gray)
  parsed.polylines.slice(0, 10000).forEach(p => {
    if (p.vertices && p.vertices.length >= 2) {
      const points = p.vertices.map(v => `${tx(v.x)},${ty(v.y)}`).join(' ');
      svgPaths.push(`<polyline points="${points}" fill="none" stroke="#555" stroke-width="1"/>`);
    }
  });

  // Draw circles (light blue)
  parsed.circles.slice(0, 5000).forEach(c => {
    if (c.x !== undefined && c.y !== undefined && c.radius > 0) {
      const r = Math.max(2, c.radius * scale);
      svgPaths.push(`<circle cx="${tx(c.x)}" cy="${ty(c.y)}" r="${r}" fill="none" stroke="#0088cc" stroke-width="1"/>`);
    }
  });

  // Draw arcs (light blue)
  parsed.arcs.slice(0, 5000).forEach(a => {
    if (a.x !== undefined && a.y !== undefined && a.radius > 0) {
      const r = Math.max(2, a.radius * scale);
      svgPaths.push(`<circle cx="${tx(a.x)}" cy="${ty(a.y)}" r="${r}" fill="none" stroke="#00aaff" stroke-width="1" stroke-dasharray="3,3"/>`);
    }
  });

  // Draw classified objects with colors
  const classColors = {
    sprinklers: '#00ff00',      // Green
    smokeDetectors: '#ffff00',  // Yellow
    fireExtinguishers: '#ff6600', // Orange
    hydrants: '#ff0000',        // Red
    fireDoors: '#ff00ff',       // Magenta
    exits: '#00ffff',           // Cyan
    stairs: '#0066ff'           // Blue
  };

  Object.entries(classified).forEach(([category, items]) => {
    const color = classColors[category];
    if (!color) return;

    items.slice(0, 500).forEach(item => {
      if (item.x !== undefined && item.y !== undefined) {
        const cx = tx(item.x);
        const cy = ty(item.y);
        // Draw a marker
        svgPaths.push(`<circle cx="${cx}" cy="${cy}" r="8" fill="${color}" stroke="#fff" stroke-width="2"/>`);
        svgPaths.push(`<circle cx="${cx}" cy="${cy}" r="15" fill="none" stroke="${color}" stroke-width="2"/>`);
      }
    });
  });

  // Draw some text labels
  parsed.texts.slice(0, 500).forEach(t => {
    if (t.x !== undefined && t.y !== undefined && t.text) {
      const fontSize = Math.max(8, Math.min(14, (t.height || 2) * scale));
      // Escape text for SVG
      const escapedText = (t.text || '').substring(0, 30).replace(/[<>&"']/g, '');
      svgPaths.push(`<text x="${tx(t.x)}" y="${ty(t.y)}" font-size="${fontSize}" fill="#333">${escapedText}</text>`);
    }
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}">
    <rect width="100%" height="100%" fill="white"/>
    ${svgPaths.join('\n    ')}
    <!-- Legend -->
    <rect x="10" y="10" width="180" height="170" fill="rgba(255,255,255,0.9)" stroke="#ccc"/>
    <text x="20" y="30" font-size="14" font-weight="bold">מקרא:</text>
    <circle cx="30" cy="50" r="6" fill="#00ff00"/><text x="45" y="55" font-size="12">ספרינקלרים (${classified.sprinklers?.length || 0})</text>
    <circle cx="30" cy="70" r="6" fill="#ffff00"/><text x="45" y="75" font-size="12">גלאי עשן (${classified.smokeDetectors?.length || 0})</text>
    <circle cx="30" cy="90" r="6" fill="#ff6600"/><text x="45" y="95" font-size="12">מטפים (${classified.fireExtinguishers?.length || 0})</text>
    <circle cx="30" cy="110" r="6" fill="#ff0000"/><text x="45" y="115" font-size="12">הידרנטים (${classified.hydrants?.length || 0})</text>
    <circle cx="30" cy="130" r="6" fill="#ff00ff"/><text x="45" y="135" font-size="12">דלתות אש (${classified.fireDoors?.length || 0})</text>
    <circle cx="30" cy="150" r="6" fill="#00ffff"/><text x="45" y="155" font-size="12">יציאות (${classified.exits?.length || 0})</text>
    <circle cx="30" cy="170" r="6" fill="#0066ff"/><text x="45" y="175" font-size="12">מדרגות (${classified.stairs?.length || 0})</text>
  </svg>`;

  try {
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
    fs.writeFileSync(outputPath, pngBuffer);
    console.log(`✅ Vector render saved: ${(pngBuffer.length / 1024).toFixed(0)}KB`);
    return pngBuffer;
  } catch (e) {
    console.log(`⚠️ SVG render failed: ${e.message}`);
    return null;
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
  // Check available DWG tools (suppress errors silently)
  let dwgTools = [];
  const checkCommands = ['dwg2dxf', 'dwgread', 'dwg2SVG'];
  for (const cmd of checkCommands) {
    try {
      execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
      dwgTools.push(cmd);
    } catch (e) {}
  }

  // Check Python availability
  let pythonStatus = 'not available';
  let ezdxfStatus = 'not installed';
  const pythonCommands = ['python3', 'python', '/usr/bin/python3'];
  for (const cmd of pythonCommands) {
    try {
      const version = execSync(`${cmd} --version 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
      pythonStatus = version.trim();
      // Check ezdxf
      try {
        const ezdxfVersion = execSync(`${cmd} -c "import ezdxf; print(ezdxf.__version__)" 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
        ezdxfStatus = ezdxfVersion.trim();
      } catch (e) {
        ezdxfStatus = 'not installed';
      }
      break;
    } catch (e) {}
  }

  res.json({
    status: 'ok',
    version: '37.9.0',
    puppeteer: puppeteer ? 'available' : 'not installed',
    sharp: sharp ? 'available' : 'not installed',
    python: pythonStatus,
    ezdxf: ezdxfStatus,
    aps: APS_CLIENT_ID ? 'configured' : 'not configured',
    claude: ANTHROPIC_API_KEY ? 'configured' : 'not configured',
    modes: ['fire-safety', 'compliance'],
    activeProjects: projects.size,
    dwgTools: dwgTools.length > 0 ? dwgTools : 'none (use APS Vision pipeline)'
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

    // Variable to hold classified objects for compliance check
    let classifiedObjects = null;
    let vectorAnalysis = null;

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
        console.log('🔄 Trying DWG to DXF conversion for vector analysis...');

        // Try to convert DWG to DXF and analyze vectors
        const dxfPath = await convertDWGtoDXF(filePath);
        if (dxfPath && fs.existsSync(dxfPath)) {
          try {
            console.log('📐 Parsing converted DXF...');
            const parsed = await streamParseDXF(dxfPath);
            const tree = buildObjectTree(parsed);
            classifiedObjects = classifyFireSafety(tree);
            vectorAnalysis = await analyzeDXFComplete(dxfPath);

            // Render vectors to image
            screenshotId = uuidv4();
            const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
            fullImage = await renderVectorsToImage(parsed, classifiedObjects, screenshotPath);

            if (fullImage) {
              screenshotUrl = `/screenshots/${screenshotId}.png`;
              zones = await splitIntoZones(fullImage);
              screenshotCache.set(screenshotId, { full: fullImage, zones });
              console.log('✅ Vector rendering successful');
            }

            // Cleanup converted DXF
            try { fs.unlinkSync(dxfPath); } catch (e) {}
          } catch (parseError) {
            console.log(`⚠️ DXF parse failed: ${parseError.message}`);
          }
        } else {
          console.log('⚠️ DWG to DXF conversion failed');
        }
      }
    }
    // ===== DXF: Parse and render =====
    else if (ext === '.dxf') {
      console.log('📐 DXF: Direct analysis with Python ezdxf rendering');

      try {
        // First, try Python ezdxf renderer (better quality)
        const pythonResult = await renderDXFWithPython(filePath, path.join(tmpDir, `dxf-${Date.now()}`));

        if (pythonResult && pythonResult.buffer) {
          console.log('✅ Using Python-rendered image');
          screenshotId = uuidv4();
          const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
          fs.writeFileSync(screenshotPath, pythonResult.buffer);
          fullImage = pythonResult.buffer;
          screenshotUrl = `/screenshots/${screenshotId}.png`;

          // Load zone images if Python generated them
          if (pythonResult.zones && pythonResult.zones.length > 0) {
            zones = pythonResult.zones.map(zonePath => {
              if (fs.existsSync(zonePath)) {
                return fs.readFileSync(zonePath);
              }
              return null;
            }).filter(z => z !== null);
          }

          // If zones not generated by Python, split the main image
          if (!zones || zones.length === 0) {
            zones = await splitIntoZones(fullImage);
          }

          screenshotCache.set(screenshotId, { full: fullImage, zones });

          // Also parse for object classification
          const parsed = await streamParseDXF(filePath);
          const tree = buildObjectTree(parsed);
          classifiedObjects = classifyFireSafety(tree);
          vectorAnalysis = pythonResult.metadata ? { metadata: pythonResult.metadata } : await analyzeDXFComplete(filePath);

          // Clean up Python output dir
          if (pythonResult.outputDir) {
            try { fs.rmSync(pythonResult.outputDir, { recursive: true, force: true }); } catch (e) {}
          }
        } else {
          // Fallback to JavaScript renderer
          console.log('🔄 Falling back to JavaScript vector renderer...');
          const parsed = await streamParseDXF(filePath);
          const tree = buildObjectTree(parsed);
          classifiedObjects = classifyFireSafety(tree);
          vectorAnalysis = await analyzeDXFComplete(filePath);

          // Render vectors to image with JS
          screenshotId = uuidv4();
          const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
          fullImage = await renderVectorsToImage(parsed, classifiedObjects, screenshotPath);

          if (fullImage) {
            screenshotUrl = `/screenshots/${screenshotId}.png`;
            zones = await splitIntoZones(fullImage);
            screenshotCache.set(screenshotId, { full: fullImage, zones });
          }
        }
      } catch (parseError) {
        console.log(`⚠️ DXF parse failed: ${parseError.message}`);
        fullImage = null;
        zones = [];
      }
    }
    else {
      throw new Error('פורמט לא נתמך. השתמש ב-DWG, DXF או DWF.');
    }

    // Build compliance check prompt
    const requirementsJson = JSON.stringify(project.requirements.slice(0, 50), null, 2);
    const limitsJson = JSON.stringify(project.numericLimits, null, 2);

    // Add classified objects info if available
    let classifiedInfo = '';
    if (classifiedObjects) {
      classifiedInfo = `
=== אובייקטים שזוהו מוקטורים ===
ספרינקלרים: ${classifiedObjects.sprinklers?.length || 0}
גלאי עשן: ${classifiedObjects.smokeDetectors?.length || 0}
גלאי חום: ${classifiedObjects.heatDetectors?.length || 0}
מטפי כיבוי: ${classifiedObjects.fireExtinguishers?.length || 0}
הידרנטים: ${classifiedObjects.hydrants?.length || 0}
דלתות אש: ${classifiedObjects.fireDoors?.length || 0}
יציאות חירום: ${classifiedObjects.exits?.length || 0}
מדרגות: ${classifiedObjects.stairs?.length || 0}
קירות אש: ${classifiedObjects.fireWalls?.length || 0}
מעליות: ${classifiedObjects.elevators?.length || 0}
חדרים: ${classifiedObjects.rooms?.length || 0}
`;
    }

    // Add vector analysis report if available
    let vectorReport = '';
    if (vectorAnalysis && vectorAnalysis.reportText) {
      vectorReport = `\n${vectorAnalysis.reportText}`;
    }

    const compliancePrompt = COMPLIANCE_CHECK_PROMPT
      .replace('{REQUIREMENTS}', requirementsJson)
      .replace('{NUMERIC_LIMITS}', limitsJson) + classifiedInfo + vectorReport;

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

    // Build detected objects summary
    const detectedObjects = classifiedObjects ? {
      sprinklers: classifiedObjects.sprinklers?.length || 0,
      smokeDetectors: classifiedObjects.smokeDetectors?.length || 0,
      heatDetectors: classifiedObjects.heatDetectors?.length || 0,
      fireExtinguishers: classifiedObjects.fireExtinguishers?.length || 0,
      hydrants: classifiedObjects.hydrants?.length || 0,
      fireDoors: classifiedObjects.fireDoors?.length || 0,
      exits: classifiedObjects.exits?.length || 0,
      stairs: classifiedObjects.stairs?.length || 0,
      fireWalls: classifiedObjects.fireWalls?.length || 0,
      elevators: classifiedObjects.elevators?.length || 0,
      rooms: classifiedObjects.rooms?.length || 0
    } : null;

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
      potentialIssues: complianceResult.potentialIssues || [],
      detectedObjects
    };

    project.planResults.push(planResult);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Compliance check complete in ${totalTime}s - Score: ${planResult.overallCompliance}%`);
    if (detectedObjects) {
      console.log(`📊 Detected: ${detectedObjects.sprinklers} sprinklers, ${detectedObjects.fireExtinguishers} extinguishers, ${detectedObjects.exits} exits`);
    }

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
      detectedObjects,
      analysisMethod: fullImage ? 'vector-render' : 'text-only',
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

    // ===== DXF: Direct parsing with Python rendering =====
    else if (ext === '.dxf') {
      console.log('📐 Using DXF parsing pipeline with Python rendering');

      // Try Python renderer for visual analysis
      const pythonResult = await renderDXFWithPython(filePath, path.join(tmpDir, `dxf-fire-${Date.now()}`));

      if (pythonResult && pythonResult.buffer) {
        console.log('✅ Using Python-rendered image for Vision analysis');
        const screenshotId = uuidv4();
        const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
        fs.writeFileSync(screenshotPath, pythonResult.buffer);
        const fullImage = pythonResult.buffer;
        screenshotUrl = `/screenshots/${screenshotId}.png`;

        // Split into zones
        const zones = await splitIntoZones(fullImage);
        screenshotCache.set(screenshotId, { full: fullImage, zones });

        // Analyze with Claude Vision
        report = await analyzeWithClaudeVision(fullImage, zones, customPrompt);

        analysisData = {
          method: 'DXF Python Render + Vision',
          screenshotUrl,
          zones: 9,
          imagesAnalyzed: 10,
          entities: pythonResult.metadata?.total_entities || 'unknown',
          layers: pythonResult.metadata?.layer_count || 'unknown'
        };

        // Clean up Python output dir
        if (pythonResult.outputDir) {
          try { fs.rmSync(pythonResult.outputDir, { recursive: true, force: true }); } catch (e) {}
        }
      } else {
        // Fallback to text-based analysis
        console.log('🔄 Falling back to text-based DXF analysis...');
        const result = await analyzeDXFWithClaude(filePath, customPrompt);
        report = result.report;

        analysisData = {
          method: 'DXF Vector Parsing (text)',
          entities: result.analysis.parsed.totalEntities,
          layers: Object.keys(result.analysis.tree.layers).length,
          texts: result.analysis.parsed.texts.length
        };
      }
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
  console.log('🏛️ FIRE SAFETY & COMPLIANCE CHECKER v37.9');
  console.log('========================================');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📸 Puppeteer: ${puppeteer ? '✅ ready' : '❌ not installed'}`);
  console.log(`🖼️  Sharp: ${sharp ? '✅ ready' : '❌ not installed'}`);
  console.log(`☁️  APS: ${APS_CLIENT_ID ? '✅ configured' : '❌ not configured'}`);
  console.log(`🤖 Claude: ${ANTHROPIC_API_KEY ? '✅ ready' : '❌ not configured'}`);
  console.log('========================================');
  console.log('🔥 Fire Safety Mode: DWG → APS Vision Analysis');
  console.log('📋 Compliance Mode: Reference Docs → Requirements → Plan Check');
  console.log('🐍 DXF Support: Python ezdxf + matplotlib (high quality)');
  console.log('========================================\n');
});

server.timeout = 900000;
server.keepAliveTimeout = 600000;
