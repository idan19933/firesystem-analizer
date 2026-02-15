/**
 * Fire Safety Checker - Server v33
 * Pure local processing - NO APS dependency
 * DWG: Convert to DXF using libredwg (dwg2dxf)
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

// ===== CONVERT DWG TO DXF USING LIBREDWG =====
function convertDWGtoDXF(dwgPath) {
  const dxfPath = dwgPath.replace(/\.dwg$/i, '.dxf');

  console.log('🔄 Converting DWG to DXF using libredwg...');
  console.log(`   Input: ${dwgPath}`);
  console.log(`   Output: ${dxfPath}`);

  try {
    // dwg2dxf outputs to same directory with .dxf extension
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
    console.log(`⚠️ dwg2dxf error: ${err.message}`);
  }

  // Try alternative: dwgread
  try {
    console.log('   Trying dwgread as fallback...');
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
    console.log(`⚠️ dwgread error: ${err2.message}`);
  }

  throw new Error('Failed to convert DWG to DXF. libredwg may not be installed or the DWG file is corrupted.');
}

// ===== EXTRACT DWF (ZIP-based format) =====
function extractDWF(dwfPath) {
  console.log('📦 Extracting DWF file (ZIP-based format)...');

  const zip = new AdmZip(dwfPath);
  const entries = zip.getEntries();

  console.log(`   Found ${entries.length} entries in DWF:`);

  let extractedData = {
    manifest: null,
    sections: [],
    graphics: [],
    texts: []
  };

  entries.forEach(entry => {
    const name = entry.entryName;
    const size = entry.header.size;
    console.log(`   - ${name} (${size} bytes)`);

    // Look for manifest.xml
    if (name.toLowerCase().includes('manifest') && name.endsWith('.xml')) {
      extractedData.manifest = entry.getData().toString('utf8');
    }

    // Look for section XML files
    if (name.endsWith('.xml') && !name.includes('manifest')) {
      try {
        const content = entry.getData().toString('utf8');
        extractedData.sections.push({ name, content });

        // Extract text content from XML
        const textMatches = content.match(/<Text[^>]*>([^<]+)<\/Text>/gi) || [];
        textMatches.forEach(match => {
          const text = match.replace(/<[^>]+>/g, '').trim();
          if (text.length > 0) extractedData.texts.push(text);
        });
      } catch (e) {}
    }

    // Track graphics files (w2d, f2d)
    if (name.match(/\.(w2d|f2d)$/i)) {
      extractedData.graphics.push({ name, size });
    }
  });

  console.log(`✅ Extracted: ${extractedData.sections.length} sections, ${extractedData.texts.length} texts, ${extractedData.graphics.length} graphics`);

  return extractedData;
}

// ===== BUILD DWF REPORT TEXT =====
function buildDWFReportText(dwfData) {
  let report = `=== נתוני קובץ DWF ===

מבנה הקובץ:
- קבצי גרפיקה: ${dwfData.graphics.length}
- סקשנים: ${dwfData.sections.length}
- טקסטים שזוהו: ${dwfData.texts.length}

=== טקסטים שנמצאו ===
${dwfData.texts.slice(0, 100).join('\n')}

=== קבצי גרפיקה ===
${dwfData.graphics.map(g => `- ${g.name} (${(g.size / 1024).toFixed(1)} KB)`).join('\n')}
`;

  // Try to identify fire safety elements from texts
  const fireSafety = {
    sprinklers: 0,
    smokeDetectors: 0,
    exits: 0,
    fireDoors: 0,
    extinguishers: 0,
    hydrants: 0
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

  report += `
=== מערכות בטיחות אש שזוהו ===
- ספרינקלרים: ${fireSafety.sprinklers}
- גלאי עשן: ${fireSafety.smokeDetectors}
- יציאות חירום: ${fireSafety.exits}
- דלתות אש: ${fireSafety.fireDoors}
- מטפי כיבוי: ${fireSafety.extinguishers}
- הידרנטים: ${fireSafety.hydrants}
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
  // Check if libredwg is available
  let libredwg = false;
  try {
    execSync('dwg2dxf --version 2>&1 || true', { timeout: 5000 });
    libredwg = true;
  } catch (e) {}

  res.json({
    status: 'ok',
    version: '33.0.0',
    libredwg: libredwg ? 'installed' : 'not installed',
    claude: ANTHROPIC_API_KEY ? 'configured' : 'not configured',
    mode: 'Local processing (no APS)'
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
      content = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return XLSX.utils.sheet_to_csv(sheet);
      }).join('\n\n');
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
    console.log('🔥 FIRE SAFETY ANALYSIS v33 (Local)');
    console.log(`📁 ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log('========================================\n');

    tempFiles.push(req.file.path);

    // Extract from ZIP if needed
    let { filePath, originalName } = extractFromZip(req.file.path, req.file.originalname);
    if (filePath !== req.file.path) tempFiles.push(filePath);

    let ext = path.extname(originalName).toLowerCase();
    let reportText, analysisData;

    // ===== DWG: Convert to DXF first =====
    if (ext === '.dwg') {
      console.log('📐 DWG detected - converting to DXF with libredwg');
      const dxfPath = convertDWGtoDXF(filePath);
      tempFiles.push(dxfPath);
      filePath = dxfPath;
      ext = '.dxf';
    }

    // ===== DXF: Direct parsing =====
    if (ext === '.dxf') {
      console.log('📐 Parsing DXF with vector analyzer...');
      const analysis = await analyzeDXFComplete(filePath);
      reportText = analysis.reportText;
      analysisData = {
        method: 'DXF Vector Parsing (Local)',
        entities: analysis.parsed.totalEntities,
        layers: Object.keys(analysis.tree.layers).length,
        texts: analysis.parsed.texts.length,
        fireSafety: analysis.reportData.fireSafety
      };
    }

    // ===== DWF: Extract ZIP and parse =====
    else if (ext === '.dwf') {
      console.log('📦 DWF detected - extracting embedded data...');
      const dwfData = extractDWF(filePath);
      const dwfReport = buildDWFReportText(dwfData);
      reportText = dwfReport.report;
      analysisData = {
        method: 'DWF Extraction (Local)',
        graphics: dwfData.graphics.length,
        sections: dwfData.sections.length,
        texts: dwfData.texts.length,
        fireSafety: dwfReport.fireSafety
      };
    }

    else {
      throw new Error('Unsupported file format. Use DWG, DXF, or DWF.');
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
  // Check libredwg availability
  let libredwgStatus = 'not installed';
  try {
    execSync('which dwg2dxf || where dwg2dxf 2>&1', { timeout: 5000 });
    libredwgStatus = 'installed';
  } catch (e) {}

  console.log('\n========================================');
  console.log('🔥 FIRE SAFETY CHECKER v33');
  console.log('========================================');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📐 DXF: Direct vector parsing`);
  console.log(`🔄 DWG: libredwg conversion (${libredwgStatus})`);
  console.log(`📦 DWF: ZIP extraction`);
  console.log(`🤖 Claude: ${ANTHROPIC_API_KEY ? 'ready' : 'not configured'}`);
  console.log('========================================');
  console.log('✅ NO APS DEPENDENCY - Pure local processing');
  console.log('========================================\n');
});

server.timeout = 900000; // 15 minutes
server.keepAliveTimeout = 600000; // 10 minutes
