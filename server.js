/**
 * Fire Safety & Compliance Checker - Server v40.0
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
 * v40.0: FLATTENED DXF SUPPORT
 *   - Batch rendering for 1M+ entities
 *   - Auto-detect plan sections by X-coordinate gaps
 *   - Section classification with Claude Vision
 *   - 20-check Israeli fire safety regulation analysis
 *   - Support for large exploded/flattened DXF files
 *
 * v38.0: HYBRID SPATIAL ANALYSIS
 *   - Split drawing into overlapping zones with entity data
 *   - Extract TEXT/MTEXT/INSERT with pixel coordinates per zone
 *   - Process zones concurrently (2-3 at a time)
 *   - Aggregate findings with world coordinate mapping
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

// Compliance Engine (smart categorization)
const ComplianceEngine = require('./compliance-engine');
let complianceEngine = null; // Initialized after ANTHROPIC_API_KEY is available

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

// Initialize compliance engine
if (ANTHROPIC_API_KEY) {
  complianceEngine = new ComplianceEngine(ANTHROPIC_API_KEY);
}

// Directories
const tmpDir = os.tmpdir();
const uploadsDir = path.join(tmpDir, 'uploads');
const screenshotsDir = path.join(tmpDir, 'screenshots');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

// Static screenshots directory for serving images
const publicScreenshotsDir = path.join(__dirname, 'public', 'screenshots');
if (!fs.existsSync(publicScreenshotsDir)) fs.mkdirSync(publicScreenshotsDir, { recursive: true });

// Multer - 250MB limit for large flattened DXF files
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 250 * 1024 * 1024 },
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
      // Wait for manifest to be fully indexed
      console.log('   Waiting 5s for manifest indexing...');
      await new Promise(r => setTimeout(r, 5000));
      return manifest;
    }

    const svf2 = manifest.derivatives?.find(d => d.outputType === 'svf2');
    if (svf2?.status === 'success') {
      console.log('✅ SVF2 ready');
      // Wait for manifest to be fully indexed
      console.log('   Waiting 5s for manifest indexing...');
      await new Promise(r => setTimeout(r, 5000));
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
      // Enable WebGL with ANGLE/SwiftShader for headless environments
      '--enable-webgl',
      '--enable-webgl2',
      '--use-gl=angle',
      '--use-angle=swiftshader-webgl',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-accelerated-2d-canvas',
      '--deterministic-mode',
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

          // Recurse into children (handle both function and array)
          var children = typeof node.children === 'function' ? node.children() : node.children;
          if (children && children.length) {
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

// ===== APS THUMBNAIL API FALLBACK =====
/**
 * Get rendered image directly from APS using the Thumbnail/Derivative API
 * This works without WebGL and is more reliable in headless environments
 */
