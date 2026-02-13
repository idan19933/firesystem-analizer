/**
 * Fire Safety Checker - Railway Server v22
 * DXF: Pure text analysis + RAW DIAGNOSTICS
 * DWG: APS vector data extraction - NO IMAGES
 * Both formats now use pure text analysis!
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// DXF Vector Analyzer
const { analyzeDXF } = require('./dxf-analyzer');

// Document parsing libraries
let pdfParse, mammoth, XLSX;
try { pdfParse = require('pdf-parse'); } catch (e) { console.log('pdf-parse not installed'); }
try { mammoth = require('mammoth'); } catch (e) { console.log('mammoth not installed'); }
try { XLSX = require('xlsx'); } catch (e) { console.log('xlsx not installed'); }

const app = express();
app.use(express.json());

// CORS configuration
app.use(cors({
  origin: true, // Allow all origins
  credentials: true
}));

// Environment variables
const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Use /tmp for file uploads
const tmpDir = os.tmpdir();
const uploadsDir = path.join(tmpDir, 'uploads');
const imagesDir = path.join(tmpDir, 'images');

// Ensure directories exist
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Multer configuration for file uploads
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB limit
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.dwg', '.dxf', '.dwf', '.zip'].includes(ext)) cb(null, true);
    else cb(new Error('Only DWG/DXF/DWF/ZIP files allowed'));
  }
});

const instructionUpload = multer({
  dest: uploadsDir,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for instructions
});

// In-memory instruction storage (persists during server lifetime)
let savedInstructions = [];

/**
 * Extract DWG/DXF/DWF from ZIP file if needed
 */
function extractIfZip(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.zip') {
    return { filePath, originalName };
  }

  console.log('📦 ZIP detected, extracting...');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  // Find the first DWG/DXF/DWF file inside the ZIP (including nested folders)
  const cadEntry = entries.find(entry => {
    if (entry.isDirectory) return false;
    const entryExt = path.extname(entry.entryName).toLowerCase();
    return ['.dwg', '.dxf', '.dwf'].includes(entryExt);
  });

  if (!cadEntry) {
    throw new Error('קובץ ה-ZIP לא מכיל קבצי DWG/DXF/DWF');
  }

  // Extract to tmp directory
  const extractedFileName = path.basename(cadEntry.entryName);
  const extractedPath = path.join(tmpDir, `extracted_${Date.now()}_${extractedFileName}`);
  fs.writeFileSync(extractedPath, cadEntry.getData());

  const sizeMB = (fs.statSync(extractedPath).size / 1024 / 1024).toFixed(1);
  console.log(`✅ Extracted: ${extractedFileName} (${sizeMB}MB) from ${cadEntry.entryName}`);
  return { filePath: extractedPath, originalName: extractedFileName };
}

/**
 * Parse instruction files to extract text
 */
async function parseInstructionFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const content = fs.readFileSync(filePath);

  try {
    if (['.txt', '.md'].includes(ext)) return content.toString('utf8');
    if (ext === '.pdf' && pdfParse) { const data = await pdfParse(content); return data.text; }
    if (['.doc', '.docx'].includes(ext) && mammoth) { const result = await mammoth.extractRawText({ buffer: content }); return result.value; }
    if (['.xlsx', '.xls'].includes(ext) && XLSX) {
      const workbook = XLSX.read(content, { type: 'buffer' });
      let text = '';
      workbook.SheetNames.forEach(sheetName => { text += `\n--- ${sheetName} ---\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])}`; });
      return text;
    }
    if (['.png', '.jpg', '.jpeg'].includes(ext)) return await extractTextFromImage(content);
    return 'Could not parse file content';
  } catch (e) { return 'Error parsing file: ' + e.message; }
}

/**
 * Extract text from image using Claude Vision
 */
async function extractTextFromImage(imageBuffer) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929', max_tokens: 4000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBuffer.toString('base64') } },
        { type: 'text', text: 'חלץ את כל הטקסט מתמונה זו. החזר את הטקסט בדיוק כפי שהוא מופיע.' }
      ]}]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ===== APS (Autodesk Platform Services) Functions =====

let tokenCache = { token: null, expires: 0 };

