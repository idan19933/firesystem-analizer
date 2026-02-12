/**
 * Fire Safety Checker - Railway Server v14
 * Standalone Express server for Railway deployment
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

async function waitForTranslation(token, urn, maxWait = 420000) {
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

async function getHighResolutionImages(token, urn) {
  const sharp = require('sharp');

  const manifestResp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const manifest = await manifestResp.json();
  console.log('Manifest status:', manifest.status);

  const derivatives = manifest.derivatives || [];
  const allImages = [];

  function findImages(children, parentName = '') {
    for (const child of children || []) {
      const name = child.name || parentName;
      if (child.urn && (child.mime?.startsWith('image/') || child.role === 'graphics' || child.role === 'thumbnail')) {
        allImages.push({ urn: child.urn, name: name || 'Image', mime: child.mime, role: child.role });
        console.log('Found image:', name, child.role, child.mime);
      }
      if (child.children) findImages(child.children, name);
    }
  }

  for (const deriv of derivatives) findImages(deriv.children, deriv.name);
  console.log(`Found ${allImages.length} image derivatives`);

  let bestImage = null;
  for (const img of allImages) {
    try {
      const derivResp = await fetch(
        `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/derivatives/${encodeURIComponent(img.urn)}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (derivResp.ok) {
        const buffer = Buffer.from(await derivResp.arrayBuffer());
        if (!bestImage || buffer.length > bestImage.buffer.length) {
          bestImage = { buffer, name: img.name };
          console.log('Downloaded derivative:', img.name, buffer.length, 'bytes');
        }
      }
    } catch (e) {
      console.log('Derivative download failed:', img.name);
    }
  }

  let thumbnailBuffer = null;
  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/thumbnail?width=400&height=400`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (resp.ok) {
    thumbnailBuffer = Buffer.from(await resp.arrayBuffer());
    console.log('Got thumbnail:', thumbnailBuffer.length, 'bytes');
  }

  let sourceBuffer, sourceType;
  if (bestImage && bestImage.buffer.length > (thumbnailBuffer?.length || 0)) {
    sourceBuffer = bestImage.buffer;
    sourceType = 'derivative';
  } else if (thumbnailBuffer) {
    sourceBuffer = thumbnailBuffer;
    sourceType = 'thumbnail';
  } else {
    throw new Error('No images available from APS');
  }

  const sourceMeta = await sharp(sourceBuffer).metadata();
  console.log(`Source image: ${sourceMeta.width}x${sourceMeta.height}`);

  const maxSize = 4000;
  const scale = Math.min(maxSize / (sourceMeta.width || 400), maxSize / (sourceMeta.height || 400), 10);
  const targetW = Math.round((sourceMeta.width || 400) * scale);
  const targetH = Math.round((sourceMeta.height || 400) * scale);

  const fullImage = await sharp(sourceBuffer)
    .resize(targetW, targetH, { kernel: 'lanczos3', fit: 'inside' })
    .sharpen({ sigma: 1.5, m1: 1.0, m2: 0.5 })
    .png({ quality: 100, compressionLevel: 6 })
    .toBuffer();

  console.log(`Output image: ${targetW}x${targetH}`);

  const zones = [];
  const imgMeta = await sharp(fullImage).metadata();
  const w = imgMeta.width || 2048;
  const h = imgMeta.height || 2048;
  const zoneW = Math.floor(w / 3);
  const zoneH = Math.floor(h / 3);

  const zoneLabels = [
    ['עליון שמאלי', 'עליון אמצעי', 'עליון ימני'],
    ['אמצעי שמאלי', 'מרכז', 'אמצעי ימני'],
    ['תחתון שמאלי', 'תחתון אמצעי', 'תחתון ימני']
  ];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      try {
        const zoneBuffer = await sharp(fullImage)
          .extract({ left: col * zoneW, top: row * zoneH, width: Math.min(zoneW, w - col * zoneW), height: Math.min(zoneH, h - row * zoneH) })
          .sharpen({ sigma: 1.0 })
          .png()
          .toBuffer();
        zones.push({ buffer: zoneBuffer, label: zoneLabels[row][col] });
      } catch (e) {
        console.log(`Failed to extract zone ${row},${col}:`, e.message);
      }
    }
  }

  return { fullImage, zones, sourceType, sourceDimensions: `${sourceMeta.width}x${sourceMeta.height}`, outputDimensions: `${targetW}x${targetH}` };
}

async function analyzeWithAI(imageBuffers, analysisPrompt) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBuffers.fullImage.toString('base64') } },
    { type: 'text', text: 'זוהי התוכנית המלאה.' }
  ];
  for (const zone of imageBuffers.zones) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: zone.buffer.toString('base64') } });
    content.push({ type: 'text', text: `פרט: ${zone.label}` });
  }
  content.push({ type: 'text', text: analysisPrompt });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 8000, messages: [{ role: 'user', content }] })
  });
  const data = await resp.json();
  if (data.error) throw new Error(`AI Error: ${JSON.stringify(data.error)}`);
  return data.content[0].text;
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
    version: '14.0.0-railway'
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

  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

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
      return res.status(400).json({ error: zipErr.message });
    }

    const ext = path.extname(originalName).toLowerCase();
    const isDXF = ext === '.dxf';

    // ===== DXF FILES: Use vector rendering + Claude Vision =====
    if (isDXF) {
      console.log('DXF file detected - using vector render + Claude Vision');
      const sharp = require('sharp');

      // Get analysis prompt (same as DWG path)
      let analysisPrompt;
      if (req.body.customInstructions) {
        console.log('Using custom instructions from client');
        analysisPrompt = buildCustomPrompt(req.body.customInstructions, 'הנחיות מותאמות');
      } else {
        const instructionId = req.body.instructionId || 'fire-safety';
        analysisPrompt = getInstructionPrompt(instructionId);
      }

      // Step 1: Render DXF to high-res PNG (only for image, not scoring)
      const result = await analyzeDXF(filePath);

      if (!result.pngBuffer) {
        throw new Error('Failed to render DXF to image');
      }

      // Save main image
      const imageId = uuidv4();
      const mainImagePath = path.join(imagesDir, `${imageId}.png`);
      fs.writeFileSync(mainImagePath, result.pngBuffer);
      const imageUrl = `/images/${imageId}.png`;

      // Step 2: Split PNG into zones for detailed analysis (same as DWG)
      const imgMeta = await sharp(result.pngBuffer).metadata();
      const w = imgMeta.width || 4000;
      const h = imgMeta.height || 4000;

      console.log(`DXF rendered image: ${w}x${h}`);

      // Create zones - 3x3 grid like DWG path
      const zones = [];
      const zoneUrls = [];
      const zoneW = Math.floor(w / 3);
      const zoneH = Math.floor(h / 3);

      const zoneLabels = [
        ['עליון שמאלי', 'עליון אמצעי', 'עליון ימני'],
        ['אמצעי שמאלי', 'מרכז', 'אמצעי ימני'],
        ['תחתון שמאלי', 'תחתון אמצעי', 'תחתון ימני']
      ];

      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          try {
            const zoneBuffer = await sharp(result.pngBuffer)
              .extract({
                left: col * zoneW,
                top: row * zoneH,
                width: Math.min(zoneW, w - col * zoneW),
                height: Math.min(zoneH, h - row * zoneH)
              })
              .sharpen({ sigma: 1.0 })
              .png()
              .toBuffer();

            const zonePath = path.join(imagesDir, `${imageId}_zone${zones.length}.png`);
            fs.writeFileSync(zonePath, zoneBuffer);

            zones.push({ buffer: zoneBuffer, label: zoneLabels[row][col] });
            zoneUrls.push({ url: `/images/${imageId}_zone${zones.length - 1}.png`, label: zoneLabels[row][col] });
          } catch (e) {
            console.log(`Failed to extract DXF zone ${row},${col}:`, e.message);
          }
        }
      }

      console.log(`Created ${zones.length} zones for Claude analysis`);

      // Step 3: Send all images to Claude Vision (same as DWG path)
      const imageBuffers = { fullImage: result.pngBuffer, zones };
      const rawAnalysis = await analyzeWithAI(imageBuffers, analysisPrompt);

      // Parse Claude's response
      let analysis;
      try {
        const jsonMatch = rawAnalysis.match(/```json\n?([\s\S]*?)\n?```/) || rawAnalysis.match(/\{[\s\S]*"categories"[\s\S]*\}/);
        analysis = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawAnalysis);
      } catch (e) {
        analysis = { rawText: rawAnalysis, parseError: true };
      }

      // Cleanup
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      if (extractedFilePath) try { fs.unlinkSync(extractedFilePath); } catch(e) {}

      return res.json({
        success: true,
        filename: originalName,
        analysis,
        analysisMethod: 'vision',
        vectorData: result.vectorData, // Keep vector stats as supplementary data
        imageUrl,
        zoneUrls,
        sourceType: 'vector-dxf-vision',
        sourceDimensions: `${result.parsed.entityCount} entities`,
        outputDimensions: `${w}x${h}`,
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }

    // ===== DWG FILES: Use APS + Claude Vision pipeline =====
    console.log('DWG file detected - using APS + Claude Vision');

    // Get analysis prompt
    let analysisPrompt;
    if (req.body.customInstructions) {
      console.log('Using custom instructions from client');
      analysisPrompt = buildCustomPrompt(req.body.customInstructions, 'הנחיות מותאמות');
    } else {
      const instructionId = req.body.instructionId || 'fire-safety';
      analysisPrompt = getInstructionPrompt(instructionId);
    }

    const token = await getAPSToken();
    const bucketKey = await ensureBucket(token);
    const urn = await uploadToAPS(token, bucketKey, filePath, originalName);
    await translateToSVF2(token, urn);
    await waitForTranslation(token, urn);

    const images = await getHighResolutionImages(token, urn);

    // Save images locally
    const imageId = uuidv4();
    const mainImagePath = path.join(imagesDir, `${imageId}.png`);
    fs.writeFileSync(mainImagePath, images.fullImage);
    const imageUrl = `/images/${imageId}.png`;

    const zoneUrls = [];
    for (let i = 0; i < images.zones.length; i++) {
      const zonePath = path.join(imagesDir, `${imageId}_zone${i}.png`);
      fs.writeFileSync(zonePath, images.zones[i].buffer);
      zoneUrls.push({ url: `/images/${imageId}_zone${i}.png`, label: images.zones[i].label });
    }

    const rawAnalysis = await analyzeWithAI(images, analysisPrompt);

    let analysis;
    try {
      const jsonMatch = rawAnalysis.match(/```json\n?([\s\S]*?)\n?```/) || rawAnalysis.match(/\{[\s\S]*"categories"[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawAnalysis);
    } catch (e) { analysis = { rawText: rawAnalysis, parseError: true }; }

    // Cleanup
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    if (extractedFilePath) try { fs.unlinkSync(extractedFilePath); } catch(e) {}

    res.json({
      success: true,
      filename: originalName,
      analysis,
      analysisMethod: 'vision',
      imageUrl,
      zoneUrls,
      sourceType: images.sourceType,
      sourceDimensions: images.sourceDimensions,
      outputDimensions: images.outputDimensions,
      processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
    });
  } catch (e) {
    console.error('Analysis error:', e);
    if (req.file?.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch(err) {}
    if (extractedFilePath && fs.existsSync(extractedFilePath)) try { fs.unlinkSync(extractedFilePath); } catch(err) {}
    res.status(500).json({ error: e.message });
  }
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/images')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Fire Safety Checker running on port ${PORT}`);
  console.log(`   APS: ${APS_CLIENT_ID ? '✅' : '❌'}`);
  console.log(`   Claude: ${ANTHROPIC_API_KEY ? '✅' : '❌'}`);
  console.log(`   Version: 14.0.0-railway`);
});