async function getAPSThumbnail(token, urn, outputPath, size = 1024) {
  console.log('📸 Getting thumbnail from APS API (fallback)...');

  // Try different thumbnail sizes (largest first)
  const sizes = [1024, 800, 400, 200];

  for (const s of sizes) {
    try {
      const resp = await fetch(
        `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/thumbnail?width=${s}&height=${s}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      if (resp.ok) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > 1000) {  // Ensure it's not an error response
          fs.writeFileSync(outputPath, buffer);
          console.log(`✅ APS thumbnail saved: ${s}x${s} (${(buffer.length/1024).toFixed(0)}KB)`);
          return buffer;
        }
      }
    } catch (e) {
      console.log(`   Thumbnail ${s}x${s} failed: ${e.message}`);
    }
  }

  // Try extracting rendered views from derivatives
  console.log('   Trying to extract rendered views from derivatives...');
  try {
    const manifestResp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const manifest = await manifestResp.json();

    // Look for thumbnail or rendered derivatives
    function findDerivatives(node, results = []) {
      if (node.role === 'thumbnail' || node.role === 'graphics' || node.role === '2d') {
        results.push(node);
      }
      if (node.children) node.children.forEach(c => findDerivatives(c, results));
      if (node.derivatives) node.derivatives.forEach(d => findDerivatives(d, results));
      return results;
    }

    const derivs = findDerivatives(manifest);
    console.log(`   Found ${derivs.length} potential derivatives`);

    for (const deriv of derivs) {
      if (deriv.urn) {
        try {
          const derivResp = await fetch(
            `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest/${deriv.urn}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
          );
          if (derivResp.ok) {
            const buffer = Buffer.from(await derivResp.arrayBuffer());
            if (buffer.length > 1000) {
              fs.writeFileSync(outputPath, buffer);
              console.log(`✅ Derivative image saved: ${(buffer.length/1024).toFixed(0)}KB`);
              return buffer;
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    console.log(`   Derivative extraction failed: ${e.message}`);
  }

  console.log('⚠️ No thumbnail available from APS');
  return null;
}

/**
 * Capture screenshot with Puppeteer, with APS thumbnail fallback
 */
async function captureHighResScreenshotWithFallback(token, urn, outputPath) {
  // Try Puppeteer first
  try {
    const screenshot = await captureHighResScreenshot(token, urn, outputPath);
    if (screenshot && screenshot.length > 10000) {  // Ensure valid image
      return screenshot;
    }
  } catch (e) {
    console.log(`⚠️ Puppeteer screenshot failed: ${e.message}`);
  }

  // Fallback to APS Thumbnail API
  console.log('🔄 Falling back to APS Thumbnail API...');
  return await getAPSThumbnail(token, urn, outputPath);
}

// ===== APS+HYBRID: Render with APS, extract entities with Python =====
/**
 * Combines APS high-quality rendering with Python entity extraction
 * for best fire safety analysis results
 */
async function renderDXFWithAPSHybrid(dxfPath, outputDir) {
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET || !puppeteer) {
    console.log('⚠️ APS+Hybrid not available (missing credentials or Puppeteer)');
    return null;
  }

  console.log('🎯 Using APS+Hybrid Pipeline (APS images + Python entity data)');

  try {
    // STEP 1: Run Python FIRST to extract entity data (no rendering needed, but we get it anyway)
    console.log('📊 Step 1: Extracting entity data with Python...');
    const pythonResult = await renderDXFWithPython(dxfPath, outputDir);

    if (!pythonResult || !pythonResult.hybridData) {
      console.log('⚠️ Python entity extraction failed, falling back to Python-only rendering');
      return pythonResult;
    }

    const hybridData = pythonResult.hybridData;
    console.log(`   Extracted ${hybridData.zones?.length || 0} zones with entity data`);
    console.log(`   Total entities: ${hybridData.zones?.reduce((sum, z) => sum + (z.entity_count || 0), 0) || 0}`);

    // STEP 2: Upload DXF to APS and capture high-res screenshot
    console.log('📤 Step 2: Uploading to APS for high-res rendering...');
    const token = await getAPSToken();
    const bucketKey = await ensureBucket(token);
    const originalName = path.basename(dxfPath);
    const urn = await uploadToAPS(token, bucketKey, dxfPath, originalName);

    console.log('🔄 Step 3: Translating to SVF2...');
    await translateToSVF2(token, urn);

    // Get fresh token for viewer
    const viewerToken = await getAPSToken();

    // Capture full high-res screenshot
    console.log('📸 Step 4: Capturing high-res screenshot with APS Viewer...');
    const fullScreenshotPath = path.join(outputDir, 'aps_full.png');
    const apsImage = await captureHighResScreenshotWithFallback(viewerToken, urn, fullScreenshotPath);

    if (!apsImage) {
      console.log('⚠️ APS screenshot failed, using Python-rendered image');
      return pythonResult;
    }

    // STEP 3: Split APS image into zones matching Python's zone bounds
    console.log('🔲 Step 5: Splitting APS image into hybrid zones...');
    const apsZones = await splitAPSImageIntoHybridZones(apsImage, hybridData, outputDir);

    if (!apsZones || apsZones.length === 0) {
      console.log('⚠️ APS zone splitting failed, using Python zones');
      return pythonResult;
    }

    // STEP 4: Replace Python zone images with APS zone images
    console.log('🔗 Step 6: Combining APS images with Python entity data...');
    for (let i = 0; i < hybridData.zones.length && i < apsZones.length; i++) {
      const apsZonePath = apsZones[i];
      if (fs.existsSync(apsZonePath)) {
        // Update zone image path to APS version
        hybridData.zones[i].image_path = apsZonePath;
        hybridData.zones[i].rendered_by = 'APS';

        // Update image size from actual APS zone
        try {
          const apsZoneBuffer = fs.readFileSync(apsZonePath);
          const dimensions = await getImageDimensions(apsZoneBuffer);
          if (dimensions) {
            hybridData.zones[i].image_size = [dimensions.width, dimensions.height];
          }
        } catch (e) {}
      }
    }

    // Update overview to APS version
    hybridData.overview = fullScreenshotPath;
    hybridData.rendered_by = 'APS';

    console.log(`✅ APS+Hybrid complete: ${apsZones.length} APS zones with Python entity data`);

    return {
      buffer: apsImage,
      overview: fullScreenshotPath,
      zones: apsZones,
      metadata: pythonResult.metadata,
      outputDir: outputDir,
      hybridData: hybridData,
      version: 'v8-aps-hybrid',
      apsRendered: true
    };

  } catch (error) {
    console.log(`⚠️ APS+Hybrid failed: ${error.message}`);
    // Fallback to Python-only rendering
    return await renderDXFWithPython(dxfPath, outputDir);
  }
}

/**
 * Split APS full image into zones matching Python's zone grid
 */
async function splitAPSImageIntoHybridZones(fullImage, hybridData, outputDir) {
  if (!sharp) {
    console.log('⚠️ Sharp not available for zone splitting');
    return null;
  }

  const zones = hybridData.zones || [];
  if (zones.length === 0) return [];

  const globalBounds = hybridData.global_bounds; // [xmin, xmax, ymin, ymax]
  const xmin = globalBounds[0], xmax = globalBounds[1];
  const ymin = globalBounds[2], ymax = globalBounds[3];
  const worldWidth = xmax - xmin;
  const worldHeight = ymax - ymin;

  // Get APS image dimensions
  const metadata = await sharp(fullImage).metadata();
  const imgWidth = metadata.width;
  const imgHeight = metadata.height;

  console.log(`   APS image: ${imgWidth}x${imgHeight}, World: ${worldWidth.toFixed(0)}x${worldHeight.toFixed(0)}`);

  const apsZonePaths = [];

  for (const zone of zones) {
    const zoneBounds = zone.bounds; // [zxmin, zxmax, zymin, zymax]
    const zxmin = zoneBounds[0], zxmax = zoneBounds[1];
    const zymin = zoneBounds[2], zymax = zoneBounds[3];

    // Convert world coordinates to pixel coordinates
    // Note: Y is flipped in image space
    const pxLeft = Math.round(((zxmin - xmin) / worldWidth) * imgWidth);
    const pxRight = Math.round(((zxmax - xmin) / worldWidth) * imgWidth);
    const pxTop = Math.round(((ymax - zymax) / worldHeight) * imgHeight);
    const pxBottom = Math.round(((ymax - zymin) / worldHeight) * imgHeight);

    const cropWidth = Math.max(1, pxRight - pxLeft);
    const cropHeight = Math.max(1, pxBottom - pxTop);

    // Clamp to image bounds
    const left = Math.max(0, Math.min(pxLeft, imgWidth - 1));
    const top = Math.max(0, Math.min(pxTop, imgHeight - 1));
    const width = Math.min(cropWidth, imgWidth - left);
    const height = Math.min(cropHeight, imgHeight - top);

    if (width < 10 || height < 10) {
      console.log(`   Skipping ${zone.zone_id}: too small (${width}x${height})`);
      continue;
    }

    try {
      const zonePath = path.join(outputDir, `aps_${zone.zone_id}.jpg`);
      await sharp(fullImage)
        .extract({ left, top, width, height })
        .jpeg({ quality: 90 })
        .toFile(zonePath);

      apsZonePaths.push(zonePath);
      console.log(`   ${zone.zone_id}: ${width}x${height}px @ (${left},${top})`);
    } catch (e) {
      console.log(`   Failed to extract ${zone.zone_id}: ${e.message}`);
    }
  }

  return apsZonePaths;
}

/**
 * Get image dimensions using sharp
 */
async function getImageDimensions(buffer) {
  if (!sharp) return null;
  try {
    const metadata = await sharp(buffer).metadata();
    return { width: metadata.width, height: metadata.height };
  } catch (e) {
    return null;
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
    // Run Python script v8 - simpler CLI: just dxf_path and output_dir
    const cmd = `${pythonCmd} "${pythonScript}" "${dxfPath}" "${outputPath}"`;
    console.log(`   Running: ${pythonCmd} analyze_dxf.py ...`);

    const result = execSync(cmd, {
      timeout: 600000,  // 10 minute timeout for very large files (1M+ entities)
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024  // 50MB buffer
    });

    // Parse JSON output - extract JSON from output (stderr has logs, stdout has JSON only)
    let jsonResult;
    const trimmed = result.trim();
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');

    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = trimmed.substring(jsonStart, jsonEnd + 1);
      jsonResult = JSON.parse(jsonStr);
    } else {
      // Fallback: try parsing the whole thing
      jsonResult = JSON.parse(trimmed);
    }

    if (!jsonResult.success) {
      console.log('⚠️ Python render reported failure:', jsonResult.error);
      return null;
    }

    // v8 output format
    console.log(`✅ Python render complete in ${jsonResult.timing?.total || 0}s`);
    console.log(`   Version: ${jsonResult.version || 'unknown'}`);
    console.log(`   Entities: ${jsonResult.total_entities || 'unknown'}`);
    console.log(`   Aspect ratio: ${jsonResult.aspect_ratio || 'unknown'}:1`);
    console.log(`   Split method: ${jsonResult.split_method || 'unknown'}`);
    console.log(`   Is flattened: ${jsonResult.is_flattened || false}`);
    console.log(`   Zones: ${jsonResult.total_zones || 0}`);

    // v8 uses split_method instead of mode - handle section detection or wide layouts
    const isWideLayout = jsonResult.aspect_ratio > 5;
    const isSectionMode = jsonResult.split_method === 'section_detection' || isWideLayout;

    if (isSectionMode) {
      console.log(`   SECTION MODE: ${jsonResult.total_zones} sections detected (aspect ${jsonResult.aspect_ratio}:1)`);
    }

    // For v8 section detection mode (wide multi-sheet layouts)
    if (isSectionMode && jsonResult.zones && jsonResult.zones.length > 0) {
      const sections = jsonResult.zones.map(zone => ({
        sectionId: zone.zone_id,
        imagePath: zone.image_path,
        bounds: zone.bounds,
        classification: null,  // To be filled by Claude
        buffer: fs.existsSync(zone.image_path) ? fs.readFileSync(zone.image_path) : null,
        sizeKb: zone.size_kb
      }));

      return {
        mode: 'sections',
        isFlattened: jsonResult.is_flattened || false,
        sections,
        totalEntities: jsonResult.total_entities,
        entityCounts: jsonResult.entity_counts,
        aspectRatio: jsonResult.aspect_ratio,
        bounds: jsonResult.bounds,
        overviewImage: jsonResult.overview_image,
        outputDir: outputPath,
        version: jsonResult.version || 'v8'
      };
    }

    // v8: Read the overview image (3x3 grid mode or any mode)
    const overviewPath = jsonResult.overview_image || path.join(outputPath, 'overview.png');
    if (fs.existsSync(overviewPath)) {
      const imageBuffer = fs.readFileSync(overviewPath);
      console.log(`   Overview image size: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);

      // Build zones data from v8 format
      const zones = (jsonResult.zones || []).map(zone => ({
        zoneId: zone.zone_id,
        imagePath: zone.image_path,
        bounds: zone.bounds,
        buffer: fs.existsSync(zone.image_path) ? fs.readFileSync(zone.image_path) : null,
        sizeKb: zone.size_kb
      }));

      return {
        buffer: imageBuffer,
        overview: overviewPath,
        zones: zones.map(z => z.imagePath),  // For legacy compatibility
        zonesData: zones,  // Full zone data for v8
        metadata: {
          total_entities: jsonResult.total_entities,
          entity_counts: jsonResult.entity_counts,
          bounds: jsonResult.bounds,
          aspect_ratio: jsonResult.aspect_ratio,
          is_flattened: jsonResult.is_flattened
        },
        outputDir: outputPath,
        // v8 doesn't have hybrid_data, but we can build it for compatibility
        hybridData: {
          overview: overviewPath,
          overview_size: null,
          global_bounds: [jsonResult.bounds?.x_min, jsonResult.bounds?.x_max, jsonResult.bounds?.y_min, jsonResult.bounds?.y_max],
          zones: zones.map(z => ({
            zone_id: `zone_${z.zoneId}`,
            image_path: z.imagePath,
            bounds: z.bounds,
            entities: [],  // v8 doesn't extract text entities
            entity_count: 0
          })),
          total_zones: jsonResult.total_zones || zones.length
        },
        version: jsonResult.version || 'v8'
      };
    } else {
      console.log('⚠️ Overview image not found at:', overviewPath);
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

// ===== DETECT IMAGE MEDIA TYPE =====
function getMediaType(bufferOrPath) {
  // If it's a path string, read file extension first
  if (typeof bufferOrPath === 'string') {
    const ext = path.extname(bufferOrPath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    // If no clear extension, read the file and check magic bytes
    bufferOrPath = fs.readFileSync(bufferOrPath);
  }

  // Check magic bytes
  if (Buffer.isBuffer(bufferOrPath) && bufferOrPath.length >= 4) {
    const b = bufferOrPath;
    // JPEG: FF D8 FF
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    // PNG: 89 50 4E 47
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    // WebP: RIFF....WEBP
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12) {
      if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    }
    // GIF: GIF8
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  }

  // Default to PNG
  return 'image/png';
}

// ===== ENSURE IMAGE DOESN'T EXCEED CLAUDE'S 8000px LIMIT =====
async function ensureMaxSize(imagePath, maxDim = 7000) {
  if (!sharp) {
    console.log('⚠️ Sharp not available, skipping resize check');
    return imagePath;
  }
  try {
    const meta = await sharp(imagePath).metadata();
    if (meta.width > maxDim || meta.height > maxDim) {
      const tmpPath = imagePath + '.tmp';
      await sharp(imagePath)
        .resize(maxDim, maxDim, { fit: 'inside' })
        .toFile(tmpPath);
      fs.renameSync(tmpPath, imagePath);
      console.log(`📏 Resized: ${meta.width}x${meta.height} -> ≤${maxDim}px`);
    }
    return imagePath;
  } catch (err) {
    console.log(`⚠️ Resize check failed: ${err.message}`);
    return imagePath;
  }
}

async function ensureMaxSizeBuffer(buffer, maxDim = 7000) {
  if (!sharp) return buffer;
  try {
    const meta = await sharp(buffer).metadata();
    if (meta.width > maxDim || meta.height > maxDim) {
      const resized = await sharp(buffer)
        .resize(maxDim, maxDim, { fit: 'inside' })
        .toBuffer();
      console.log(`📏 Resized buffer: ${meta.width}x${meta.height} -> ≤${maxDim}px`);
      return resized;
    }
    return buffer;
  } catch (err) {
    console.log(`⚠️ Buffer resize failed: ${err.message}`);
    return buffer;
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

  console.log('🤖 Sending to Claude Vision...');

  // Build image array: full image + 9 zones (filter out empty/broken, resize if needed)
  const allBuffers = [fullImage, ...zones];
  const images = [];

  for (let i = 0; i < allBuffers.length; i++) {
    let buf = allBuffers[i];
    if (!buf || buf.length < 100) {
      console.log(`⚠️ Skipping empty/broken image at index ${i}`);
      continue;
    }
    // Resize if exceeds Claude's 8000px limit
    buf = await ensureMaxSizeBuffer(buf, 7000);
    const mediaType = getMediaType(buf);
    images.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: buf.toString('base64')
      }
    });
  }

  console.log(`   Sending ${images.length} valid images to Claude Vision`);

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
      temperature: 0,
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

// ===== HYBRID SPATIAL ANALYSIS (v7) =====

/**
 * Use AI to classify unknown block names into fire safety categories
 * This runs ONCE before zone analysis to build a classification map
 */
async function classifyBlockNamesWithAI(allBlockNames) {
  if (!ANTHROPIC_API_KEY || allBlockNames.length === 0) {
    return {};
  }

  console.log(`🧠 Classifying ${allBlockNames.length} unique block names with AI...`);

  // Create a prompt for block classification
  const blockList = allBlockNames.slice(0, 100).join('\n'); // Limit to 100

  const prompt = `אתה מומחה בטיחות אש. סווג את שמות הבלוקים הבאים מתוכנית DXF לקטגוריות בטיחות אש.

שמות הבלוקים:
${blockList}

סווג כל שם לאחת מהקטגוריות הבאות:
- SPRINKLER (ספרינקלר, ראש ממטרה)
- SMOKE_DETECTOR (גלאי עשן)
- HEAT_DETECTOR (גלאי חום)
- FIRE_EXTINGUISHER (מטף כיבוי)
- HYDRANT (הידרנט, ברז כיבוי)
- FIRE_DOOR (דלת אש)
- EXIT (יציאת חירום)
- STAIRS (מדרגות, חדר מדרגות מוגן)
- FIRE_WALL (קיר אש)
- FIRE_HOSE_REEL (גלגלון כיבוי)
- NOT_FIRE_SAFETY (לא קשור לבטיחות אש)

החזר JSON בלבד:
{
  "classifications": {
    "BLOCK_NAME_1": "SPRINKLER",
    "BLOCK_NAME_2": "NOT_FIRE_SAFETY",
    ...
  }
}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });

    if (!resp.ok) {
      console.log('⚠️ Block classification API error');
      return {};
    }

    const data = await resp.json();
    const content = data.content[0].text;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`✓ Classified ${Object.keys(parsed.classifications || {}).length} block names`);
      return parsed.classifications || {};
    }
  } catch (err) {
    console.log(`⚠️ Block classification error: ${err.message}`);
  }

  return {};
}