async function getAPSToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const credentials = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read data:write bucket:create bucket:read' })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('APS auth failed');
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function ensureBucket(token) {
  const bucketKey = `firechecker_${APS_CLIENT_ID.toLowerCase().substring(0, 8)}`;
  try {
    await fetch('https://developer.api.autodesk.com/oss/v2/buckets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketKey, policyKey: 'transient' })
    });
  } catch (e) {}
  return bucketKey;
}

async function uploadToAPS(token, bucketKey, filePath, fileName) {
  const ext = path.extname(fileName).toLowerCase() || '.dwg';
  const safeFileName = `plan_${Date.now()}${ext}`;
  const fileData = fs.readFileSync(filePath);

  const signedResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}/signeds3upload?parts=1`,
    { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }
  );
  const signedData = await signedResp.json();
  if (!signedData.urls?.[0]) throw new Error('Failed to get signed URL');

  await fetch(signedData.urls[0], { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: fileData });

  const completeResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${safeFileName}/signeds3upload`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadKey: signedData.uploadKey }) }
  );
  const completeData = await completeResp.json();
  if (!completeData.objectId) throw new Error('Upload completion failed');
  return Buffer.from(completeData.objectId).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function translateToSVF2(token, urn) {
  await fetch('https://developer.api.autodesk.com/modelderivative/v2/designdata/job', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'true' },
    body: JSON.stringify({
      input: { urn },
      output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] }
    })
  });
}

async function waitForTranslation(token, urn, maxWait = 900000) { // 15 minutes for large files
  const start = Date.now();
  let lastProgress = '';

  while (Date.now() - start < maxWait) {
    const resp = await fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await resp.json();

    const progress = data.progress || 'unknown';
    if (progress !== lastProgress) {
      console.log(`Translation: ${progress} (${data.status})`);
      lastProgress = progress;
    }

    if (data.status === 'success') return data;
    if (data.status === 'failed') {
      const errorMsg = data.derivatives?.find(d => d.status === 'failed')?.messages?.[0]?.message || 'Translation failed';
      throw new Error(errorMsg);
    }

    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Translation timeout - try a smaller file');
}

// ===== APS VECTOR DATA EXTRACTION (NO IMAGES) =====

// Get metadata GUIDs from APS
async function getAPSMetadataGUIDs(token, urn) {
  console.log('Getting APS metadata GUIDs...');
  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const data = await resp.json();
  console.log('Metadata response:', JSON.stringify(data, null, 2));
  return data;
}

// Get ALL properties of ALL objects from APS
async function getAPSProperties(token, urn, guid) {
  console.log(`Extracting properties for GUID: ${guid}...`);
  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties?forceget=true`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!resp.ok) {
    console.log(`Properties request failed: ${resp.status}`);
    return null;
  }

  const data = await resp.json();
  console.log(`Properties: ${data.data?.collection?.length || 0} objects extracted`);
  return data;
}

// Get object tree from APS
async function getAPSObjectTree(token, urn, guid) {
  console.log(`Extracting object tree for GUID: ${guid}...`);
  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}?forceget=true`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!resp.ok) {
    console.log(`Object tree request failed: ${resp.status}`);
    return null;
  }

  const data = await resp.json();
  return data;
}

