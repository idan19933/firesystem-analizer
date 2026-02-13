/**
 * Fire Safety Checker - Server v26 (DXF ONLY)
 * Pure DXF vector analysis - NO APS, NO images
 * Export DXF from AutoCAD and upload here
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
const { analyzeDXFComplete, analyzeDXF } = require('./dxf-analyzer');

// Document parsing libraries (optional, for instruction files)
let pdfParse, mammoth, XLSX;
try { pdfParse = require('pdf-parse'); } catch (e) { console.log('pdf-parse not installed'); }
try { mammoth = require('mammoth'); } catch (e) { console.log('mammoth not installed'); }
try { XLSX = require('xlsx'); } catch (e) { console.log('xlsx not installed'); }

const app = express();
app.use(express.json());

// CORS configuration
app.use(cors({
  origin: true,
  credentials: true
}));

// Environment variables
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Use /tmp for file uploads
const tmpDir = os.tmpdir();
const uploadsDir = path.join(tmpDir, 'uploads');

// Ensure directories exist
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer configuration for file uploads
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit for large DXF files
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.dxf', '.zip'].includes(ext)) cb(null, true);
    else cb(new Error('רק קבצי DXF או ZIP מותרים. ייצא DXF מ-AutoCAD.'));
  }
});

const instructionUpload = multer({
  dest: uploadsDir,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// In-memory instruction storage
let savedInstructions = [];

// ===== FIRE SAFETY PROMPT =====
const FIRE_SAFETY_PROMPT = `אתה מומחה בטיחות אש ישראלי. נתח את נתוני תוכנית הבטיחות וצור דוח מקצועי בעברית.

הנחיות לניתוח:
1. בדוק התאמה לתקנות הבטיחות באש הישראליות
2. בדוק התאמה להוראות נציב כבאות (הנ"כ) 536, 550
3. בדוק התאמה לתקנים ישראליים: ת"י 1220 (גילוי אש), ת"י 1596 (ספרינקלרים), ת"י 1227 (דרכי מילוט)

קטגוריות לבדיקה:
1. ספרינקלרים - מרחקים (מקסימום 4.6 מ'), כיסוי, מיקום
2. גלאי עשן - מרחקים (מקסימום 7.5 מ' לגלאי נקודתי), כיסוי
3. גלאי חום - מיקום ומספר
4. מטפי כיבוי - מרחק הליכה מקסימלי (25 מ')
5. הידרנטים וברזי כיבוי - מיקום ונגישות
6. דלתות אש - רוחב מינימלי (80 ס"מ), כיוון פתיחה
7. יציאות חירום - מספר, רוחב, מרחק מילוט (מקסימום 35 מ')
8. מדרגות - רוחב, חומרי גימור, הפרדה
9. קירות אש - עמידות אש, רציפות
10. מערכות התראה - לוח בקרה, צופרים

החזר JSON בפורמט הבא:
{
  "overallScore": 0-100,
  "status": "PASS" | "FAIL" | "NEEDS_REVIEW",
  "summary": "סיכום קצר בעברית",
  "categories": [
    {
      "name": "שם הקטגוריה",
      "nameEn": "Category Name",
      "score": 0-100,
      "status": "PASS" | "FAIL" | "WARNING",
      "findings": ["ממצא 1", "ממצא 2"],
      "recommendations": ["המלצה 1", "המלצה 2"]
    }
  ],
  "criticalIssues": ["בעיה קריטית 1"],
  "positiveFindings": ["ממצא חיובי 1"],
  "detailedReport": "דוח מפורט בעברית עם כל הממצאים וההמלצות"
}`;

// ===== EXTRACT DXF FROM ZIP =====
function extractDXFFromZip(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.zip') {
    return { filePath, originalName };
  }

  console.log('📦 ZIP detected, extracting DXF...');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  // Find DXF file inside ZIP
  const dxfEntry = entries.find(entry => {
    if (entry.isDirectory) return false;
    const entryExt = path.extname(entry.entryName).toLowerCase();
    return entryExt === '.dxf';
  });

  if (!dxfEntry) {
    throw new Error('קובץ ה-ZIP לא מכיל קובץ DXF. ייצא DXF מ-AutoCAD.');
  }

  const extractedFileName = path.basename(dxfEntry.entryName);
  const extractedPath = path.join(tmpDir, `extracted_${Date.now()}_${extractedFileName}`);
  fs.writeFileSync(extractedPath, dxfEntry.getData());

  const sizeMB = (fs.statSync(extractedPath).size / 1024 / 1024).toFixed(1);
  console.log(`✅ Extracted: ${extractedFileName} (${sizeMB}MB)`);
  return { filePath: extractedPath, originalName: extractedFileName };
}

// ===== GENERATE FIRE SAFETY REPORT WITH CLAUDE =====
async function generateFireSafetyReport(reportText, customPrompt = null) {
  console.log('🤖 Generating fire safety report with Claude...');

  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const prompt = customPrompt || FIRE_SAFETY_PROMPT;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        content: `${prompt}\n\n=== נתוני התוכנית ===\n${reportText}`
      }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Claude API error:', error);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.content[0].text;

  // Parse JSON from response
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.log('Could not parse JSON, returning raw response');
  }

  return {
    overallScore: 50,
    status: 'NEEDS_REVIEW',
    summary: 'לא ניתן לנתח את התוכנית באופן מלא',
    detailedReport: content
  };
}

// ===== PARSE INSTRUCTION FILE =====
async function parseInstructionFile(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();
  let content = '';

  try {
    if (ext === '.pdf' && pdfParse) {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      content = data.text;
    } else if ((ext === '.docx' || ext === '.doc') && mammoth) {
      const result = await mammoth.extractRawText({ path: filePath });
      content = result.value;
    } else if ((ext === '.xlsx' || ext === '.xls') && XLSX) {
      const workbook = XLSX.readFile(filePath);
      const sheets = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return XLSX.utils.sheet_to_txt(sheet);
      });
      content = sheets.join('\n\n');
    } else if (ext === '.txt' || ext === '.md') {
      content = fs.readFileSync(filePath, 'utf8');
    } else {
      throw new Error(`סוג קובץ לא נתמך: ${ext}`);
    }
  } catch (e) {
    console.error('Error parsing instruction file:', e);
    throw e;
  }

  return content.trim();
}

// ===== STATIC FILES =====
app.use(express.static('public'));

// ===== API ROUTES =====

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '26.0.0-dxf-only',
    timestamp: new Date().toISOString(),
    mode: 'DXF Vector Analysis',
    message: 'ייצא DXF מ-AutoCAD והעלה כאן לניתוח'
  });
});

// Upload instruction file
app.post('/api/upload-instructions', instructionUpload.single('instructionFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'לא הועלה קובץ' });
    }

    const content = await parseInstructionFile(req.file.path, req.file.mimetype);

    const instruction = {
      id: uuidv4(),
      name: req.body.name || req.file.originalname,
      content,
      createdAt: new Date().toISOString()
    };

    savedInstructions.push(instruction);

    // Cleanup
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      instruction: {
        id: instruction.id,
        name: instruction.name,
        contentLength: content.length
      }
    });
  } catch (e) {
    console.error('Instruction upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// List saved instructions
app.get('/api/instructions', (req, res) => {
  res.json(savedInstructions.map(i => ({
    id: i.id,
    name: i.name,
    createdAt: i.createdAt
  })));
});

// Delete instruction
app.delete('/api/instructions/:id', (req, res) => {
  const idx = savedInstructions.findIndex(i => i.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'הנחיות לא נמצאו' });
  }
  savedInstructions.splice(idx, 1);
  res.json({ success: true });
});

// ===== MAIN ANALYSIS ENDPOINT =====
app.post('/api/analyze', upload.single('dwgFile'), async (req, res) => {
  const startTime = Date.now();
  let tempFiles = [];

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'לא הועלה קובץ' });
    }

    console.log('\n========================================');
    console.log('🔥 FIRE SAFETY DXF ANALYSIS v26');
    console.log(`📁 File: ${req.file.originalname}`);
    console.log(`📊 Size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
    console.log('========================================\n');

    tempFiles.push(req.file.path);

    // Extract DXF from ZIP if needed
    const { filePath, originalName } = extractDXFFromZip(req.file.path, req.file.originalname);
    if (filePath !== req.file.path) {
      tempFiles.push(filePath);
    }

    // Verify it's a DXF file
    const ext = path.extname(originalName).toLowerCase();
    if (ext !== '.dxf') {
      throw new Error('רק קבצי DXF נתמכים. ייצא DXF מ-AutoCAD.');
    }

    // Step 1: Complete DXF analysis
    console.log('\n📐 STEP 1: DXF Analysis...');
    const analysis = await analyzeDXFComplete(filePath);

    console.log('\n📊 Analysis Results:');
    console.log(`   Total entities: ${analysis.parsed.totalEntities}`);
    console.log(`   Layers: ${Object.keys(analysis.tree.layers).length}`);
    console.log(`   Texts: ${analysis.parsed.texts.length}`);
    console.log(`   Sprinklers detected: ${analysis.classified.sprinklers.length}`);
    console.log(`   Smoke detectors: ${analysis.classified.smokeDetectors.length}`);
    console.log(`   Fire doors: ${analysis.classified.fireDoors.length}`);
    console.log(`   Exits: ${analysis.classified.exits.length}`);

    // Step 2: Get custom instructions if specified
    let customPrompt = null;
    const instructionType = req.body.instructionType || 'fire-safety';
    const customInstructionId = req.body.customInstructionId;

    if (instructionType === 'custom' && customInstructionId) {
      const instruction = savedInstructions.find(i => i.id === customInstructionId);
      if (instruction) {
        customPrompt = instruction.content;
        console.log(`\n📋 Using custom instructions: ${instruction.name}`);
      }
    }

    // Step 3: Generate report with Claude
    console.log('\n🤖 STEP 2: Generating report with Claude...');
    const report = await generateFireSafetyReport(analysis.reportText, customPrompt);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Analysis complete in ${totalTime}s`);
    console.log(`   Overall score: ${report.overallScore}`);
    console.log(`   Status: ${report.status}`);

    // Cleanup temp files
    tempFiles.forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });

    res.json({
      success: true,
      fileName: originalName,
      analysisTime: totalTime,
      analysis: {
        entities: analysis.parsed.totalEntities,
        layers: Object.keys(analysis.tree.layers).length,
        texts: analysis.parsed.texts.length,
        fireSafety: analysis.reportData.fireSafety
      },
      report
    });

  } catch (error) {
    console.error('❌ Analysis error:', error);

    // Cleanup on error
    tempFiles.forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });

    res.status(500).json({
      error: error.message || 'שגיאה בניתוח הקובץ',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('🔥 FIRE SAFETY CHECKER v26 (DXF ONLY)');
  console.log('========================================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📐 Mode: Pure DXF Vector Analysis`);
  console.log(`🤖 Claude API: ${ANTHROPIC_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log('');
  console.log('📋 How to use:');
  console.log('   1. Open your plan in AutoCAD');
  console.log('   2. Turn ON all layers');
  console.log('   3. Export as DXF (SAVEAS > DXF)');
  console.log('   4. Upload the DXF here');
  console.log('========================================\n');
});

// Extended timeouts for large files
server.timeout = 600000; // 10 minutes
server.keepAliveTimeout = 300000; // 5 minutes
