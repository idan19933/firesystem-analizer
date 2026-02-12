const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const Busboy = require('busboy');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// DXF Vector Analyzer
const { analyzeDXF } = require('./dxf-analyzer');

/**
 * If the uploaded file is a ZIP, extract the first DWG/DXF/DWF file from it.
 * Handles nested folders inside the ZIP.
 * Returns { filePath, originalName } pointing to the extracted file.
 * If not a ZIP, returns the original file info unchanged.
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
  const extractedPath = path.join(os.tmpdir(), `extracted_${Date.now()}_${extractedFileName}`);
  fs.writeFileSync(extractedPath, cadEntry.getData());

  const sizeMB = (fs.statSync(extractedPath).size / 1024 / 1024).toFixed(1);
  console.log(`✅ Extracted: ${extractedFileName} (${sizeMB}MB) from ${cadEntry.entryName}`);
  return { filePath: extractedPath, originalName: extractedFileName };
}

// Initialize Firebase Admin
admin.initializeApp();

// Document parsing libraries
let pdfParse, mammoth, XLSX;
try { pdfParse = require('pdf-parse'); } catch (e) { console.log('pdf-parse not installed'); }
try { mammoth = require('mammoth'); } catch (e) { console.log('mammoth not installed'); }
try { XLSX = require('xlsx'); } catch (e) { console.log('xlsx not installed'); }

const app = express();
app.use(cors({ origin: true }));

// Config from environment
const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Use /tmp for Cloud Functions
const tmpDir = os.tmpdir();

// Middleware to parse multipart form data using busboy
function parseMultipart(req, res, next) {
  if (req.method !== 'POST' || !req.headers['content-type']?.includes('multipart/form-data')) {
    return next();
  }

  const busboy = Busboy({ headers: req.headers });
  req.files = {};
  req.body = {};
  const fileWrites = [];

  busboy.on('file', (fieldname, file, info) => {
    const { filename } = info;
    const filepath = path.join(tmpDir, `${uuidv4()}_${filename}`);
    const writeStream = fs.createWriteStream(filepath);

    const promise = new Promise((resolve, reject) => {
      file.on('end', () => writeStream.end());
      writeStream.on('finish', () => {
        req.files[fieldname] = { path: filepath, originalname: filename };
        resolve();
      });
      writeStream.on('error', reject);
    });

    fileWrites.push(promise);
    file.pipe(writeStream);
  });

  busboy.on('field', (fieldname, val) => {
    req.body[fieldname] = val;
  });

  busboy.on('finish', async () => {
    await Promise.all(fileWrites);
    next();
  });

  busboy.end(req.rawBody);
}

// Use Firestore for instruction storage
const db = admin.firestore();
const instructionsCollection = db.collection('instructions');

async function loadInstructions() {
  const snapshot = await instructionsCollection.get();
  const instructions = [];
  snapshot.forEach(doc => instructions.push({ id: doc.id, ...doc.data() }));
  return { instructions };
}

async function saveInstruction(instruction) {
  await instructionsCollection.doc(instruction.id).set(instruction);
}

async function deleteInstructionById(id) {
  await instructionsCollection.doc(id).delete();
}

// Parse different file types to extract text
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

// APS Authentication
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
  // Request SVF2 with all 2D views for highest quality extraction
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

  // Get the manifest to find available derivatives
  const manifestResp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const manifest = await manifestResp.json();
  console.log('Manifest status:', manifest.status);

  const derivatives = manifest.derivatives || [];
  const allImages = [];

  // Find all image derivatives in the manifest
  function findImages(children, parentName = '') {
    for (const child of children || []) {
      const name = child.name || parentName;

      // Look for any image output
      if (child.urn && (child.mime?.startsWith('image/') || child.role === 'graphics' || child.role === 'thumbnail')) {
        allImages.push({
          urn: child.urn,
          name: name || 'Image',
          mime: child.mime,
          role: child.role
        });
        console.log('Found image:', name, child.role, child.mime);
      }

      if (child.children) {
        findImages(child.children, name);
      }
    }
  }

  for (const deriv of derivatives) {
    findImages(deriv.children, deriv.name);
  }

  console.log(`Found ${allImages.length} image derivatives`);

  // Try to download the best quality derivative
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

  // Get thumbnail at maximum size as fallback/comparison
  let thumbnailBuffer = null;
  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/thumbnail?width=400&height=400`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (resp.ok) {
    thumbnailBuffer = Buffer.from(await resp.arrayBuffer());
    console.log('Got thumbnail:', thumbnailBuffer.length, 'bytes');
  }

  // Use the best available source
  let sourceBuffer;
  let sourceType;

  if (bestImage && bestImage.buffer.length > (thumbnailBuffer?.length || 0)) {
    sourceBuffer = bestImage.buffer;
    sourceType = 'derivative';
    console.log('Using derivative image');
  } else if (thumbnailBuffer) {
    sourceBuffer = thumbnailBuffer;
    sourceType = 'thumbnail';
    console.log('Using thumbnail');
  } else {
    throw new Error('No images available from APS');
  }

  // Get source dimensions
  const sourceMeta = await sharp(sourceBuffer).metadata();
  console.log(`Source image: ${sourceMeta.width}x${sourceMeta.height}`);

  // Calculate optimal output size - aim for 4000px on longest side
  const maxSize = 4000;
  const scale = Math.min(maxSize / (sourceMeta.width || 400), maxSize / (sourceMeta.height || 400), 10);
  const targetW = Math.round((sourceMeta.width || 400) * scale);
  const targetH = Math.round((sourceMeta.height || 400) * scale);

  // High quality upscaling with sharpening
  const fullImage = await sharp(sourceBuffer)
    .resize(targetW, targetH, {
      kernel: 'lanczos3',
      fit: 'inside'
    })
    .sharpen({ sigma: 1.5, m1: 1.0, m2: 0.5 })
    .png({ quality: 100, compressionLevel: 6 })
    .toBuffer();

  console.log(`Output image: ${targetW}x${targetH}`);

  // Create 9 zone crops (3x3 grid)
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
          .extract({
            left: col * zoneW,
            top: row * zoneH,
            width: Math.min(zoneW, w - col * zoneW),
            height: Math.min(zoneH, h - row * zoneH)
          })
          .sharpen({ sigma: 1.0 })
          .png()
          .toBuffer();
        zones.push({ buffer: zoneBuffer, label: zoneLabels[row][col] });
      } catch (e) {
        console.log(`Failed to extract zone ${row},${col}:`, e.message);
      }
    }
  }

  return {
    fullImage,
    zones,
    sourceType,
    sourceDimensions: `${sourceMeta.width}x${sourceMeta.height}`,
    outputDimensions: `${targetW}x${targetH}`
  };
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

async function getInstructionPrompt(instructionId) {
  if (instructionId === 'fire-safety') return FIRE_SAFETY_PROMPT;
  const doc = await instructionsCollection.doc(instructionId).get();
  if (!doc.exists) return FIRE_SAFETY_PROMPT;
  return buildCustomPrompt(doc.data().prompt, doc.data().name);
}

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

// ===== ROUTES (no /api prefix - firebase.json rewrite handles it) =====

app.get('/status', (req, res) => {
  res.json({ aps: APS_CLIENT_ID ? '✅' : '❌', claude: ANTHROPIC_API_KEY ? '✅' : '❌' });
});

app.get('/instructions', async (req, res) => {
  try { res.json(await loadInstructions()); }
  catch (e) { res.json({ instructions: [] }); }
});

app.post('/instructions', parseMultipart, async (req, res) => {
  try {
    const file = req.files?.instructionFile;
    if (!file) return res.status(400).json({ error: 'No file' });
    const prompt = await parseInstructionFile(file.path, file.originalname);
    const id = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase();
    const iconMap = { '.pdf': '📕', '.doc': '📘', '.docx': '📘', '.txt': '📄', '.xlsx': '📊', '.png': '🖼️', '.jpg': '🖼️' };
    const instruction = { id, name: req.body.name || 'Untitled', icon: iconMap[ext] || '📋', originalFileName: file.originalname, createdAt: new Date().toISOString(), prompt };
    await saveInstruction(instruction);
    fs.unlinkSync(file.path);
    res.json({ success: true, id, name: instruction.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/instructions/:id', async (req, res) => {
  try { await deleteInstructionById(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Parse instruction file and return extracted text (for client-side storage)
app.post('/parse-instruction', parseMultipart, async (req, res) => {
  try {
    const file = req.files?.instructionFile;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const content = await parseInstructionFile(file.path, file.originalname);
    fs.unlinkSync(file.path);

    if (!content || content.length < 10) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }

    res.json({ success: true, content, originalFileName: file.originalname });
  } catch (e) {
    if (req.files?.instructionFile?.path && fs.existsSync(req.files.instructionFile.path)) {
      fs.unlinkSync(req.files.instructionFile.path);
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/analyze', parseMultipart, async (req, res) => {
  const startTime = Date.now();
  let extractedFilePath = null; // Track extracted file for cleanup

  try {
    const file = req.files?.dwgFile;
    if (!file) return res.status(400).json({ error: 'No file' });

    // Extract from ZIP if needed
    let filePath = file.path;
    let originalName = file.originalname;
    try {
      const extracted = extractIfZip(filePath, originalName);
      if (extracted.filePath !== filePath) {
        extractedFilePath = extracted.filePath; // Track for cleanup
      }
      filePath = extracted.filePath;
      originalName = extracted.originalName;
    } catch (zipErr) {
      return res.status(400).json({ error: zipErr.message });
    }

    const ext = path.extname(originalName).toLowerCase();
    const isDXF = ext === '.dxf';

    // ===== DXF FILES: Use vector-based analysis (no AI needed) =====
    if (isDXF) {
      console.log('DXF file detected - using vector analysis');

      const result = await analyzeDXF(filePath);

      // Upload rendered image to Firebase Storage
      const bucket = admin.storage().bucket();
      const imageId = uuidv4();
      let imageUrl = null;

      if (result.pngBuffer) {
        const imagePath = `analyzed-plans/${imageId}.png`;
        const fileRef = bucket.file(imagePath);
        await fileRef.save(result.pngBuffer, {
          metadata: { contentType: 'image/png', metadata: { originalName: originalName, analyzedAt: new Date().toISOString(), sourceType: 'vector' } }
        });
        await fileRef.makePublic();
        imageUrl = `https://storage.googleapis.com/${bucket.name}/${imagePath}`;
      }

      // Cleanup
      try { fs.unlinkSync(file.path); } catch(e) {}
      if (extractedFilePath) {
        try { fs.unlinkSync(extractedFilePath); } catch(e) {}
      }

      return res.json({
        success: true,
        filename: originalName,
        analysis: result.analysis,
        analysisMethod: 'vector',
        vectorData: result.vectorData,
        imageUrl,
        sourceType: 'vector-dxf',
        sourceDimensions: `${result.parsed.entityCount} entities`,
        outputDimensions: '3200x auto',
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }

    // ===== DWG FILES: Use APS + Claude Vision pipeline =====
    console.log('DWG file detected - using APS + Claude Vision');

    // Get analysis prompt - either from custom instructions or preset
    let analysisPrompt;
    if (req.body.customInstructions) {
      // Custom instructions provided directly from client
      console.log('Using custom instructions from client');
      analysisPrompt = buildCustomPrompt(req.body.customInstructions, 'הנחיות מותאמות');
    } else {
      const instructionId = req.body.instructionId || 'fire-safety';
      analysisPrompt = await getInstructionPrompt(instructionId);
    }

    const token = await getAPSToken();
    const bucketKey = await ensureBucket(token);
    const urn = await uploadToAPS(token, bucketKey, filePath, originalName);
    await translateToSVF2(token, urn);
    await waitForTranslation(token, urn);

    const images = await getHighResolutionImages(token, urn);

    // Upload image to Firebase Storage
    const bucket = admin.storage().bucket();
    const imageId = uuidv4();
    const imagePath = `analyzed-plans/${imageId}.png`;
    const fileRef = bucket.file(imagePath);

    await fileRef.save(images.fullImage, {
      metadata: {
        contentType: 'image/png',
        metadata: { originalName: originalName, analyzedAt: new Date().toISOString(), sourceType: images.sourceType }
      }
    });

    // Make it publicly accessible
    await fileRef.makePublic();
    const imageUrl = `https://storage.googleapis.com/${bucket.name}/${imagePath}`;

    // Upload zone images (9 zones for 3x3 grid)
    const zoneUrls = [];
    for (let i = 0; i < images.zones.length; i++) {
      const zonePath = `analyzed-plans/${imageId}_zone${i}.png`;
      const zoneRef = bucket.file(zonePath);
      await zoneRef.save(images.zones[i].buffer, { metadata: { contentType: 'image/png' } });
      await zoneRef.makePublic();
      zoneUrls.push({
        url: `https://storage.googleapis.com/${bucket.name}/${zonePath}`,
        label: images.zones[i].label
      });
    }

    const rawAnalysis = await analyzeWithAI(images, analysisPrompt);

    let analysis;
    try {
      const jsonMatch = rawAnalysis.match(/```json\n?([\s\S]*?)\n?```/) || rawAnalysis.match(/\{[\s\S]*"categories"[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawAnalysis);
    } catch (e) { analysis = { rawText: rawAnalysis, parseError: true }; }

    // Cleanup
    try { fs.unlinkSync(file.path); } catch(e) {}
    if (extractedFilePath) {
      try { fs.unlinkSync(extractedFilePath); } catch(e) {}
    }

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
    // Cleanup on error
    if (req.files?.dwgFile?.path && fs.existsSync(req.files.dwgFile.path)) {
      try { fs.unlinkSync(req.files.dwgFile.path); } catch(err) {}
    }
    if (extractedFilePath && fs.existsSync(extractedFilePath)) {
      try { fs.unlinkSync(extractedFilePath); } catch(err) {}
    }
    res.status(500).json({ error: e.message });
  }
});

// Export
exports.api = functions.runWith({ timeoutSeconds: 540, memory: '2GB' }).https.onRequest(app);