/**
 * Apply AI classifications to entities
 */
function applyClassificationsToEntities(entities, classifications) {
  return entities.map(entity => {
    if (entity.type === 'BLOCK' && entity.name) {
      const classification = classifications[entity.name];
      if (classification && classification !== 'NOT_FIRE_SAFETY') {
        return {
          ...entity,
          classifiedType: classification,
          originalName: entity.name
        };
      }
    }
    return entity;
  });
}

/**
 * Count entities by their classified types
 */
function countClassifiedEntities(entities) {
  const counts = {
    sprinklers: 0,
    smokeDetectors: 0,
    heatDetectors: 0,
    fireExtinguishers: 0,
    hydrants: 0,
    fireDoors: 0,
    exits: 0,
    stairs: 0,
    fireWalls: 0,
    fireHoseReels: 0
  };

  const typeMapping = {
    'SPRINKLER': 'sprinklers',
    'SMOKE_DETECTOR': 'smokeDetectors',
    'HEAT_DETECTOR': 'heatDetectors',
    'FIRE_EXTINGUISHER': 'fireExtinguishers',
    'HYDRANT': 'hydrants',
    'FIRE_DOOR': 'fireDoors',
    'EXIT': 'exits',
    'STAIRS': 'stairs',
    'FIRE_WALL': 'fireWalls',
    'FIRE_HOSE_REEL': 'fireHoseReels'
  };

  for (const entity of entities) {
    if (entity.classifiedType && typeMapping[entity.classifiedType]) {
      counts[typeMapping[entity.classifiedType]]++;
    }
  }

  return counts;
}

/**
 * Build a hybrid prompt for a single zone with entity data
 */
/**
 * Categorize blocks by their likely fire safety type based on name patterns
 */
function categorizeBlocksByName(entities) {
  const patterns = {
    sprinklers: /sprink|ספרינק|sp_|_sp|^sp$|spk|sprk|sprin/i,
    smokeDetectors: /smoke|עשן|sd_|_sd|^sd$|smk|detector.*smoke|גלאי.*עשן/i,
    heatDetectors: /heat|חום|hd_|_hd|^hd$|thermal|גלאי.*חום/i,
    fireExtinguishers: /extinguish|מטף|fe_|_fe|^fe$|ext|כיבוי|fire.*ext/i,
    hydrants: /hydrant|הידרנט|hy_|_hy|^hy$|fh_|fire.*hydrant|ברז.*כיבוי/i,
    fireDoors: /door.*fire|fire.*door|דלת.*אש|fd_|_fd|^fd$|f\.door/i,
    exits: /exit|יציאה|ex_|_ex|^ex$|emergency.*exit|יציאת.*חירום|evac/i,
    stairs: /stair|מדרג|st_|_st|^st$|escape.*stair|מדרגות/i,
    fireWalls: /wall.*fire|fire.*wall|קיר.*אש|fw_|_fw|^fw$|f\.wall/i,
    fireHoseReels: /hose|גלגלון|hr_|_hr|^hr$|reel|fire.*hose/i
  };

  const categorized = {
    sprinklers: [],
    smokeDetectors: [],
    heatDetectors: [],
    fireExtinguishers: [],
    hydrants: [],
    fireDoors: [],
    exits: [],
    stairs: [],
    fireWalls: [],
    fireHoseReels: [],
    unknown: []
  };

  for (const entity of entities || []) {
    if (entity.type !== 'BLOCK') continue;
    const name = entity.name || '';
    let matched = false;

    for (const [category, pattern] of Object.entries(patterns)) {
      if (pattern.test(name)) {
        categorized[category].push(entity);
        matched = true;
        break;
      }
    }

    if (!matched) {
      categorized.unknown.push(entity);
    }
  }

  return categorized;
}

function buildHybridZonePrompt(zone, analysisType = 'fire-safety') {
  // Group entities by AI-classified type (prioritize AI classification over regex)
  const classifiedGroups = {
    SPRINKLER: [],
    SMOKE_DETECTOR: [],
    HEAT_DETECTOR: [],
    FIRE_EXTINGUISHER: [],
    HYDRANT: [],
    FIRE_DOOR: [],
    EXIT: [],
    STAIRS: [],
    FIRE_WALL: [],
    FIRE_HOSE_REEL: [],
    unclassified: []
  };

  const typeLabels = {
    SPRINKLER: { icon: '💧', label: 'ספרינקלרים' },
    SMOKE_DETECTOR: { icon: '🔔', label: 'גלאי עשן' },
    HEAT_DETECTOR: { icon: '🌡️', label: 'גלאי חום' },
    FIRE_EXTINGUISHER: { icon: '🧯', label: 'מטפי כיבוי' },
    HYDRANT: { icon: '🔴', label: 'הידרנטים' },
    FIRE_DOOR: { icon: '🚪', label: 'דלתות אש' },
    EXIT: { icon: '🚶', label: 'יציאות חירום' },
    STAIRS: { icon: '🪜', label: 'מדרגות' },
    FIRE_WALL: { icon: '🧱', label: 'קירות אש' },
    FIRE_HOSE_REEL: { icon: '🔥', label: 'גלגלוני כיבוי' }
  };

  // Group blocks by their AI classification
  for (const entity of zone.entities || []) {
    if (entity.type === 'BLOCK') {
      if (entity.classifiedType && classifiedGroups[entity.classifiedType]) {
        classifiedGroups[entity.classifiedType].push(entity);
      } else {
        classifiedGroups.unclassified.push(entity);
      }
    }
  }

  // Build classified summary
  const classifiedSummary = [];
  for (const [type, entities] of Object.entries(classifiedGroups)) {
    if (type === 'unclassified' || entities.length === 0) continue;
    const { icon, label } = typeLabels[type];
    const locations = entities.slice(0, 10).map(e => `"${e.originalName || e.name}"@(${e.pixel_pos[0]},${e.pixel_pos[1]})`).join(', ');
    classifiedSummary.push(`${icon} ${label} (${entities.length}): ${locations}${entities.length > 10 ? '...' : ''}`);
  }

  // Unclassified blocks
  if (classifiedGroups.unclassified.length > 0) {
    const unclList = classifiedGroups.unclassified.slice(0, 15).map(e => `"${e.name}"`).join(', ');
    classifiedSummary.push(`❓ בלוקים לא מסווגים (${classifiedGroups.unclassified.length}): ${unclList}${classifiedGroups.unclassified.length > 15 ? '...' : ''}`);
  }

  // Extract texts
  const texts = (zone.entities || [])
    .filter(e => e.type === 'TEXT' || e.type === 'MTEXT')
    .map(e => `- "${e.text}" @ (${e.pixel_pos[0]}, ${e.pixel_pos[1]})`);

  // Pre-count from AI classifications
  const preCount = {
    sprinklers: classifiedGroups.SPRINKLER.length,
    smokeDetectors: classifiedGroups.SMOKE_DETECTOR.length,
    heatDetectors: classifiedGroups.HEAT_DETECTOR.length,
    fireExtinguishers: classifiedGroups.FIRE_EXTINGUISHER.length,
    hydrants: classifiedGroups.HYDRANT.length,
    fireDoors: classifiedGroups.FIRE_DOOR.length,
    exits: classifiedGroups.EXIT.length,
    stairs: classifiedGroups.STAIRS.length,
    fireWalls: classifiedGroups.FIRE_WALL.length,
    fireHoseReels: classifiedGroups.FIRE_HOSE_REEL.length
  };

  const basePrompt = analysisType === 'fire-safety' ?
    `אתה מומחה בטיחות אש ישראלי. נתח את אזור ${zone.zone_id} של תוכנית כיבוי אש.` :
    `אתה בודק היתרי בנייה ישראלי. בדוק את אזור ${zone.zone_id} של התוכנית.`;

  return `${basePrompt}

מיקום באזור: שורה ${zone.grid_position[0]}, עמודה ${zone.grid_position[1]}
גודל תמונה: ${zone.image_size[0]}x${zone.image_size[1]} פיקסלים

=== אלמנטי בטיחות אש (מסווגים על ידי AI) ===
${classifiedSummary.length > 0 ? classifiedSummary.join('\n') : '(לא נמצאו אלמנטי בטיחות באזור זה)'}

=== טקסטים באזור ===
${texts.length > 0 ? texts.slice(0, 30).join('\n') : '(אין טקסט)'}

=== ספירה מקדימה (לפי סיווג AI של שמות בלוקים) ===
💧 ספרינקלרים: ${preCount.sprinklers} | 🔔 גלאי עשן: ${preCount.smokeDetectors} | 🌡️ גלאי חום: ${preCount.heatDetectors}
🧯 מטפי כיבוי: ${preCount.fireExtinguishers} | 🔴 הידרנטים: ${preCount.hydrants} | 🚪 דלתות אש: ${preCount.fireDoors}
🚶 יציאות חירום: ${preCount.exits} | 🪜 מדרגות: ${preCount.stairs} | 🧱 קירות אש: ${preCount.fireWalls}

=== משימת ניתוח ===
${analysisType === 'fire-safety' ? `
הספירה למעלה מבוססת על סיווג AI של שמות בלוקים בקובץ DXF.

1. **אמת את הספירה**: האם הספירה נכונה? בדוק ויזואלית בתמונה.
2. **חפש אלמנטים נוספים**: האם יש סמלים בתמונה שלא נספרו?
3. **הערך מיקום**: האם האלמנטים ממוקמים נכון לפי תקן ישראלי?
4. **בדוק כיסוי**: האם יש אזורים ללא כיסוי נאות?

חשוב: הספירה המקדימה כבר כוללת את הנתונים מהקובץ. המשימה שלך היא לאמת ולהשלים.
` : `
בדוק את האזור עבור:
1. מידות וכתות
2. סימונים טכניים
3. התאמה לדרישות
4. בעיות פוטנציאליות
`}

החזר JSON (עדכן את הספירה בהתאם לניתוח הויזואלי והבלוקים):
{
  "zone_id": "${zone.zone_id}",
  "objectCounts": {
    "sprinklers": 0,
    "smokeDetectors": 0,
    "heatDetectors": 0,
    "fireExtinguishers": 0,
    "hydrants": 0,
    "fireDoors": 0,
    "exits": 0,
    "stairs": 0,
    "fireWalls": 0,
    "fireHoseReels": 0
  },
  "detectedObjects": [
    {
      "type": "SPRINKLER|SMOKE_DETECTOR|FIRE_EXTINGUISHER|...",
      "pixel_pos": [x, y],
      "confidence": 0-100
    }
  ],
  "findings": [
    {
      "category": "קטגוריה",
      "description": "תיאור",
      "status": "pass|fail|needs_review",
      "pixel_pos": [x, y],
      "confidence": 0-100
    }
  ],
  "hebrewTexts": ["טקסטים שזוהו"],
  "zoneScore": 0-100
}`;
}