// Build structured summary from APS extracted data
function buildAPSVectorSummary(propertiesData, treeData) {
  const objects = propertiesData?.data?.collection || [];

  const layers = new Set();
  const texts = [];
  const blocks = [];
  const dimensions = [];
  const allPropertyKeys = new Set();

  // Fire safety keyword patterns
  const fireKeywords = {
    'ספרינקלר': /ספרינק|מתז|SPRINK|SPR/i,
    'גלאי עשן': /גלאי.?עשן|עשן|SMOKE|SD/i,
    'גלאי חום': /גלאי.?חום|חום|HEAT|HD/i,
    'מטף': /מטף|מטפה|EXTING|FE/i,
    'הידרנט': /הידרנט|ברז.?כיבוי|HYDRANT|FH|IH/i,
    'יציאה': /יציאה|מוצא|EXIT/i,
    'מדרגות': /מדרגות|STAIR/i,
    'דלת אש': /דלת.?אש|FIRE.?DOOR|FD/i,
    'חירום': /חירום|EMERGENCY/i,
    'קיר אש': /קיר.?אש|FIRE.?WALL/i,
  };
  const fireMatches = {};

  objects.forEach(obj => {
    const props = obj.properties || {};
    const name = obj.name || '';

    // Collect all property keys
    Object.keys(props).forEach(key => allPropertyKeys.add(key));

    // Extract layer info
    const layer = props.Layer || props['Layer Name'] || props.layer || '';
    if (layer) layers.add(layer);

    // Extract text content (multiple possible property names)
    const textValue = props['Text Value'] || props['Contents'] || props['Text String'] ||
                      props['TextString'] || props['Text'] || props['String'] || '';
    if (textValue && textValue.length > 0) {
      texts.push({
        text: textValue,
        layer: layer,
        name: name,
        position: props.Position || props.Location || ''
      });

      // Check for fire safety keywords
      Object.entries(fireKeywords).forEach(([keyword, pattern]) => {
        if (pattern.test(textValue) || pattern.test(name)) {
          if (!fireMatches[keyword]) fireMatches[keyword] = [];
          fireMatches[keyword].push(textValue || name);
        }
      });
    }

    // Extract block/component names
    const blockName = props['Block Name'] || props['Component Name'] || props['BlockName'] || '';
    if (blockName || (name && name !== 'Model')) {
      blocks.push({
        name: blockName || name,
        layer: layer,
        type: obj.objectType || props.Type || ''
      });

      // Check blocks for fire keywords
      Object.entries(fireKeywords).forEach(([keyword, pattern]) => {
        if (pattern.test(blockName) || pattern.test(name)) {
          if (!fireMatches[keyword]) fireMatches[keyword] = [];
          fireMatches[keyword].push(blockName || name);
        }
      });
    }

    // Extract dimensions/measurements
    const measurement = props.Measurement || props.Value || props.Length ||
                        props.Width || props.Height || props.Area || '';
    if (measurement) {
      dimensions.push({ value: measurement, layer: layer, name: name });
    }
  });

  // Count block occurrences
  const blockCounts = {};
  blocks.forEach(b => {
    const key = b.name;
    blockCounts[key] = (blockCounts[key] || 0) + 1;
  });

  // Build summary text
  let summary = `
=== APS EXTRACTED VECTOR DATA FROM DWG ===

TOTAL OBJECTS EXTRACTED: ${objects.length}

LAYERS (${layers.size}):
${[...layers].join(', ') || 'No layer information extracted'}

=== ALL TEXT CONTENT (${texts.length} items) ===
${texts.length === 0 ? 'No text entities found in extracted data.\n' :
  texts.map((t, i) => `${i + 1}. "${t.text}" [layer: ${t.layer || 'unknown'}]${t.position ? ` at ${t.position}` : ''}`).join('\n')}

=== BLOCK/COMPONENT REFERENCES (${Object.keys(blockCounts).length} unique) ===
${Object.entries(blockCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 50)
  .map(([name, count]) => `- "${name}": ${count} instances`)
  .join('\n') || 'No blocks found'}

=== DIMENSIONS/MEASUREMENTS (${dimensions.length} items) ===
${dimensions.slice(0, 30).map(d => `- ${d.value} [${d.layer || 'unknown'}] ${d.name || ''}`).join('\n') || 'No dimensions found'}

=== FIRE SAFETY KEYWORDS DETECTED ===
${Object.entries(fireMatches).length === 0 ? 'No fire safety keywords detected in extracted data.\n' :
  Object.entries(fireMatches).map(([keyword, matches]) =>
    `${keyword}: ${matches.length} matches\n  Examples: ${[...new Set(matches)].slice(0, 5).join(', ')}`
  ).join('\n')}

=== AVAILABLE PROPERTY TYPES ===
${[...allPropertyKeys].slice(0, 50).join(', ')}

=== SAMPLE OBJECTS (first 30 with details) ===
${objects.slice(0, 30).map(obj => {
  const props = obj.properties || {};
  const relevantProps = {};
  ['Layer', 'Text Value', 'Contents', 'Block Name', 'Type', 'Name', 'Measurement', 'Length', 'Width', 'Height', 'Area']
    .forEach(k => { if (props[k]) relevantProps[k] = props[k]; });
  return `- ${obj.name || 'unnamed'}: ${JSON.stringify(relevantProps)}`;
}).join('\n')}
`;

  return summary;
}

