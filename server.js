/**
 * Fire Safety Checker - Railway Server v21
 * DXF: Pure text analysis + RAW DIAGNOSTICS
 * DWG: PDF pipeline with extended timeouts for large files
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

// ===== NEW PDF-BASED DWG PIPELINE =====

const { execSync } = require('child_process');

// Request PDF derivative from APS
async function requestPDFDerivative(token, urn) {
  console.log('Requesting PDF derivative from APS...');
  const resp = await fetch(
    'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-ads-force': 'true'
      },
      body: JSON.stringify({
        input: { urn },
        output: {
          formats: [{ type: 'pdf' }]
        }
      })
    }
  );
  const data = await resp.json();
  console.log('PDF derivative request:', data.result || data.status || 'submitted');
  return data;
}

// Wait for PDF derivative and get its URN
async function waitForPDFDerivative(token, urn, maxWait = 300000) {
  console.log('Waiting for PDF derivative...');
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const manifest = await resp.json();

    // Log all available derivatives for debugging
    console.log('Available derivatives:', JSON.stringify(manifest.derivatives?.map(d => ({
      outputType: d.outputType,
      status: d.status,
      children: d.children?.slice(0, 5).map(c => ({ role: c.role, mime: c.mime, urn: c.urn?.substring(0, 50) }))
    })), null, 2));

    // Look for PDF in derivatives
    for (const deriv of manifest.derivatives || []) {
      if (deriv.outputType === 'pdf' && deriv.status === 'success') {
        // Find the PDF file in children
        const pdfChild = deriv.children?.find(c => c.mime === 'application/pdf' || c.role === 'pdf');
        if (pdfChild?.urn) {
          console.log('PDF derivative ready:', pdfChild.urn.substring(0, 50));
          return pdfChild.urn;
        }
      }
    }

    // Check if still processing
    const pdfDeriv = manifest.derivatives?.find(d => d.outputType === 'pdf');
    if (pdfDeriv) {
      console.log(`PDF status: ${pdfDeriv.status} (${pdfDeriv.progress || 'unknown'}%)`);
      if (pdfDeriv.status === 'failed') {
        console.log('PDF derivative failed, falling back to image pipeline');
        return null;
      }
    }

    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('PDF derivative timeout, falling back to image pipeline');
  return null;
}

// Download a derivative from APS
async function downloadDerivative(token, urn, derivativeUrn) {
  const encodedUrn = encodeURIComponent(derivativeUrn);
  const resp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/derivatives/${encodedUrn}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error(`Failed to download derivative: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// Convert PDF to high-res PNGs using pdftoppm
async function convertPDFToPNGs(pdfPath, outputDir) {
  const outputPrefix = path.join(outputDir, 'page');
  console.log(`Converting PDF to PNG at 300 DPI...`);

  try {
    // pdftoppm creates page-1.png, page-2.png, etc.
    execSync(`pdftoppm -png -r 300 "${pdfPath}" "${outputPrefix}"`, {
      timeout: 180000,
      maxBuffer: 100 * 1024 * 1024
    });

    // Find all generated PNG files
    const files = fs.readdirSync(outputDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort();

    console.log(`Generated ${files.length} PNG pages`);
    return files.map(f => path.join(outputDir, f));
  } catch (e) {
    console.error('PDF conversion error:', e.message);
    throw new Error('Failed to convert PDF to PNG');
  }
}

// Split a PNG into zones
async function splitIntoZones(pngPath, cols = 3, rows = 2) {
  const sharp = require('sharp');
  const fullBuffer = fs.readFileSync(pngPath);
  const metadata = await sharp(fullBuffer).metadata();

  console.log(`  Page size: ${metadata.width}x${metadata.height}`);

  const zoneW = Math.floor(metadata.width / cols);
  const zoneH = Math.floor(metadata.height / rows);
  const zones = [];

  const zoneLabels = [
    ['עליון שמאלי', 'עליון אמצעי', 'עליון ימני'],
    ['תחתון שמאלי', 'תחתון אמצעי', 'תחתון ימני']
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = c * zoneW;
      const top = r * zoneH;
      const width = Math.min(zoneW, metadata.width - left);
      const height = Math.min(zoneH, metadata.height - top);

      const zoneBuffer = await sharp(fullBuffer)
        .extract({ left, top, width, height })
        .resize(4000, 4000, { fit: 'inside', withoutEnlargement: true })
        .sharpen({ sigma: 1.0 })
        .png()
        .toBuffer();

      zones.push({
        buffer: zoneBuffer,
        label: zoneLabels[r]?.[c] || `אזור ${r * cols + c + 1}`
      });
    }
  }

  // Also create a resized full page for overview
  const fullResized = await sharp(fullBuffer)
    .resize(4000, 4000, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  return { fullPage: fullResized, zones, dimensions: `${metadata.width}x${metadata.height}` };
}

// Main function: Get high-res images via PDF pipeline
async function getHighResolutionImages(token, urn) {
  const sharp = require('sharp');

  // Step 1: Request PDF derivative
  await requestPDFDerivative(token, urn);

  // Step 2: Wait for PDF derivative
  const pdfUrn = await waitForPDFDerivative(token, urn);

  if (pdfUrn) {
    // Step 3: Download PDF
    console.log('Downloading PDF derivative...');
    const pdfBuffer = await downloadDerivative(token, urn, pdfUrn);
    console.log(`Downloaded PDF: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Step 4: Save PDF to temp file
    const pdfId = uuidv4();
    const pdfDir = path.join(tmpDir, `pdf_${pdfId}`);
    fs.mkdirSync(pdfDir, { recursive: true });
    const pdfPath = path.join(pdfDir, 'drawing.pdf');
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Step 5: Convert PDF to PNGs
    const pngPaths = await convertPDFToPNGs(pdfPath, pdfDir);

    if (pngPaths.length === 0) {
      throw new Error('No PNG pages generated from PDF');
    }

    // Step 6: Process first page (or all pages for multi-page)
    // For now, process just the first page
    console.log(`Processing page 1 of ${pngPaths.length}...`);
    const { fullPage, zones, dimensions } = await splitIntoZones(pngPaths[0]);

    // Cleanup temp files
    try {
      fs.rmSync(pdfDir, { recursive: true, force: true });
    } catch (e) {
      console.log('Cleanup warning:', e.message);
    }

    return {
      fullImage: fullPage,
      zones,
      sourceType: 'pdf-derivative',
      sourceDimensions: dimensions,
      outputDimensions: '4000x4000 (max)',
      pageCount: pngPaths.length
    };
  }

  // FALLBACK: Use thumbnail/image derivatives if PDF not available
  console.log('PDF not available, falling back to image derivatives...');

  const manifestResp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const manifest = await manifestResp.json();

  const derivatives = manifest.derivatives || [];
  const allImages = [];

  function findImages(children, parentName = '') {
    for (const child of children || []) {
      const name = child.name || parentName;
      if (child.urn && (child.mime?.startsWith('image/') || child.role === 'graphics' || child.role === 'thumbnail')) {
        allImages.push({ urn: child.urn, name: name || 'Image', mime: child.mime, role: child.role });
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

  // Try thumbnail as last resort
  if (!bestImage) {
    const resp = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/thumbnail?width=400&height=400`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (resp.ok) {
      bestImage = { buffer: Buffer.from(await resp.arrayBuffer()), name: 'thumbnail' };
    }
  }

  if (!bestImage) {
    throw new Error('No images available from APS');
  }

  // Process the fallback image
  const sourceMeta = await sharp(bestImage.buffer).metadata();
  console.log(`Fallback image: ${sourceMeta.width}x${sourceMeta.height}`);

  const fullImage = await sharp(bestImage.buffer)
    .resize(4000, 4000, { fit: 'inside', withoutEnlargement: true })
    .sharpen({ sigma: 1.5 })
    .png()
    .toBuffer();

  // Split into 3x3 grid
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

  return {
    fullImage,
    zones,
    sourceType: 'image-fallback',
    sourceDimensions: `${sourceMeta.width}x${sourceMeta.height}`,
    outputDimensions: `${imgMeta.width}x${imgMeta.height}`
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
    version: '21.0.0-railway'
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

    clearTimeout(timeoutId);
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
  console.log(`   Version: 21.0.0-railway`);
  console.log(`   Timeouts: 25min server, 20min analysis, 15min translation`);
});

// Extended timeouts for large DWG processing (32MB+ files)
server.timeout = 25 * 60 * 1000;        // 25 minutes
server.keepAliveTimeout = 25 * 60 * 1000;
server.headersTimeout = 26 * 60 * 1000;