/**
 * Analyze a single zone with Claude using hybrid data
 */
async function analyzeHybridZoneWithClaude(zone, analysisType = 'fire-safety') {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  // Read zone image
  const imagePath = zone.image_path;
  if (!fs.existsSync(imagePath)) {
    console.log(`⚠️ Zone image not found: ${imagePath}`);
    return { zone_id: zone.zone_id, error: 'Image not found', findings: [] };
  }

  let imageBuffer = fs.readFileSync(imagePath);
  imageBuffer = await ensureMaxSizeBuffer(imageBuffer, 7000);
  const mediaType = getMediaType(imageBuffer);

  const prompt = buildHybridZonePrompt(zone, analysisType);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBuffer.toString('base64')
            }
          },
          {
            type: "text",
            text: prompt
          }
        ]
      }]
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.log(`⚠️ Claude API error for ${zone.zone_id}: ${resp.status}`);
    return { zone_id: zone.zone_id, error: err, findings: [] };
  }

  const data = await resp.json();
  const content = data.content[0].text;

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.log(`⚠️ JSON parse failed for ${zone.zone_id}`);
  }

  return { zone_id: zone.zone_id, findings: [], rawContent: content };
}

/**
 * Process zones concurrently with rate limiting
 */
async function processZonesConcurrently(zones, analysisType = 'fire-safety', maxConcurrent = 2) {
  console.log(`🔄 Processing ${zones.length} zones (${maxConcurrent} concurrent)...`);

  const results = [];
  const queue = [...zones];
  const inProgress = new Set();

  const processNext = async () => {
    if (queue.length === 0) return null;

    const zone = queue.shift();
    const zoneId = zone.zone_id;
    inProgress.add(zoneId);

    console.log(`   → Starting ${zoneId} (${inProgress.size}/${maxConcurrent} active)`);

    try {
      const result = await analyzeHybridZoneWithClaude(zone, analysisType);
      console.log(`   ✓ Completed ${zoneId}`);
      return { ...zone, analysis: result };
    } catch (err) {
      console.log(`   ✗ Failed ${zoneId}: ${err.message}`);
      return { ...zone, error: err.message };
    } finally {
      inProgress.delete(zoneId);
    }
  };

  // Process with concurrency limit
  while (queue.length > 0 || inProgress.size > 0) {
    // Start new tasks up to the concurrency limit
    const startPromises = [];
    while (inProgress.size < maxConcurrent && queue.length > 0) {
      startPromises.push(processNext());
    }

    if (startPromises.length > 0) {
      const batchResults = await Promise.all(startPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    // Small delay to prevent tight loop
    if (queue.length > 0 || inProgress.size > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return results;
}

/**
 * Convert pixel coordinates back to world coordinates
 */
function pixelToWorld(pixelPos, transform) {
  const [px, py] = pixelPos;
  const [imgW, imgH] = transform.image_size;
  const [xmin, xmax, ymin, ymax] = transform.world_bounds;

  const worldX = xmin + (px / imgW) * (xmax - xmin);
  const worldY = ymax - (py / imgH) * (ymax - ymin);  // Y flipped

  return [worldX, worldY];
}

/**
 * Aggregate results from all zones
 */
function aggregateZoneResults(zoneResults, globalBounds) {
  const allFindings = [];
  const allTexts = [];
  const allDetectedObjects = [];
  let totalScore = 0;
  let scoreCount = 0;

  // Initialize total object counts
  const totalObjectCounts = {
    sprinklers: 0,
    smokeDetectors: 0,
    heatDetectors: 0,
    fireExtinguishers: 0,
    hydrants: 0,
    fireDoors: 0,
    exits: 0,
    stairs: 0,
    fireWalls: 0,
    fireHoseReels: 0
  };

  for (const zone of zoneResults) {
    if (!zone.analysis) continue;

    const analysis = zone.analysis;

    // Aggregate object counts
    if (analysis.objectCounts) {
      for (const [key, value] of Object.entries(analysis.objectCounts)) {
        if (totalObjectCounts.hasOwnProperty(key) && typeof value === 'number') {
          totalObjectCounts[key] += value;
        }
      }
    }

    // Collect detected objects with world coordinates
    if (analysis.detectedObjects && Array.isArray(analysis.detectedObjects)) {
      for (const obj of analysis.detectedObjects) {
        let worldPos = null;
        if (obj.pixel_pos && zone.transform) {
          worldPos = pixelToWorld(obj.pixel_pos, zone.transform);
        }

        allDetectedObjects.push({
          ...obj,
          zone_id: zone.zone_id,
          grid_position: zone.grid_position,
          world_position: worldPos
        });
      }
    }

    // Collect findings with world coordinates
    if (analysis.findings && Array.isArray(analysis.findings)) {
      for (const finding of analysis.findings) {
        let worldPos = null;
        if (finding.pixel_pos && zone.transform) {
          worldPos = pixelToWorld(finding.pixel_pos, zone.transform);
        }

        allFindings.push({
          ...finding,
          zone_id: zone.zone_id,
          grid_position: zone.grid_position,
          world_position: worldPos
        });
      }
    }

    // Collect Hebrew texts
    if (analysis.hebrewTexts && Array.isArray(analysis.hebrewTexts)) {
      allTexts.push(...analysis.hebrewTexts.map(t => ({
        text: t,
        zone_id: zone.zone_id
      })));
    }

    // Accumulate scores
    if (typeof analysis.zoneScore === 'number') {
      totalScore += analysis.zoneScore;
      scoreCount++;
    }
  }

  // Deduplicate findings from overlapping zones
  const deduplicatedFindings = deduplicateFindings(allFindings);

  // Deduplicate detected objects from overlapping zones
  const deduplicatedObjects = deduplicateDetectedObjects(allDetectedObjects);

  // Calculate overall score
  const overallScore = scoreCount > 0 ? Math.round(totalScore / scoreCount) : 50;

  // Recalculate counts from deduplicated objects (more accurate)
  const recountedObjects = {
    sprinklers: 0,
    smokeDetectors: 0,
    heatDetectors: 0,
    fireExtinguishers: 0,
    hydrants: 0,
    fireDoors: 0,
    exits: 0,
    stairs: 0,
    fireWalls: 0,
    fireHoseReels: 0
  };

  const typeMapping = {
    'SPRINKLER': 'sprinklers',
    'SMOKE_DETECTOR': 'smokeDetectors',
    'HEAT_DETECTOR': 'heatDetectors',
    'FIRE_EXTINGUISHER': 'fireExtinguishers',
    'HYDRANT': 'hydrants',
    'FIRE_DOOR': 'fireDoors',
    'EXIT': 'exits',
    'STAIRS': 'stairs',
    'FIRE_WALL': 'fireWalls',
    'FIRE_HOSE_REEL': 'fireHoseReels'
  };

  for (const obj of deduplicatedObjects) {
    const countKey = typeMapping[obj.type];
    if (countKey && recountedObjects.hasOwnProperty(countKey)) {
      recountedObjects[countKey]++;
    }
  }

  return {
    overallScore,
    status: overallScore >= 70 ? 'PASS' : overallScore >= 40 ? 'NEEDS_REVIEW' : 'FAIL',
    totalZonesAnalyzed: zoneResults.length,
    objectCounts: recountedObjects,
    detectedObjects: deduplicatedObjects,
    findings: deduplicatedFindings,
    hebrewTexts: allTexts,
    globalBounds: globalBounds
  };
}

/**
 * Deduplicate findings from overlapping zones based on proximity
 */
function deduplicateFindings(findings) {
  const deduplicated = [];
  const proximityThreshold = 50; // pixels

  for (const finding of findings) {
    // Check if similar finding already exists
    const isDuplicate = deduplicated.some(existing => {
      // Same category and similar position
      if (existing.category !== finding.category) return false;

      if (existing.pixel_pos && finding.pixel_pos) {
        const dx = Math.abs(existing.pixel_pos[0] - finding.pixel_pos[0]);
        const dy = Math.abs(existing.pixel_pos[1] - finding.pixel_pos[1]);
        return dx < proximityThreshold && dy < proximityThreshold;
      }

      // Same description might indicate duplicate
      if (existing.description === finding.description) return true;

      return false;
    });

    if (!isDuplicate) {
      deduplicated.push(finding);
    }
  }

  return deduplicated;
}

/**
 * Deduplicate detected objects from overlapping zones based on proximity
 */
function deduplicateDetectedObjects(objects) {
  const deduplicated = [];
  const proximityThreshold = 30; // pixels - tighter threshold for objects

  for (const obj of objects) {
    // Check if similar object already exists
    const isDuplicate = deduplicated.some(existing => {
      // Same type and similar position
      if (existing.type !== obj.type) return false;

      if (existing.pixel_pos && obj.pixel_pos) {
        const dx = Math.abs(existing.pixel_pos[0] - obj.pixel_pos[0]);
        const dy = Math.abs(existing.pixel_pos[1] - obj.pixel_pos[1]);
        return dx < proximityThreshold && dy < proximityThreshold;
      }

      return false;
    });

    if (!isDuplicate) {
      deduplicated.push(obj);
    }
  }

  return deduplicated;
}

/**
 * Main hybrid analysis function
 */
async function analyzeWithClaudeHybrid(hybridData, analysisType = 'fire-safety', customPrompt = null) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  if (!hybridData || !hybridData.zones || hybridData.zones.length === 0) {
    console.log('⚠️ No hybrid zones available, falling back to standard analysis');
    return null;
  }

  console.log(`🤖 Starting hybrid spatial analysis (${hybridData.total_zones} zones)...`);

  // STEP 1: Collect all unique block names from all zones
  const allBlockNames = new Set();
  for (const zone of hybridData.zones) {
    for (const entity of zone.entities || []) {
      if (entity.type === 'BLOCK' && entity.name) {
        allBlockNames.add(entity.name);
      }
    }
  }

  console.log(`📦 Found ${allBlockNames.size} unique block names`);

  // STEP 2: Classify block names with AI
  const blockClassifications = await classifyBlockNamesWithAI([...allBlockNames]);

  // STEP 3: Apply classifications to all entities in all zones
  const classifiedZones = hybridData.zones.map(zone => ({
    ...zone,
    entities: applyClassificationsToEntities(zone.entities || [], blockClassifications)
  }));

  // Log classification results
  const classifiedCount = Object.values(blockClassifications).filter(v => v !== 'NOT_FIRE_SAFETY').length;
  console.log(`🏷️ AI classified ${classifiedCount}/${allBlockNames.size} blocks as fire safety elements`);

  // Count total fire safety elements from classifications
  const allClassifiedEntities = classifiedZones.flatMap(z => z.entities);
  const preCounts = countClassifiedEntities(allClassifiedEntities);
  console.log(`📊 Pre-counted from blocks: ${preCounts.sprinklers} sprinklers, ${preCounts.smokeDetectors} smoke, ${preCounts.fireExtinguishers} extinguishers, ${preCounts.exits} exits`);

  // STEP 4: Process zones concurrently with classified entities
  const zoneResults = await processZonesConcurrently(classifiedZones, analysisType, 2);

  // Aggregate results
  const aggregated = aggregateZoneResults(zoneResults, hybridData.global_bounds);

  // Log object counts
  const counts = aggregated.objectCounts;
  console.log(`✅ Hybrid analysis complete: ${aggregated.findings.length} findings, score ${aggregated.overallScore}`);
  console.log(`   Objects detected: ${counts.sprinklers} sprinklers, ${counts.smokeDetectors} smoke detectors, ${counts.fireExtinguishers} extinguishers`);

  // Format for fire safety output
  // Use the higher of AI pre-counts or Claude-detected counts (AI is more reliable for block-based counts)
  const finalObjectCounts = {};
  for (const key of Object.keys(preCounts)) {
    finalObjectCounts[key] = Math.max(preCounts[key] || 0, aggregated.objectCounts[key] || 0);
  }

  return {
    overallScore: aggregated.overallScore,
    status: aggregated.status,
    summary: `ניתוח היברידי של ${hybridData.total_zones} אזורים`,
    categories: groupFindingsByCategory(aggregated.findings),
    criticalIssues: aggregated.findings.filter(f => f.status === 'fail' && f.confidence > 70).map(f => f.description),
    positiveFindings: aggregated.findings.filter(f => f.status === 'pass').map(f => f.description),
    hebrewTexts: aggregated.hebrewTexts.map(t => t.text),
    detailedReport: generateDetailedReport(aggregated),
    hybridAnalysis: true,
    zonesAnalyzed: aggregated.totalZonesAnalyzed,
    // Object counts: use the higher of AI pre-count or Claude count
    objectCounts: finalObjectCounts,
    aiPreCounts: preCounts,  // Pre-counts from AI block classification
    claudeCounts: aggregated.objectCounts,  // Counts from Claude vision
    detectedObjects: aggregated.detectedObjects,
    blockClassifications: blockClassifications,  // Include the AI classifications
    rawZoneResults: zoneResults
  };
}

/**
 * Group findings by category for structured output
 */
function groupFindingsByCategory(findings) {
  const groups = {};

  for (const finding of findings) {
    const category = finding.category || 'כללי';
    if (!groups[category]) {
      groups[category] = {
        name: category,
        findings: [],
        pass: 0,
        fail: 0,
        needsReview: 0
      };
    }

    groups[category].findings.push(finding.description);

    if (finding.status === 'pass') groups[category].pass++;
    else if (finding.status === 'fail') groups[category].fail++;
    else groups[category].needsReview++;
  }

  return Object.values(groups).map(g => ({
    name: g.name,
    score: g.findings.length > 0 ? Math.round((g.pass / g.findings.length) * 100) : 0,
    status: g.fail > 0 ? 'FAIL' : g.needsReview > 0 ? 'NEEDS_REVIEW' : 'PASS',
    count: g.findings.length,
    findings: g.findings,
    recommendations: []
  }));
}

/**
 * Generate detailed report from aggregated findings
 */
function generateDetailedReport(aggregated) {
  const lines = [
    `דוח ניתוח היברידי - ${aggregated.totalZonesAnalyzed} אזורים נבדקו`,
    `ציון כולל: ${aggregated.overallScore}/100`,
    '',
    `סה"כ ממצאים: ${aggregated.findings.length}`,
    `  - עובר: ${aggregated.findings.filter(f => f.status === 'pass').length}`,
    `  - נכשל: ${aggregated.findings.filter(f => f.status === 'fail').length}`,
    `  - דורש בדיקה: ${aggregated.findings.filter(f => f.status === 'needs_review').length}`,
    ''
  ];

  // Add findings by zone
  const byZone = {};
  for (const f of aggregated.findings) {
    if (!byZone[f.zone_id]) byZone[f.zone_id] = [];
    byZone[f.zone_id].push(f);
  }

  for (const [zoneId, zoneFindings] of Object.entries(byZone)) {
    lines.push(`--- ${zoneId} ---`);
    for (const f of zoneFindings) {
      const statusIcon = f.status === 'pass' ? '✓' : f.status === 'fail' ? '✗' : '?';
      lines.push(`${statusIcon} ${f.category || 'כללי'}: ${f.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ===== SECTION CLASSIFICATION FOR FLATTENED DXF (v8) =====
/**
 * Classify plan sections using Claude Vision
 * For flattened DXF files that have multiple plan sections side by side
 */
async function classifySectionsWithClaude(sections) {
  if (!ANTHROPIC_API_KEY || sections.length === 0) {
    return sections;
  }

  console.log(`🔬 Classifying ${sections.length} sections with Claude Vision...`);

  const classifiedSections = [];

  for (const section of sections) {
    if (!section.buffer) {
      classifiedSections.push({ ...section, classification: 'unknown' });
      continue;
    }

    try {
      const base64 = section.buffer.toString('base64');
      const mediaType = 'image/png';

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 }
              },
              {
                type: 'text',
                text: `This is one section from a multi-sheet Israeli building plan (תוכנית בנייה).

Classify this section. Common types in Israeli building plans:
- "water_schematic" — pipe layout, סכמת מים, VORTEX PLATE
- "floor_plan" — room layout with walls, doors, dimensions, stairs (תוכנית קומה)
- "elevation" — building facade view from outside (חזית)
- "building_section" — vertical cut through building showing floors (חתך)
- "roof_plan" — roof layout from above (תוכנית גגות)
- "site_plan" — plot boundary, roads, topography (תוכנית מגרש)
- "notes_legend" — text notes, tables, legend symbols, area calculations (הערות ומקרא)
- "detail" — zoomed construction detail

Return ONLY JSON:
{"type":"water_schematic|floor_plan|elevation|building_section|roof_plan|site_plan|notes_legend|detail","confidence":0-100,"fire_relevant":"critical|high|medium|low"}

IMPORTANT: If you see room layouts with walls and dimensions, it's a floor_plan. If you see a facade/front of building, it's an elevation. If you see text tables and notes, it's notes_legend (mark as "critical" fire relevance). If you see pipes and water flow, it's water_schematic (mark as "critical").`
              }
            ]
          }]
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        const content = data.content[0].text;
        // Strip markdown code fences if present
        const cleanContent = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const classification = JSON.parse(jsonMatch[0]);
          classifiedSections.push({ ...section, classification });
          console.log(`   Section ${section.sectionId}: ${classification.type} (${classification.fire_relevant || 'unknown'})`);
        } else {
          classifiedSections.push({ ...section, classification: { type: 'unknown' } });
        }
      } else {
        classifiedSections.push({ ...section, classification: { type: 'unknown' } });
      }
    } catch (err) {
      console.log(`   Section ${section.sectionId} classification error: ${err.message}`);
      classifiedSections.push({ ...section, classification: { type: 'unknown' } });
    }
  }

  return classifiedSections;
}

// ===== 20-CHECK ISRAELI FIRE SAFETY REGULATIONS =====
const FIRE_SAFETY_REGULATIONS = [
  {
    id: 'REG-001',
    category: 'ספרינקלרים',
    name: 'מרחק ספרינקלרים',
    description: 'מרחק מקסימלי בין ספרינקלרים 4.6 מטר (לפי ת"י 1596)',
    checkType: 'visual_measurement',
    standard: 'ת"י 1596'
  },
  {
    id: 'REG-002',
    category: 'ספרינקלרים',
    name: 'כיסוי ספרינקלרים',
    description: 'כל שטח הבניין מכוסה על ידי ספרינקלרים',
    checkType: 'coverage_check',
    standard: 'ת"י 1596'
  },
  {
    id: 'REG-003',
    category: 'יציאות חירום',
    name: 'רוחב יציאות',
    description: 'רוחב מינימלי של יציאת חירום 90 ס"מ (דלת בודדת)',
    checkType: 'visual_measurement',
    standard: 'תקנות התכנון והבנייה'
  },
  {
    id: 'REG-004',
    category: 'יציאות חירום',
    name: 'מספר יציאות',
    description: 'שתי יציאות חירום לפחות לכל קומה',
    checkType: 'count_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-005',
    category: 'יציאות חירום',
    name: 'מרחק מקסימלי',
    description: 'מרחק מקסימלי 40 מטר לקצה מבוי סתום',
    checkType: 'visual_measurement',
    standard: 'תקנות התכנון והבנייה'
  },
  {
    id: 'REG-006',
    category: 'מדרגות',
    name: 'מדרגות מוגנות',
    description: 'חדר מדרגות מוגן עם עמידות אש 2 שעות',
    checkType: 'marking_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-007',
    category: 'מדרגות',
    name: 'רוחב מדרגות',
    description: 'רוחב מינימלי של מדרגות 110 ס"מ',
    checkType: 'visual_measurement',
    standard: 'תקנות התכנון והבנייה'
  },
  {
    id: 'REG-008',
    category: 'דלתות אש',
    name: 'דירוג דלתות אש',
    description: 'דלתות אש עם דירוג מתאים (30/60/120 דקות)',
    checkType: 'marking_check',
    standard: 'ת"י 1220'
  },
  {
    id: 'REG-009',
    category: 'דלתות אש',
    name: 'כיוון פתיחה',
    description: 'דלתות אש נפתחות בכיוון המילוט',
    checkType: 'visual_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-010',
    category: 'גלאי עשן',
    name: 'מיקום גלאים',
    description: 'גלאי עשן בכל חדר ובמסדרונות',
    checkType: 'coverage_check',
    standard: 'ת"י 1220'
  },
  {
    id: 'REG-011',
    category: 'מטפי כיבוי',
    name: 'מרחק למטף',
    description: 'מטף כיבוי במרחק מקסימלי 25 מטר מכל נקודה',
    checkType: 'visual_measurement',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-012',
    category: 'מטפי כיבוי',
    name: 'סוג מטף',
    description: 'מטף מתאים לסוג הסיכון (A/B/C/D)',
    checkType: 'marking_check',
    standard: 'ת"י 129'
  },
  {
    id: 'REG-013',
    category: 'הידרנטים',
    name: 'מיקום הידרנטים',
    description: 'הידרנט פנימי בכל קומה ליד חדר מדרגות',
    checkType: 'location_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-014',
    category: 'תאורת חירום',
    name: 'שילוט יציאה',
    description: 'שילוט מואר ליציאות חירום',
    checkType: 'visual_check',
    standard: 'ת"י 1220'
  },
  {
    id: 'REG-015',
    category: 'הפרדות אש',
    name: 'קירות אש',
    description: 'קירות אש בין יחידות/אגפים עם עמידות מתאימה',
    checkType: 'marking_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-016',
    category: 'הפרדות אש',
    name: 'תקרות אש',
    description: 'תקרה עם עמידות אש מתאימה',
    checkType: 'marking_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-017',
    category: 'מעליות',
    name: 'מעלית כבאים',
    description: 'מעלית כבאים בבניין מעל 4 קומות',
    checkType: 'presence_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-018',
    category: 'אוורור',
    name: 'אוורור חדר מדרגות',
    description: 'פתח אוורור או מערכת שאיבת עשן בחדר מדרגות',
    checkType: 'visual_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-019',
    category: 'גישה',
    name: 'גישה לרכב כיבוי',
    description: 'גישה לרכב כיבוי אש למבנה',
    checkType: 'site_check',
    standard: 'הנ"כ 536'
  },
  {
    id: 'REG-020',
    category: 'מערכות',
    name: 'לוח כיבוי אש',
    description: 'לוח בקרה למערכת גילוי אש במיקום נגיש',
    checkType: 'presence_check',
    standard: 'ת"י 1220'
  }
];

/**
 * Run 20-check fire safety regulation analysis on classified sections
 * v40.1: Priority-based section selection + skip blank images + better prompt
 */
async function runRegulationChecks(classifiedSections, additionalContext = {}) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  console.log(`📋 Running 20-check fire safety regulation analysis...`);

  // Priority order: notes_legend first (80% of fire data), then floor_plans, water_schematic
  const priorityOrder = ['notes_legend', 'water_schematic', 'floor_plan', 'fire_system', 'building_section', 'roof_plan', 'detail', 'site_plan', 'elevation'];

  // Group sections by type
  const sectionsByType = {};
  for (const sec of classifiedSections) {
    const type = sec.classification?.type || 'unknown';
    if (!sectionsByType[type]) sectionsByType[type] = [];
    sectionsByType[type].push(sec);
  }

  // Select key sections in priority order (max 8)
  const keySections = [];
  for (const type of priorityOrder) {
    const sections = sectionsByType[type] || [];
    for (const sec of sections) {
      if (keySections.length < 8) {
        keySections.push(sec);
      }
    }
  }

  // If no key sections found, use first few of any type
  if (keySections.length === 0) {
    keySections.push(...classifiedSections.slice(0, 4));
  }

  console.log(`   Selected ${keySections.length} key sections for analysis:`);
  keySections.forEach(s => console.log(`      ${s.classification?.type || 'unknown'} — ${s.sizeKb || '?'}KB`));

  // Build image array — SKIP any images smaller than 30KB (likely blank)
  const imageContents = [];
  const includedSections = [];

  for (const section of keySections) {
    if (!section.buffer) continue;

    // Skip images that are too small (likely blank)
    if (section.buffer.length < 30000) {
      console.log(`   ⚠️ Skipping ${section.classification?.type || 'unknown'} — too small (${Math.round(section.buffer.length/1024)}KB)`);
      continue;
    }

    let mediaType = 'image/png';
    // Check for JPEG magic bytes
    if (section.buffer[0] === 0xFF && section.buffer[1] === 0xD8) {
      mediaType = 'image/jpeg';
    }

    imageContents.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: section.buffer.toString('base64')
      }
    });
    includedSections.push(section);
  }

  if (imageContents.length === 0) {
    console.log('❌ No readable section images — all too small or missing');
    return { overallScore: 25, status: 'NEEDS_REVIEW', regulationResults: [], summary: 'לא נמצאו תמונות קריאות לניתוח' };
  }

  console.log(`📤 Sending ${imageContents.length} images to Claude for regulation analysis...`);

  // Build section labels for the prompt
  const sectionLabels = includedSections.map((s, i) => `Image ${i+1}: ${s.classification?.type || 'unknown'}`).join(', ');

  // Enhanced regulation prompt with section context
  const prompt = `You are an Israeli fire safety expert (יועץ בטיחות אש).

These are sections from a building plan: ${sectionLabels}

For EACH of these 20 fire safety checks, look at the images and determine:
- PASS: clear evidence found
- LIKELY_PASS: indirect evidence or referenced via standards
- FAIL: required but missing
- NOT_VISIBLE: can't determine from these images

1. Fire resistance classification table (II-222) — ת"י 931
2. Escape routes (≥2 exits per floor) — סעיף 3.2
3. Travel distance (≤60m, ≤75m with sprinklers) — סעיף 3.3
4. Protected stairwells — סעיף 3.4
5. Headroom ≥2.1m in escape routes — סעיף 3.2.5
6. Fire doors with ratings (e.g. 90/30) — ת"י 1003
7. Fire compartmentation (walls, shafts, penetrations) — סעיף 3.6
8. Sprinkler system — ת"י 1596 / NFPA 13
9. Water supply system — סעיף 3.8
10. Fire detection system — ת"י 1220
11. FM-200 / special suppression — NFPA-2001
12. Smoke control ventilation — ת"י 1001
13. Emergency lighting / electrical — ת"י 6439
14. Fire extinguishers & hose reels — סעיף 3.9
15. Fire service vehicle access — סעיף 3.10
16. Gas safety — סעיף 3.11
17. Elevator shaft protection — סעיף 3.12
18. Railings (≥1.05m) — ת"י 1142
19. Building materials fire resistance — ת"י 931
20. Complete plan set (all sheets present)

IMPORTANT: Look carefully at ANY text visible in the images — Hebrew notes, title blocks, tables, dimensions. The notes section contains most of the fire safety specifications.

Return ONLY a JSON object:
{
  "overallScore": 0-100,
  "status": "PASS|FAIL|NEEDS_REVIEW",
  "regulationResults": [
    {"regulationId":"REG-001","name":"Fire Resistance","status":"PASS|FAIL|NEEDS_REVIEW|NOT_VISIBLE","finding":"what you found","confidence":85}
  ],
  "summary": "סיכום בעברית",
  "criticalIssues": [],
  "recommendations": []
}`;

  try {
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
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            ...imageContents,
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!resp.ok) {
      throw new Error(`Claude API error: ${resp.status}`);
    }

    const data = await resp.json();
    let content = data.content[0].text;

    // Strip markdown code fences if present
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');

    // Parse JSON response
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      console.log('❌ Claude did not return valid JSON. Response:', content.substring(0, 200));
      return { overallScore: 50, status: 'NEEDS_REVIEW', regulationResults: [], summary: 'לא הצלחנו לנתח את התשובה' };
    }

    const result = JSON.parse(content.substring(jsonStart, jsonEnd + 1));

    // If Claude returned checks instead of regulationResults, normalize
    if (result.checks && !result.regulationResults) {
      result.regulationResults = result.checks.map((c, i) => ({
        regulationId: `REG-${String(i+1).padStart(3, '0')}`,
        name: c.name,
        status: c.status?.toLowerCase().replace('likely_pass', 'pass').replace('not_visible', 'not_visible') || 'not_visible',
        finding: c.evidence || c.finding || '',
        confidence: c.score || c.confidence || 50
      }));
    }

    console.log(`✅ Regulation check complete: ${result.overallScore}/100`);

    // Count results
    const counts = { pass: 0, fail: 0, needsReview: 0, notVisible: 0 };
    for (const r of result.regulationResults || []) {
      const status = (r.status || '').toLowerCase();
      if (status === 'pass' || status === 'likely_pass') counts.pass++;
      else if (status === 'fail') counts.fail++;
      else if (status === 'needs_review') counts.needsReview++;
      else counts.notVisible++;
    }
    console.log(`   Results: ${counts.pass} pass, ${counts.fail} fail, ${counts.needsReview} review, ${counts.notVisible} not visible`);

    return result;

  } catch (err) {
    console.log(`⚠️ Regulation check error: ${err.message}`);
    return { overallScore: 0, status: 'NEEDS_REVIEW', regulationResults: [], summary: `שגיאה: ${err.message}` };
  }
}

/**
 * Complete flattened DXF pipeline
 * 1. Python renders sections
 * 2. Claude classifies each section
 * 3. Claude runs 20-check regulation analysis on relevant sections
 */
async function analyzeFlattenedDXF(pythonResult, customPrompt = null) {
  console.log('🔄 Processing flattened DXF with section detection...');

  // Step 1: Classify sections
  const classifiedSections = await classifySectionsWithClaude(pythonResult.sections);

  // Log section summary
  const sectionTypes = {};
  for (const sec of classifiedSections) {
    const type = sec.classification?.type || 'unknown';
    sectionTypes[type] = (sectionTypes[type] || 0) + 1;
  }
  console.log('   Section types:', sectionTypes);

  // Step 2: Run 20-check regulation analysis
  const regulationResult = await runRegulationChecks(classifiedSections, {
    totalEntities: pythonResult.totalEntities,
    layers: pythonResult.layers
  });

  // Build final report
  const report = {
    overallScore: regulationResult.overallScore,
    status: regulationResult.status,
    summary: regulationResult.summary,
    categories: buildCategoriesFromRegulations(regulationResult.regulationResults),
    criticalIssues: regulationResult.criticalIssues || [],
    positiveFindings: (regulationResult.regulationResults || [])
      .filter(r => r.status === 'pass')
      .map(r => `${r.name}: ${r.finding}`),
    hebrewTexts: [],
    detailedReport: regulationResult.summary,
    regulationResults: regulationResult.regulationResults,
    recommendations: regulationResult.recommendations || [],
    // Flattened-specific data
    isFlattened: true,
    sectionCount: classifiedSections.length,
    sectionTypes,
    sections: classifiedSections.map(s => ({
      sectionId: s.sectionId,
      classification: s.classification,
      bounds: s.bounds
    }))
  };

  return report;
}

/**
 * Build categories array from regulation results
 */
function buildCategoriesFromRegulations(regulationResults) {
  const categories = {};

  for (const reg of FIRE_SAFETY_REGULATIONS) {
    if (!categories[reg.category]) {
      categories[reg.category] = {
        name: reg.category,
        regulations: [],
        pass: 0,
        fail: 0,
        needsReview: 0,
        notVisible: 0
      };
    }
    categories[reg.category].regulations.push(reg);
  }

  // Match results to categories
  for (const result of regulationResults || []) {
    const reg = FIRE_SAFETY_REGULATIONS.find(r => r.id === result.regulationId);
    if (reg && categories[reg.category]) {
      if (result.status === 'pass') categories[reg.category].pass++;
      else if (result.status === 'fail') categories[reg.category].fail++;
      else if (result.status === 'needs_review') categories[reg.category].needsReview++;
      else categories[reg.category].notVisible++;
    }
  }

  // Build output array
  return Object.values(categories).map(cat => {
    const total = cat.regulations.length;
    const checked = cat.pass + cat.fail + cat.needsReview;
    const score = checked > 0 ? Math.round((cat.pass / checked) * 100) : 0;

    let status = 'NEEDS_REVIEW';
    if (cat.fail > 0) status = 'FAIL';
    else if (cat.pass > 0 && cat.fail === 0 && cat.needsReview === 0) status = 'PASS';

    return {
      name: cat.name,
      score,
      status,
      count: `${cat.pass}/${total} תקנות עוברות`,
      findings: (regulationResults || [])
        .filter(r => FIRE_SAFETY_REGULATIONS.find(reg => reg.id === r.regulationId)?.category === cat.name)
        .map(r => r.finding),
      recommendations: (regulationResults || [])
        .filter(r => FIRE_SAFETY_REGULATIONS.find(reg => reg.id === r.regulationId)?.category === cat.name && r.status === 'fail')
        .map(r => `${r.name}: נדרש תיקון`)
    };
  });
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
      temperature: 0,
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
    version: '38.0.0',
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

    // Extract text from all files — per-document budget to avoid mid-content truncation
    const MAX_TOTAL_CHARS = 100000;
    const docTexts = [];
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

        docTexts.push({ name: file.originalname, content });
        console.log(`   ✓ ${file.originalname}: ${content.length} chars`);
      } catch (e) {
        console.log(`   ✗ ${file.originalname}: ${e.message}`);
      }
    }

    if (docTexts.length === 0 || docTexts.every(d => !d.content.trim())) {
      throw new Error('לא ניתן היה לחלץ טקסט מהקבצים');
    }

    // Per-document budget: divide evenly, then trim each document to its budget
    const perDocBudget = Math.floor(MAX_TOTAL_CHARS / docTexts.length);
    let allText = '';
    for (const doc of docTexts) {
      const trimmed = doc.content.length > perDocBudget ? doc.content.substring(0, perDocBudget) + '\n[...קוצר...]' : doc.content;
      allText += `\n\n=== ${doc.name} ===\n${trimmed}`;
    }

    console.log(`📄 Total extracted: ${allText.length} chars (budget: ${perDocBudget}/doc)`);

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
        temperature: 0,
        messages: [{
          role: 'user',
          content: `${REFERENCE_EXTRACTION_PROMPT}\n\n=== תוכן המסמכים ===\n${allText}`
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

// ═══════════════════════════════════════════════════════
// SMART COMPLIANCE CHECKER ENDPOINTS (compliance-engine.js)
// ═══════════════════════════════════════════════════════

// Create new compliance project
app.post('/api/compliance/create', (req, res) => {
  if (!complianceEngine) return res.status(500).json({ error: 'Compliance engine not initialized' });
  const projectId = complianceEngine.createProject();
  res.json({ projectId });
});

// Upload reference documents — extract & categorize requirements
app.post('/api/compliance/:projectId/reference', referenceUpload.array('files', 10), async (req, res) => {
  if (!complianceEngine) return res.status(500).json({ error: 'Compliance engine not initialized' });

  try {
    const { projectId } = req.params;
    if (!complianceEngine.getProject(projectId)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    console.log('\n========================================');
    console.log('📋 SMART COMPLIANCE — Reference Upload');
    console.log(`📁 ${req.files.length} files`);
    console.log('========================================\n');

    const result = await complianceEngine.processReferenceDoc(projectId, req.files);
    res.json(result);
  } catch (err) {
    console.error('Compliance reference error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload plans — run AI checks on ai_plan_check + measurement items
app.post('/api/compliance/:projectId/check-plans', upload.single('planFile'), async (req, res) => {
  if (!complianceEngine) return res.status(500).json({ error: 'Compliance engine not initialized' });

  try {
    const { projectId } = req.params;
    const project = complianceEngine.getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'No plan file uploaded' });

    console.log('\n========================================');
    console.log('📋 SMART COMPLIANCE — Plan Check');
    console.log(`📁 ${req.file.originalname}`);
    console.log('========================================\n');

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const outputDir = path.join(tmpDir, `compliance-render-${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // Reuse existing rendering pipeline
    let planImages = [];
    let screenshotUrl = null;
    let screenshotId = null;
    let analysisMetadata = {};

    if (ext === '.dxf') {
      const pythonResult = await renderDXFWithPython(filePath, outputDir);

      if (pythonResult && pythonResult.mode === 'sections') {
        // Flattened DXF with sections
        screenshotId = uuidv4();
        for (let i = 0; i < pythonResult.sections.length; i++) {
          const sec = pythonResult.sections[i];
          if (sec.buffer) {
            planImages.push(sec.buffer);
            const secPath = path.join(publicScreenshotsDir, `${screenshotId}_section_${i}.png`);
            fs.writeFileSync(secPath, sec.buffer);
          }
        }
        if (pythonResult.sections[0]?.buffer) {
          const mainPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
          fs.writeFileSync(mainPath, pythonResult.sections[0].buffer);
          screenshotUrl = `/screenshots/${screenshotId}.png`;
        }
        analysisMetadata = {
          method: 'Flattened DXF Section Analysis',
          sectionCount: pythonResult.sections.length,
          entities: pythonResult.totalEntities,
          isFlattened: true
        };
      } else if (pythonResult && pythonResult.buffer) {
        // Standard DXF render
        planImages.push(pythonResult.buffer);
        screenshotId = uuidv4();
        const mainPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
        fs.writeFileSync(mainPath, pythonResult.buffer);
        screenshotUrl = `/screenshots/${screenshotId}.png`;

        // Also use zone images if available
        if (pythonResult.zonesData) {
          for (const z of pythonResult.zonesData) {
            if (z.buffer) planImages.push(z.buffer);
          }
        }
        analysisMetadata = {
          method: 'DXF Python Render',
          entities: pythonResult.metadata?.total_entities || 'unknown'
        };
      }

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) {}
    }

    // Limit to max 10 images to avoid huge API calls
    if (planImages.length > 10) {
      planImages = planImages.slice(0, 10);
    }

    // Run compliance check
    const result = await complianceEngine.checkPlansAgainstRequirements(projectId, planImages);

    res.json({
      ...result,
      screenshotId,
      screenshotUrl,
      analysisMetadata
    });

  } catch (err) {
    console.error('Compliance plan check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload a document to verify a specific requirement
app.post('/api/compliance/:projectId/check-document/:reqId', referenceUpload.single('file'), async (req, res) => {
  if (!complianceEngine) return res.status(500).json({ error: 'Compliance engine not initialized' });

  try {
    const { projectId, reqId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const buffer = fs.readFileSync(req.file.path);
    const result = await complianceEngine.checkDocument(projectId, reqId, buffer, req.file.originalname);
    res.json(result);
  } catch (err) {
    console.error('Compliance document check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Human marks a requirement as verified
app.post('/api/compliance/:projectId/verify/:reqId', express.json(), (req, res) => {
  if (!complianceEngine) return res.status(500).json({ error: 'Compliance engine not initialized' });

  try {
    const { projectId, reqId } = req.params;
    const { status, verifiedBy, notes } = req.body;
    complianceEngine.markAsVerified(projectId, reqId, status, verifiedBy, notes);
    const summary = complianceEngine.getSummary(projectId);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full checklist
app.get('/api/compliance/:projectId/checklist', (req, res) => {
  if (!complianceEngine) return res.status(500).json({ error: 'Compliance engine not initialized' });

  try {
    const checklist = complianceEngine.getChecklist(req.params.projectId);
    res.json(checklist);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Get project summary
app.get('/api/compliance/:projectId/summary', (req, res) => {
  if (!complianceEngine) return res.status(500).json({ error: 'Compliance engine not initialized' });

  try {
    const summary = complianceEngine.getSummary(req.params.projectId);
    if (!summary) return res.status(404).json({ error: 'Project not found' });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== COMPLIANCE MODE: ANALYZE PLAN (LEGACY) =====
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
        fullImage = await captureHighResScreenshotWithFallback(viewerToken, urn, screenshotPath);

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
      // Vision-based analysis with proper media type detection and resize
      const allBuffers = [fullImage, ...zones];
      const images = [];
      for (let i = 0; i < allBuffers.length; i++) {
        let buf = allBuffers[i];
        // Skip empty or corrupted images
        if (!buf || buf.length < 100) {
          console.log(`⚠️ Compliance: Skipping empty/broken image at index ${i}`);
          continue;
        }
        // Resize if exceeds Claude's 8000px limit
        buf = await ensureMaxSizeBuffer(buf, 7000);
        const mediaType = getMediaType(buf);
        images.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: buf.toString('base64')
          }
        });
      }

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
          temperature: 0,
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
          temperature: 0,
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
          temperature: 0,
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
    console.log('🔥 FIRE SAFETY ANALYSIS v40 (Vision + Flattened DXF)');
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
      const fullImage = await captureHighResScreenshotWithFallback(viewerToken, urn, screenshotPath);

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

    // ===== DXF: Direct parsing with Python rendering (or APS+Hybrid if available) =====
    else if (ext === '.dxf') {
      let pythonResult;
      const outputDir = path.join(tmpDir, `dxf-fire-${Date.now()}`);

      // Try APS+Hybrid first if APS is configured (higher quality rendering)
      if (APS_CLIENT_ID && puppeteer && sharp) {
        console.log('🎯 APS available - trying APS+Hybrid pipeline for best quality');
        pythonResult = await renderDXFWithAPSHybrid(filePath, outputDir);

        if (pythonResult && pythonResult.apsRendered) {
          console.log('✅ Using APS-rendered images with Python entity data');
        } else {
          console.log('⚠️ APS+Hybrid failed, using Python-only rendering');
        }
      }

      // Fallback to Python-only rendering
      if (!pythonResult || (!pythonResult.buffer && !pythonResult.mode)) {
        console.log('📐 Using DXF parsing pipeline with Python rendering');
        pythonResult = await renderDXFWithPython(filePath, outputDir);
      }

      // ===== FLATTENED DXF: Sections Mode (v8) =====
      if (pythonResult && pythonResult.mode === 'sections') {
        console.log(`🔬 FLATTENED DXF detected - using section analysis mode`);
        console.log(`   ${pythonResult.sections.length} sections, ${pythonResult.totalEntities} entities`);

        // Use the flattened DXF pipeline
        report = await analyzeFlattenedDXF(pythonResult, customPrompt);

        // Save first section image as main screenshot
        const screenshotId = uuidv4();
        if (pythonResult.sections.length > 0 && pythonResult.sections[0].buffer) {
          const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
          fs.writeFileSync(screenshotPath, pythonResult.sections[0].buffer);
          screenshotUrl = `/screenshots/${screenshotId}.png`;

          // Save all section images
          for (let i = 0; i < pythonResult.sections.length; i++) {
            const sec = pythonResult.sections[i];
            if (sec.buffer) {
              const secPath = path.join(publicScreenshotsDir, `${screenshotId}_section_${i}.png`);
              fs.writeFileSync(secPath, sec.buffer);
            }
          }
        }

        analysisData = {
          method: 'Flattened DXF Section Analysis (v8)',
          screenshotUrl,
          isFlattened: true,
          sectionCount: pythonResult.sections.length,
          entities: pythonResult.totalEntities,
          regulationChecks: 20,
          hybridAnalysis: false,
          sections: report.sections || []
        };

        // Cleanup
        if (pythonResult.outputDir) {
          try { fs.rmSync(pythonResult.outputDir, { recursive: true, force: true }); } catch (e) {}
        }
      }

      // ===== STANDARD DXF: Hybrid or Legacy Mode =====
      else if (pythonResult && pythonResult.buffer) {
        console.log('✅ Using Python-rendered image for Vision analysis');
        const screenshotId = uuidv4();
        const screenshotPath = path.join(publicScreenshotsDir, `${screenshotId}.png`);
        fs.writeFileSync(screenshotPath, pythonResult.buffer);
        const fullImage = pythonResult.buffer;
        screenshotUrl = `/screenshots/${screenshotId}.png`;

        // Check for hybrid data (v7+)
        if (pythonResult.hybridData && pythonResult.hybridData.zones && pythonResult.hybridData.zones.length > 0) {
          console.log(`🔬 Using HYBRID spatial analysis (${pythonResult.hybridData.total_zones} zones with entity data)`);

          // Use hybrid analysis with concurrent zone processing
          report = await analyzeWithClaudeHybrid(pythonResult.hybridData, 'fire-safety', customPrompt);

          // Also load zones for cache (for zone preview endpoint)
          const zones = pythonResult.hybridData.zones.map(z => {
            if (fs.existsSync(z.image_path)) {
              return fs.readFileSync(z.image_path);
            }
            return null;
          }).filter(z => z !== null);

          screenshotCache.set(screenshotId, { full: fullImage, zones });

          // Store hybrid zone data for response (entities with pixel coords)
          const hybridZonesForResponse = pythonResult.hybridData.zones.map(z => ({
            zone_id: z.zone_id,
            image_url: `/screenshots/${screenshotId}_${z.zone_id}.jpg`,
            image_size: z.image_size,
            bounds: z.bounds,
            grid_position: z.grid_position,
            entities: z.entities,
            entity_count: z.entity_count
          }));

          // Copy zone images to public directory for serving
          for (const zone of pythonResult.hybridData.zones) {
            if (fs.existsSync(zone.image_path)) {
              const destPath = path.join(publicScreenshotsDir, `${screenshotId}_${zone.zone_id}.jpg`);
              fs.copyFileSync(zone.image_path, destPath);
            }
          }

          // Determine method name based on rendering source
          const isAPSRendered = pythonResult.apsRendered || pythonResult.hybridData?.rendered_by === 'APS';
          const methodName = isAPSRendered
            ? 'APS+Hybrid Spatial Analysis (v8)'
            : 'DXF Hybrid Spatial Analysis (v7)';

          analysisData = {
            method: methodName,
            screenshotUrl,
            zones: pythonResult.hybridData.total_zones,
            imagesAnalyzed: pythonResult.hybridData.total_zones,
            entitiesExtracted: pythonResult.hybridData.zones.reduce((sum, z) => sum + (z.entity_count || 0), 0),
            entities: pythonResult.metadata?.total_entities || 'unknown',
            layers: pythonResult.metadata?.layer_count || 'unknown',
            hybridAnalysis: true,
            apsRendered: isAPSRendered,
            // Include hybrid zone data with entities
            hybridZones: hybridZonesForResponse,
            globalBounds: pythonResult.hybridData.global_bounds
          };
        } else {
          // Legacy mode: standard vision analysis
          console.log('📸 Using standard Vision analysis (no hybrid data)');

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
        }

        // Clean up Python output dir (unless we need it for debugging)
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
      rawReport: report,
      // NEW: Hybrid spatial data (zones with entities and pixel coords)
      hybridData: analysisData.hybridAnalysis ? {
        zones: analysisData.hybridZones || [],
        globalBounds: analysisData.globalBounds || null,
        totalZones: analysisData.zones || 0,
        entitiesExtracted: analysisData.entitiesExtracted || 0
      } : null
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
  console.log('🏛️ FIRE SAFETY & COMPLIANCE CHECKER v40.0');
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
  console.log('📐 Flattened DXF: Batch render + Section detection + 20-check analysis');
  console.log('========================================\n');
});

server.timeout = 900000;
server.keepAliveTimeout = 600000;