// Main function: Extract vector data from APS (NO IMAGES)
async function extractAPSVectorData(token, urn) {
  console.log('Extracting vector data from APS (no images)...');

  // Step 1: Get metadata GUIDs
  const metaData = await getAPSMetadataGUIDs(token, urn);
  const viewables = metaData.data?.metadata || [];

  if (viewables.length === 0) {
    throw new Error('No viewable metadata found in APS translation');
  }

  console.log(`Found ${viewables.length} viewables:`, viewables.map(v => ({ name: v.name, guid: v.guid, role: v.role })));

  // Prefer 2D views, fall back to first available
  const view2D = viewables.find(v => v.role === '2d' || v.name?.includes('2D') || v.name?.includes('Model'));
  const selectedView = view2D || viewables[0];
  const guid = selectedView.guid;

  console.log(`Selected view: ${selectedView.name} (${guid})`);

  // Step 2: Get all properties
  const propertiesData = await getAPSProperties(token, urn, guid);

  // Step 3: Get object tree
  const treeData = await getAPSObjectTree(token, urn, guid);

  // Step 4: Build summary
  const vectorSummary = buildAPSVectorSummary(propertiesData, treeData);

  console.log(`Vector summary: ${vectorSummary.length} characters`);

  return {
    vectorSummary,
    objectCount: propertiesData?.data?.collection?.length || 0,
    viewName: selectedView.name,
    guid
  };
}

// Analyze DWG vector data with Claude (TEXT ONLY - NO IMAGES)
async function analyzeDWGVectorData(vectorSummary) {
  console.log('  Sending DWG vector data to Claude (text mode)...');

  const prompt = `אתה מהנדס בטיחות אש ישראלי המנתח נתוני וקטור שחולצו מקובץ DWG אדריכלי.

${vectorSummary}

בצע בדיקת תאימות מלאה לבטיחות אש בהתאם לתקנות הישראליות:
- תקנות הבטיחות באש
- הוראות נציב כבאות 536, 550
- TI-1220 (מערכות גילוי אש)
- TI-1596 (מערכות ספרינקלרים)

נתח את כל התוויות, שמות הבלוקים, השכבות והמידות כדי לזהות אלמנטים של בטיחות אש.

קטגוריות לבדיקה:
1. דרכי גישה לכבאות
2. דרכי מילוט ויציאות
3. מערכת גילוי אש (גלאי עשן, גלאי חום)
4. מערכת ספרינקלרים
5. ציוד כיבוי ידני (מטפים, הידרנטים)
6. הפרדות אש (קירות אש, דלתות אש)
7. תאורת חירום ושילוט
8. שליטה בעשן
9. מערכות צנרת אש
10. תיעוד ותכנון

החזר JSON בפורמט הבא:
\`\`\`json
{
  "buildingType": "תיאור סוג המבנה בעברית",
  "overallScore": 0-100,
  "overallStatus": "עובר/נכשל/דורש_בדיקה",
  "identifiedElements": {
    "sprinklers": { "count": 0, "coverage": "תיאור" },
    "smokeDetectors": { "count": 0 },
    "fireExtinguishers": { "count": 0 },
    "hydrants": { "count": 0 },
    "exits": { "count": 0, "locations": [] },
    "fireDoors": { "count": 0 },
    "stairs": { "count": 0 },
    "rooms": { "count": 0 }
  },
  "categories": [
    {"id": 1, "name": "דרכי גישה לכבאות", "nameHe": "דרכי גישה לכבאות", "status": "עובר/נכשל/דורש_בדיקה", "score": 0-100, "findings": ["ממצא"], "recommendations": ["המלצה"]},
    {"id": 2, "name": "דרכי מילוט ויציאות", "nameHe": "דרכי מילוט ויציאות", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 3, "name": "מערכת גילוי אש", "nameHe": "מערכת גילוי אש", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 4, "name": "מערכת ספרינקלרים", "nameHe": "מערכת ספרינקלרים", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 5, "name": "ציוד כיבוי ידני", "nameHe": "ציוד כיבוי ידני", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 6, "name": "הפרדות אש", "nameHe": "הפרדות אש", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 7, "name": "תאורת חירום ושילוט", "nameHe": "תאורת חירום ושילוט", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 8, "name": "שליטה בעשן", "nameHe": "שליטה בעשן", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 9, "name": "מערכות צנרת אש", "nameHe": "מערכות צנרת אש", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 10, "name": "תיעוד ותכנון", "nameHe": "תיעוד ותכנון", "status": "...", "score": 0-100, "findings": [], "recommendations": []}
  ],
  "criticalIssues": ["בעיה קריטית בעברית"],
  "summary": "סיכום מפורט בעברית",
  "summaryHe": "סיכום מפורט בעברית"
}
\`\`\`

חשוב: כל הטקסט בעברית!`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await resp.json();
  if (data.error) throw new Error(`Claude API Error: ${JSON.stringify(data.error)}`);

  const rawText = data.content[0].text;
  console.log('  Claude response received. Parsing JSON...');

  // Parse analysis JSON
  let analysis;
  try {
    const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/\{[\s\S]*"categories"[\s\S]*\}/);
    analysis = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawText);
  } catch (e) {
    console.log('  Warning: Could not parse JSON, returning raw text');
    analysis = { rawText, parseError: true };
  }

  return analysis;
}

// ===== Prompts =====

const FIRE_SAFETY_PROMPT = `אתה מומחה לבטיחות אש המנתח תוכנית אדריכלית/הנדסית.

בצע בדיקת תאימות מקיפה לבטיחות אש בהתאם לתקנות הבטיחות באש הישראליות.

קטגוריות לבדיקה:
1. יציאות חירום - מספר, מיקום, רוחב (מינימום 90 ס"מ)
2. מסלולי מילוט - רוחב מסדרונות, סימון
3. דלתות אש - מיקום וסימון
4. חדרי מדרגות - עיצוב מוגן, רוחב
5. מערכות כיבוי אש - ספרינקלרים, מטפים
6. הפרדה אש - קירות עמידי אש
7. אוורור ושליטה בעשן
8. נגישות - מסלולי מילוט נגישים
9. מערכות צנרת אש
10. פריסה כללית

פורמט פלט JSON:
\`\`\`json
{
  "buildingType": "תיאור בעברית",
  "overallScore": 0-100,
  "overallStatus": "עובר/נכשל/דורש_בדיקה",
  "categories": [
    {
      "id": 1,
      "name": "יציאות חירום",
      "nameHe": "יציאות חירום",
      "status": "עובר/נכשל/דורש_בדיקה/לא_נראה",
      "score": 0-100,
      "findings": ["ממצא בעברית"],
      "recommendations": ["המלצה בעברית"]
    }
  ],
  "criticalIssues": ["בעיה קריטית בעברית"],
  "summary": "סיכום בעברית",
  "summaryHe": "סיכום בעברית"
}
\`\`\`

חשוב: כל הטקסט בעברית!`;

function buildCustomPrompt(instructionText, instructionName) {
  return `אתה מומחה לניתוח תוכניות.

נתח על פי ההנחיות:
=== ${instructionName} ===
${instructionText}
=== סוף הנחיות ===

פורמט פלט JSON:
\`\`\`json
{
  "buildingType": "תיאור בעברית",
  "overallScore": 0-100,
  "overallStatus": "עובר/נכשל/דורש_בדיקה",
  "categories": [{"id": 1, "name": "שם", "nameHe": "שם", "status": "עובר", "score": 100, "findings": [], "recommendations": []}],
  "criticalIssues": [],
  "summary": "סיכום בעברית",
  "summaryHe": "סיכום בעברית"
}
\`\`\`

כל הטקסט בעברית!`;
}

function getInstructionPrompt(instructionId) {
  if (instructionId === 'fire-safety') return FIRE_SAFETY_PROMPT;
  const instruction = savedInstructions.find(i => i.id === instructionId);
  if (!instruction) return FIRE_SAFETY_PROMPT;
  return buildCustomPrompt(instruction.prompt, instruction.name);
}

// ===== DXF TEXT-BASED ANALYSIS (NO IMAGES) =====

const DXF_TEXT_ANALYSIS_PROMPT = `אתה מומחה לבטיחות אש המנתח נתוני וקטור גולמיים מקובץ DXF של תוכנית אדריכלית.

קיבלת מידע מפורט על כל האלמנטים בתוכנית:
- כל התוויות והטקסטים עם המיקומים שלהם
- עיגולים (סימולים פוטנציאליים כמו ספרינקלרים, גלאים)
- קשתות (דלתות - ציר פתיחה)
- פוליקווים סגורים (חדרים, תאי אש)
- הפניות לבלוקים (סמלים סטנדרטיים)

בצע ניתוח מקיף לבטיחות אש בהתאם לתקנות הישראליות:
- תקנות הבטיחות באש
- הוראות נציב כבאות 536, 550
- TI-1220 (מערכות גילוי)
- TI-1596 (מערכות ספרינקלרים)

קטגוריות לבדיקה:
1. דרכי גישה לכבאות
2. דרכי מילוט ויציאות - מספר, מיקום, רוחב (מינימום 90 ס"מ)
3. מערכת גילוי אש - גלאי עשן, גלאי חום
4. מערכת ספרינקלרים - פריסה, כיסוי
5. ציוד כיבוי ידני - מטפים, הידרנטים
6. הפרדות אש - קירות אש, דלתות אש
7. תאורת חירום ושילוט - סימון יציאות
8. שליטה בעשן - אוורור
9. מערכות צנרת אש
10. תיעוד ותכנון

הנחיות לזיהוי:
- עיגולים קטנים בתבנית רשת = ספרינקלרים
- עיגולים עם תווית SD/גלאי = גלאי עשן
- קשתות 90° ברדיוס 0.7-1.5 מ' = דלתות
- טקסט "יציאה/EXIT/מוצא" = יציאות חירום
- טקסט "מדרגות/STAIR" = חדרי מדרגות
- טקסט "אש/FIRE/FD" = דלתות אש

פורמט פלט JSON:
\`\`\`json
{
  "buildingType": "תיאור סוג המבנה בעברית",
  "overallScore": 0-100,
  "overallStatus": "עובר/נכשל/דורש_בדיקה",
  "identifiedElements": {
    "sprinklers": { "count": 0, "coverage": "תיאור" },
    "smokeDetectors": { "count": 0 },
    "fireExtinguishers": { "count": 0 },
    "hydrants": { "count": 0 },
    "exits": { "count": 0, "locations": [] },
    "fireDoors": { "count": 0 },
    "stairs": { "count": 0 },
    "rooms": { "count": 0 }
  },
  "categories": [
    {"id": 1, "name": "דרכי גישה לכבאות", "nameHe": "דרכי גישה לכבאות", "status": "עובר/נכשל/דורש_בדיקה", "score": 0-100, "findings": ["ממצא בעברית"], "recommendations": ["המלצה בעברית"]},
    {"id": 2, "name": "דרכי מילוט ויציאות", "nameHe": "דרכי מילוט ויציאות", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 3, "name": "מערכת גילוי אש", "nameHe": "מערכת גילוי אש", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 4, "name": "מערכת ספרינקלרים", "nameHe": "מערכת ספרינקלרים", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 5, "name": "ציוד כיבוי ידני", "nameHe": "ציוד כיבוי ידני", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 6, "name": "הפרדות אש", "nameHe": "הפרדות אש", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 7, "name": "תאורת חירום ושילוט", "nameHe": "תאורת חירום ושילוט", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 8, "name": "שליטה בעשן", "nameHe": "שליטה בעשן", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 9, "name": "מערכות צנרת אש", "nameHe": "מערכות צנרת אש", "status": "...", "score": 0-100, "findings": [], "recommendations": []},
    {"id": 10, "name": "תיעוד ותכנון", "nameHe": "תיעוד ותכנון", "status": "...", "score": 0-100, "findings": [], "recommendations": []}
  ],
  "criticalIssues": ["בעיה קריטית בעברית"],
  "summary": "סיכום מפורט בעברית",
  "summaryHe": "סיכום מפורט בעברית"
}
\`\`\`

חשוב: כל הטקסט בעברית! השתמש בנתונים הוקטוריים כדי לזהות אלמנטים ולבסס את הציונים.`;

// Pure text-based DXF analysis function (no images)
async function analyzeDXFText(vectorSummary) {
  console.log('  Sending vector data to Claude (text mode, no images)...');
  console.log('  Summary length: ' + vectorSummary.length + ' chars');

  const prompt = `${DXF_TEXT_ANALYSIS_PROMPT}

=== נתוני הוקטור מהקובץ ===
${vectorSummary}
=== סוף נתוני הוקטור ===

נתח את הנתונים הללו וזהה את כל האלמנטים הרלוונטיים לבטיחות אש.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await resp.json();
  if (data.error) throw new Error(`Claude API Error: ${JSON.stringify(data.error)}`);

  const rawText = data.content[0].text;
  console.log('  Claude response received. Parsing JSON...');

  // Parse analysis JSON
  let analysis;
  try {
    const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/\{[\s\S]*"categories"[\s\S]*\}/);
    analysis = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawText);
  } catch (e) {
    console.log('  Warning: Could not parse JSON, returning raw text');
    analysis = { rawText, parseError: true };
  }

  return analysis;
}

// ===== ROUTES =====

// Serve static files from public directory
app.use(express.static('public'));

// Serve analyzed images
app.use('/images', express.static(imagesDir));

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    aps: APS_CLIENT_ID ? '✅' : '❌',
    claude: ANTHROPIC_API_KEY ? '✅' : '❌',
    version: '22.0.0-railway'
  });
});

// Instructions endpoints
app.get('/api/instructions', (req, res) => {
  res.json({ instructions: savedInstructions });
});

app.post('/api/instructions', instructionUpload.single('instructionFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const prompt = await parseInstructionFile(req.file.path, req.file.originalname);
    const id = uuidv4();
    const ext = path.extname(req.file.originalname).toLowerCase();
    const iconMap = { '.pdf': '📕', '.doc': '📘', '.docx': '📘', '.txt': '📄', '.xlsx': '📊', '.png': '🖼️', '.jpg': '🖼️' };
    const instruction = { id, name: req.body.name || 'Untitled', icon: iconMap[ext] || '📋', originalFileName: req.file.originalname, createdAt: new Date().toISOString(), prompt };
    savedInstructions.push(instruction);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, id, name: instruction.name });
  } catch (e) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/instructions/:id', (req, res) => {
  savedInstructions = savedInstructions.filter(i => i.id !== req.params.id);
  res.json({ success: true });
});

// Parse instruction file (for client-side storage)
app.post('/api/parse-instruction', instructionUpload.single('instructionFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const content = await parseInstructionFile(req.file.path, req.file.originalname);
    fs.unlinkSync(req.file.path);
    if (!content || content.length < 10) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }
    res.json({ success: true, content, originalFileName: req.file.originalname });
  } catch (e) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: e.message });
  }
});

// Main analysis endpoint
app.post('/api/analyze', upload.single('dwgFile'), async (req, res) => {
  const startTime = Date.now();
  let extractedFilePath = null;

  // Timeout protection - prevent hanging containers
  const ANALYSIS_TIMEOUT = 20 * 60 * 1000; // 20 minutes for large DWG files
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      console.error('Analysis timed out after 5 minutes');
      res.status(504).json({ error: 'Analysis timed out after 5 minutes' });
    }
  }, ANALYSIS_TIMEOUT);

  try {
    if (!req.file) {
      clearTimeout(timeoutId);
      return res.status(400).json({ error: 'No file' });
    }

    // Extract from ZIP if needed
    let filePath = req.file.path;
    let originalName = req.file.originalname;
    try {
      const extracted = extractIfZip(filePath, originalName);
      if (extracted.filePath !== filePath) {
        extractedFilePath = extracted.filePath;
      }
      filePath = extracted.filePath;
      originalName = extracted.originalName;
    } catch (zipErr) {
      clearTimeout(timeoutId);
      return res.status(400).json({ error: zipErr.message });
    }

    const ext = path.extname(originalName).toLowerCase();
    const isDXF = ext === '.dxf';

    // ===== DXF FILES: Pure text-based analysis (no images) =====
    if (isDXF) {
      console.log('DXF file detected - using PURE TEXT analysis (no images)');

      // Step 1: Parse DXF and extract vector summary
      console.log('  Parsing DXF file...');
      const result = await analyzeDXF(filePath);

      if (!result.vectorSummary) {
        throw new Error('Failed to extract vector data from DXF');
      }

      console.log(`  Extracted: ${result.parsed.entityCount} entities, ${result.parsed.textCount} texts`);

      // Step 2: Send vector summary to Claude (text API, no images)
      const analysis = await analyzeDXFText(result.vectorSummary);

      // Cleanup temp files
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      if (extractedFilePath) try { fs.unlinkSync(extractedFilePath); } catch(e) {}

      clearTimeout(timeoutId);
      return res.json({
        success: true,
        filename: originalName,
        analysis,
        analysisMethod: 'text-vector',
        vectorData: {
          entityCount: result.parsed.entityCount,
          textCount: result.parsed.textCount,
          circleCount: result.parsed.circleCount,
          arcCount: result.parsed.arcCount,
          blockCount: result.parsed.blockCount,
          layerCount: result.parsed.layerCount,
          bounds: result.parsed.bounds
        },
        // No imageUrl or zoneUrls - pure text analysis
        sourceType: 'vector-dxf-text',
        sourceDimensions: `${result.parsed.entityCount} entities`,
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }

    // ===== DWG FILES: APS Vector Data Extraction (NO IMAGES) =====
    console.log('DWG file detected - using APS vector data extraction (no images)');

    // Step 1: Upload and translate with APS
    const token = await getAPSToken();
    const bucketKey = await ensureBucket(token);
    const urn = await uploadToAPS(token, bucketKey, filePath, originalName);
    await translateToSVF2(token, urn);
    await waitForTranslation(token, urn);

    // Step 2: Extract vector data (properties, layers, text, blocks)
    const vectorResult = await extractAPSVectorData(token, urn);

    console.log(`  Extracted ${vectorResult.objectCount} objects from view: ${vectorResult.viewName}`);

    // Step 3: Send vector data to Claude (TEXT ONLY)
    const analysis = await analyzeDWGVectorData(vectorResult.vectorSummary);

    // Cleanup
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    if (extractedFilePath) try { fs.unlinkSync(extractedFilePath); } catch(e) {}

    clearTimeout(timeoutId);
    res.json({
      success: true,
      filename: originalName,
      analysis,
      analysisMethod: 'vector-aps',
      vectorData: {
        objectCount: vectorResult.objectCount,
        viewName: vectorResult.viewName,
        guid: vectorResult.guid
      },
      // No imageUrl or zoneUrls - pure vector analysis
      sourceType: 'aps-properties',
      processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
    });
  } catch (e) {
    clearTimeout(timeoutId);
    console.error('Analysis error:', e);
    if (req.file?.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch(err) {}
    if (extractedFilePath && fs.existsSync(extractedFilePath)) try { fs.unlinkSync(extractedFilePath); } catch(err) {}
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/images')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Start server with extended timeouts for large file processing
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🔥 Fire Safety Checker running on port ${PORT}`);
  console.log(`   APS: ${APS_CLIENT_ID ? '✅' : '❌'}`);
  console.log(`   Claude: ${ANTHROPIC_API_KEY ? '✅' : '❌'}`);
  console.log(`   Version: 22.0.0-railway`);
  console.log(`   Timeouts: 25min server, 20min analysis, 15min translation`);
});

// Extended timeouts for large DWG processing (32MB+ files)
server.timeout = 25 * 60 * 1000;        // 25 minutes
server.keepAliveTimeout = 25 * 60 * 1000;
server.headersTimeout = 26 * 60 * 1000;
