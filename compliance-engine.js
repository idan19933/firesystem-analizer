/**
 * compliance-engine.js — Generic Compliance Checker with Smart Categorization
 *
 * Extracts requirements from reference docs, categorizes by verification method,
 * then only sends plan-checkable items to Claude Vision. Everything else becomes
 * a human-verified checklist.
 */

const fs = require('fs');
const path = require('path');

// Document parsing (optional, loaded if available)
let pdfParse, mammoth, XLSX;
try { pdfParse = require('pdf-parse'); } catch (e) {}
try { mammoth = require('mammoth'); } catch (e) {}
try { XLSX = require('xlsx'); } catch (e) {}

// ===== PROMPTS =====

const EXTRACTION_PROMPT = `Extract every check item from this Israeli building permit compliance document.

For EACH item return this COMPACT JSON (use short field names to save space):
{
  "id": "1.1",
  "cat": "Section/category name",
  "title": "Short title in Hebrew",
  "desc": "Requirement text in Hebrew (max 100 chars)",
  "method": "plan | doc | human | measure | approval",
  "ref": "Regulation reference if mentioned",
  "severity": "critical | major | minor",
  "doc_needed": "Document name (only if method=doc or approval)",
  "authority": "Authority name (only if method=approval)",
  "threshold": "e.g. >=5m or <=9m (only if method=measure)"
}

METHOD KEY:
- "plan" = visible in architectural drawings (walls, doors, stairs, symbols, rooms, exits)
- "measure" = needs specific measurements from plans (areas, widths, heights, distances)
- "human" = needs physical inspection, payment, or subjective judgment
- "doc" = needs a separate uploaded document (certificate, letter, report)
- "approval" = needs signed approval from external authority (כב"א, עירייה, IEC etc.)

RULES:
- Extract ALL items from ALL sections — do NOT skip any
- Hebrew text in Hebrew, not transliterated
- Use SHORT field names as shown above
- Keep desc under 100 characters
- Omit optional fields (doc_needed, authority, threshold) when not applicable
- "plan" = ONLY for things actually visible in architectural drawings
- When in doubt between "plan" and "human", choose "human"
- Return ONLY valid JSON: {"requirements": [...], "project_info": {...}}
- No markdown, no code blocks, no explanation outside JSON`;

const PLAN_CHECK_PROMPT = `You are checking architectural plans for an Israeli building permit.

You are ONLY checking these specific items (all are things that should be visible in the plans):

REQUIREMENTS TO CHECK:
{REQUIREMENTS}

For each requirement, analyze the plan image and report:
{
  "results": [
    {
      "requirement_id": "REQ-001",
      "status": "pass | fail | partial | unclear",
      "confidence": 0.0-1.0,
      "finding_he": "What you found in Hebrew",
      "evidence": "Describe what you see in the plan that supports your finding",
      "location_in_plan": "Where in the plan you found this",
      "measured_value": "If measurement type — the value you measured/estimated",
      "recommendation_he": "What needs to change if fail/partial (Hebrew)"
    }
  ]
}

RULES:
- ONLY check items in the list above. Do not invent additional checks.
- If you can't see something clearly, set status to "unclear" with confidence < 0.5
- For measurements, give your best estimate but flag confidence
- Be specific about WHERE in the plan you see things
- Hebrew architectural terms:
  חדר מדרגות = stairwell, יציאת חירום = emergency exit,
  דלת אש = fire door, מתזים = sprinklers, גלאי עשן = smoke detector,
  קיר הפרדה = separation wall, תאורת חירום = emergency lighting

Return ONLY valid JSON.`;

const DOCUMENT_CHECK_PROMPT = `You are an Israeli building permit compliance expert.
Read this document and determine if it satisfies this requirement:

REQUIREMENT:
{REQUIREMENT}

Analyze the document and determine:
1. Is this the correct type of document for this requirement?
2. Does it contain the required information/approval?
3. Is it properly signed/stamped if required?

Return JSON:
{
  "status": "pass | fail | partial",
  "confidence": 0.0-1.0,
  "finding_he": "What you found in the document (Hebrew)",
  "details": "Specific details about what was found or missing"
}

Return ONLY valid JSON.`;

class ComplianceEngine {
  constructor(anthropicApiKey) {
    this.apiKey = anthropicApiKey;
    this.projects = new Map();
    this.storageDir = path.join(require('os').tmpdir(), 'compliance-projects');
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });

    // Load persisted projects
    this._loadPersistedProjects();
  }

  // ===== PERSISTENCE =====

  _loadPersistedProjects() {
    try {
      const files = fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(this.storageDir, file), 'utf8'));
        // Skip projects older than 24h
        if (Date.now() - data.createdAt > 24 * 60 * 60 * 1000) {
          fs.unlinkSync(path.join(this.storageDir, file));
          continue;
        }
        this.projects.set(data.id, data);
      }
      console.log(`📋 Loaded ${this.projects.size} compliance projects from disk`);
    } catch (e) {
      // Fine if no persisted data
    }
  }

  _persist(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;
    const filePath = path.join(this.storageDir, `${projectId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(project, null, 2));
  }

  // ===== PROJECT MANAGEMENT =====

  createProject() {
    const id = `proj_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const project = {
      id,
      requirements: [],
      projectInfo: null,
      documents: [],
      results: {},
      createdAt: Date.now()
    };
    this.projects.set(id, project);
    this._persist(id);
    return id;
  }

  getProject(projectId) {
    return this.projects.get(projectId) || null;
  }

  // ===== CLAUDE API HELPER =====

  async _callClaude(messages, maxTokens = 8000, { systemPrompt = null, returnMeta = false } = {}) {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      temperature: 0,
      messages
    };
    if (systemPrompt) body.system = systemPrompt;

    const RETRYABLE = [429, 500, 502, 503, 529];
    const maxRetries = 3;
    const baseDelay = 5000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });

      if (resp.ok) {
        const data = await resp.json();
        const text = data.content[0].text;
        const stopReason = data.stop_reason;

        if (stopReason === 'max_tokens') {
          console.warn(`⚠️ Response TRUNCATED (hit ${maxTokens} max_tokens) — JSON may be incomplete`);
        }
        console.log(`📊 Response: ${text.length} chars, stop_reason: ${stopReason}`);

        if (returnMeta) return { text, stopReason };
        return text;
      }

      const errText = await resp.text();
      const isRetryable = RETRYABLE.includes(resp.status) ||
        errText.includes('overloaded') || errText.includes('Overloaded');

      if (isRetryable && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`⚠️ Claude API ${resp.status} — retry ${attempt}/${maxRetries} in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw new Error(`Claude API error: ${resp.status} - ${errText}`);
    }
  }

  _parseJSON(text) {
    if (!text || text.trim().length === 0) {
      throw new Error('Empty response from Claude');
    }

    // Strategy 1: Direct JSON parse
    try {
      const result = JSON.parse(text);
      if (result.requirements && result.requirements.length > 0) {
        console.log(`✅ JSON Strategy 1 (direct): ${result.requirements.length} requirements`);
        return result;
      }
      if (typeof result === 'object') return result;
    } catch (e) { /* try next */ }

    // Strategy 2: Extract from markdown code block
    try {
      const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        const result = JSON.parse(codeBlockMatch[1]);
        if (result.requirements && result.requirements.length > 0) {
          console.log(`✅ JSON Strategy 2 (code block): ${result.requirements.length} requirements`);
          return result;
        }
        if (typeof result === 'object') return result;
      }
    } catch (e) { /* try next */ }

    // Strategy 3: Balanced brace extraction — find the outermost { }
    try {
      const startIdx = text.indexOf('{');
      if (startIdx >= 0) {
        let depth = 0;
        let inStr = false, esc = false;
        let endIdx = -1;
        for (let i = startIdx; i < text.length; i++) {
          const ch = text[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{') depth++;
          if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
        }
        if (endIdx > startIdx) {
          const result = JSON.parse(text.substring(startIdx, endIdx + 1));
          if (result.requirements && result.requirements.length > 0) {
            console.log(`✅ JSON Strategy 3 (balanced): ${result.requirements.length} requirements`);
            return result;
          }
          if (typeof result === 'object') return result;
        }
      }
    } catch (e) { /* try next */ }

    // Strategy 4: Truncation recovery — salvage complete requirement objects
    try {
      console.log('⚠️ Trying truncation recovery (Strategy 4)...');
      const reqIdx = text.indexOf('"requirements"');
      if (reqIdx >= 0) {
        const arrStart = text.indexOf('[', reqIdx);
        if (arrStart >= 0) {
          // Walk through and find all complete objects
          let depth = 0, inStr = false, esc = false;
          let lastCompleteObj = -1;
          for (let i = arrStart + 1; i < text.length; i++) {
            const ch = text[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            if (ch === '}') { depth--; if (depth === 0) lastCompleteObj = i; }
            if (ch === ']' && depth === 0) { lastCompleteObj = i; break; }
          }

          if (lastCompleteObj > arrStart) {
            let arrayStr = text.substring(arrStart, lastCompleteObj + 1);
            if (!arrayStr.trim().endsWith(']')) {
              const lastBrace = arrayStr.lastIndexOf('}');
              if (lastBrace > 0) arrayStr = arrayStr.substring(0, lastBrace + 1) + ']';
            }
            const requirements = JSON.parse(arrayStr);
            if (Array.isArray(requirements) && requirements.length > 0) {
              console.log(`✅ JSON Strategy 4 (truncation recovery): ${requirements.length} requirements`);
              return { requirements, _truncated: true };
            }
          }
        }
      }
    } catch (e) {
      console.error('Strategy 4 failed:', e.message);
    }

    // Strategy 5: Greedy regex with repair (last resort)
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let jsonStr = jsonMatch[0];
        // Count unclosed braces/brackets
        let braces = 0, brackets = 0, inStr = false, esc = false;
        for (let i = 0; i < jsonStr.length; i++) {
          const ch = jsonStr[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{') braces++; else if (ch === '}') braces--;
          if (ch === '[') brackets++; else if (ch === ']') brackets--;
        }
        if (braces > 0 || brackets > 0) {
          const lastComma = jsonStr.lastIndexOf(',');
          if (lastComma > jsonStr.length * 0.5) jsonStr = jsonStr.substring(0, lastComma);
          jsonStr += ']'.repeat(Math.max(0, brackets)) + '}'.repeat(Math.max(0, braces));
        }
        const result = JSON.parse(jsonStr);
        console.log(`✅ JSON Strategy 5 (greedy+repair): ${(result.requirements || []).length} requirements`);
        return result;
      }
    } catch (e) { /* give up */ }

    // ALL STRATEGIES FAILED
    console.error('❌ All 5 JSON parsing strategies failed');
    console.error('First 500 chars:', text.substring(0, 500));
    console.error('Last 300 chars:', text.substring(text.length - 300));
    throw new Error('All JSON parsing strategies failed');
  }

  // ===== PHASE 1: EXTRACT & CATEGORIZE REQUIREMENTS =====

  async extractTextFromFile(filePath, filename) {
    const ext = path.extname(filename).toLowerCase();
    let content = '';

    if (ext === '.pdf' && pdfParse) {
      const pdfData = await pdfParse(fs.readFileSync(filePath));
      content = pdfData.text;
    } else if ((ext === '.docx' || ext === '.doc') && mammoth) {
      const result = await mammoth.extractRawText({ path: filePath });
      content = result.value;
    } else if ((ext === '.xlsx' || ext === '.xls') && XLSX) {
      const workbook = XLSX.readFile(filePath);
      content = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return XLSX.utils.sheet_to_txt(sheet);
      }).join('\n');
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }

    return content;
  }

  async processReferenceDoc(projectId, files) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    // Extract text from all files with per-document budget
    const MAX_CHARS = 100000;
    const docTexts = [];

    for (const file of files) {
      try {
        const content = await this.extractTextFromFile(file.path, file.originalname);
        docTexts.push({ name: file.originalname, content });
        console.log(`   ✓ ${file.originalname}: ${content.length} chars`);
      } catch (e) {
        console.log(`   ✗ ${file.originalname}: ${e.message}`);
      }
    }

    if (docTexts.length === 0) throw new Error('לא ניתן היה לחלץ טקסט מהקבצים');

    // Per-document budget
    const perDocBudget = Math.floor(MAX_CHARS / docTexts.length);
    let allText = '';
    for (const doc of docTexts) {
      const trimmed = doc.content.length > perDocBudget
        ? doc.content.substring(0, perDocBudget) + '\n[...קוצר...]'
        : doc.content;
      allText += `\n\n=== ${doc.name} ===\n${trimmed}`;
    }

    console.log(`📄 Total: ${allText.length} chars (budget: ${perDocBudget}/doc)`);

    // Single-pass extraction with truncation detection
    console.log('🤖 Extracting & categorizing requirements...');
    const { text: responseText, stopReason } = await this._callClaude([{
      role: 'user',
      content: `${EXTRACTION_PROMPT}\n\n=== תוכן המסמכים ===\n${allText}`
    }], 16000, {
      systemPrompt: 'You are a JSON extraction engine. Output ONLY valid JSON. Never output markdown, explanations, or text outside of JSON.',
      returnMeta: true
    });

    let parsed = this._parseJSON(responseText);
    let reqs = parsed.requirements || [];

    // Normalize compact field names → standard names
    reqs = reqs.map(r => ({
      category: r.cat || r.category || 'כללי',
      title_he: r.title || r.title_he || '',
      description_he: r.desc || r.description_he || r.title || '',
      verification_method: this._normalizeMethod(r.method || r.verification_method),
      required_document: r.doc_needed || r.required_document || null,
      approving_authority: r.authority || r.approving_authority || null,
      regulation_reference: r.ref || r.regulation_reference || '',
      severity: r.severity || 'major',
      numeric_threshold: r.threshold || r.numeric_threshold || null,
      plan_elements_to_check: r.plan_elements_to_check || [],
      _originalId: r.id || ''
    }));

    console.log(`📋 Single-pass extracted: ${reqs.length} requirements`);

    // If truncated or too few items, try section-by-section fallback
    if ((stopReason === 'max_tokens' || reqs.length < 80 || parsed._truncated) && allText.length > 5000) {
      console.log(`⚠️ Single-pass got ${reqs.length} items (truncated: ${stopReason === 'max_tokens'}). Trying section-by-section...`);
      try {
        const sectionReqs = await this._extractBySection(allText);
        if (sectionReqs.length > reqs.length) {
          console.log(`✅ Section-by-section got ${sectionReqs.length} items (vs ${reqs.length}). Using section results.`);
          reqs = sectionReqs;
        }
      } catch (e) {
        console.log(`⚠️ Section-by-section failed: ${e.message}. Using single-pass results.`);
      }
    }

    // Validate extraction
    this._validateExtraction(reqs);

    // Sort by category + original id for determinism
    reqs.sort((a, b) => {
      const catA = a.category || '';
      const catB = b.category || '';
      if (catA !== catB) return catA.localeCompare(catB, 'he');
      return (a._originalId || '').localeCompare(b._originalId || '');
    });

    // Re-assign sequential IDs
    reqs.forEach((req, i) => {
      req.id = `REQ-${String(i + 1).padStart(3, '0')}`;
      delete req._originalId;
      // Initialize result fields
      req.ai_result = null;
      req.human_result = null;
      req.document = { uploaded: false, filename: null, ai_verification: null };
      req.final_status = null;
    });

    project.requirements = reqs;
    project.projectInfo = parsed.project_info || null;
    project.documents = docTexts.map(d => d.name);

    this._persist(projectId);

    return {
      projectId,
      projectInfo: project.projectInfo,
      requirements: project.requirements,
      totalRequirements: reqs.length,
      summary: this.getSummary(projectId)
    };
  }

  // Normalize short method names to standard names
  _normalizeMethod(method) {
    const map = {
      'plan': 'ai_plan_check',
      'doc': 'ai_document_check',
      'human': 'human_verify',
      'measure': 'measurement',
      'approval': 'external_approval'
    };
    return map[method] || method || 'human_verify';
  }

  // Section-by-section extraction for large documents
  async _extractBySection(allText) {
    // Step 1: Identify sections
    console.log('   📋 Identifying sections...');
    const sectionListText = await this._callClaude([{
      role: 'user',
      content: `Read this document and list ONLY the section numbers and names.
Return a JSON array: [{"num": 1, "name": "Section name", "items": 10}, ...]
Return ONLY valid JSON array, nothing else.

DOCUMENT:
${allText.substring(0, 30000)}`
    }], 2000, { systemPrompt: 'Output ONLY valid JSON. No markdown.' });

    let sections;
    try {
      const arrMatch = sectionListText.match(/\[[\s\S]*\]/);
      sections = arrMatch ? JSON.parse(arrMatch[0]) : [];
    } catch (e) {
      console.log(`   ⚠️ Section identification failed: ${e.message}`);
      return [];
    }

    if (sections.length === 0) return [];
    console.log(`   📋 Found ${sections.length} sections`);

    // Step 2: Extract requirements section by section
    const allReqs = [];
    for (const section of sections) {
      console.log(`   → Section ${section.num}: ${section.name}...`);
      try {
        const sectionText = await this._callClaude([{
          role: 'user',
          content: `Extract ALL requirements from SECTION ${section.num} ("${section.name}") of this checklist.

For each item return COMPACT JSON:
{"id":"${section.num}.X","cat":"${section.name}","title":"Short title","desc":"Requirement (Hebrew, max 100 chars)","method":"plan|doc|human|measure|approval","ref":"Regulation ref","severity":"critical|major|minor"}

Omit optional fields when not applicable.
Return ONLY a JSON array: [...]

DOCUMENT:
${allText}`
        }], 4000, { systemPrompt: 'Output ONLY valid JSON array. No markdown.' });

        let sectionReqs;
        try {
          const arrMatch = sectionText.match(/\[[\s\S]*\]/);
          sectionReqs = arrMatch ? JSON.parse(arrMatch[0]) : [];
        } catch (e) {
          // Try repair
          const parsed = this._parseJSON(`{"requirements": ${sectionText}}`);
          sectionReqs = parsed.requirements || [];
        }

        if (Array.isArray(sectionReqs)) {
          // Normalize fields
          const normalized = sectionReqs.map(r => ({
            category: r.cat || r.category || section.name,
            title_he: r.title || r.title_he || '',
            description_he: r.desc || r.description_he || r.title || '',
            verification_method: this._normalizeMethod(r.method || r.verification_method),
            required_document: r.doc_needed || r.required_document || null,
            approving_authority: r.authority || r.approving_authority || null,
            regulation_reference: r.ref || r.regulation_reference || '',
            severity: r.severity || 'major',
            numeric_threshold: r.threshold || r.numeric_threshold || null,
            plan_elements_to_check: r.plan_elements_to_check || [],
            _originalId: r.id || `${section.num}.${sectionReqs.indexOf(r) + 1}`
          }));
          allReqs.push(...normalized);
          console.log(`     ✅ ${normalized.length} requirements`);
        }
      } catch (e) {
        console.error(`     ❌ Section ${section.num} failed: ${e.message}`);
      }
    }

    return allReqs;
  }

  // Validate extraction results
  _validateExtraction(reqs) {
    if (reqs.length === 0) {
      console.error('❌ ZERO requirements extracted — this is a bug');
      return;
    }

    if (reqs.length < 50) {
      console.warn(`⚠️ Only ${reqs.length} requirements — may be incomplete (expected ~130 for full checklist)`);
    } else {
      console.log(`✅ Extracted ${reqs.length} requirements`);
    }

    // Check method distribution
    const methods = {};
    reqs.forEach(r => {
      const m = r.verification_method || 'unknown';
      methods[m] = (methods[m] || 0) + 1;
    });
    console.log('📊 By verification method:', JSON.stringify(methods));

    // Check categories covered
    const categories = [...new Set(reqs.map(r => r.category))];
    console.log(`📊 Categories (${categories.length}): ${categories.join(', ')}`);
  }

  // ===== PHASE 2: CHECK PLANS (ai_plan_check + measurement items only) =====
  // Batched: splits requirements into groups of ~15, processes 2 concurrently

  async checkPlansAgainstRequirements(projectId, planImageBuffers) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    // Filter only plan-checkable items
    const planCheckable = project.requirements.filter(
      r => r.verification_method === 'ai_plan_check' || r.verification_method === 'measurement'
    );

    if (planCheckable.length === 0) {
      return { message: 'אין דרישות שניתן לבדוק מתכניות', results: [] };
    }

    console.log(`🔍 Checking ${planCheckable.length} requirements against plans...`);

    // Prepare image content objects (overview = first, rest = zones)
    const imageContents = [];
    for (const buf of planImageBuffers) {
      if (!buf || buf.length < 500) continue;
      imageContents.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') }
      });
    }

    if (imageContents.length === 0) {
      throw new Error('No valid plan images provided');
    }

    // The first image is the overview; the rest are zone detail images
    const overviewImage = imageContents[0];
    const zoneImages = imageContents.slice(1);

    // Split requirements into batches of 15
    const BATCH_SIZE = 15;
    const batches = [];
    for (let i = 0; i < planCheckable.length; i += BATCH_SIZE) {
      batches.push(planCheckable.slice(i, i + BATCH_SIZE));
    }

    console.log(`📦 Split into ${batches.length} batches of ~${BATCH_SIZE} requirements`);

    // Process batches — 2 concurrently
    const CONCURRENT = 2;
    const allResults = [];

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx += CONCURRENT) {
      const currentBatches = batches.slice(batchIdx, batchIdx + CONCURRENT);

      const batchPromises = currentBatches.map(async (batch, offset) => {
        const batchNum = batchIdx + offset + 1;
        console.log(`  📋 Batch ${batchNum}/${batches.length}: ${batch.length} requirements (${batch[0].id} - ${batch[batch.length - 1].id})`);

        // Build image set: overview + up to 2 zone images (rotate through zones)
        const batchImages = [overviewImage];
        if (zoneImages.length > 0) {
          const zoneOffset = (batchNum - 1) % Math.max(zoneImages.length, 1);
          for (let z = 0; z < Math.min(2, zoneImages.length); z++) {
            const zi = (zoneOffset + z) % zoneImages.length;
            batchImages.push(zoneImages[zi]);
          }
        }

        // Build compact requirements list for prompt
        const reqList = batch.map(r => ({
          id: r.id,
          title: r.title_he,
          desc: r.description_he,
          method: r.verification_method,
          look_for: r.plan_elements_to_check || [],
          threshold: r.numeric_threshold || null
        }));

        const prompt = `You are checking architectural plans for Israeli building permit compliance.

CHECK THESE ${batch.length} REQUIREMENTS against the plan images:

${JSON.stringify(reqList, null, 1)}

For EACH requirement, analyze what you see in the plans and return:
{
  "results": [
    {
      "requirement_id": "REQ-XXX",
      "status": "pass" | "fail" | "partial" | "unclear",
      "confidence": 0.0-1.0,
      "finding_he": "ממצא בעברית",
      "evidence": "What you see in the plan",
      "location_in_plan": "Where in the plan",
      "measured_value": "If measurement — estimated value",
      "recommendation_he": "המלצה אם נכשל (עברית)"
    }
  ]
}

RULES:
- You MUST return a result for ALL ${batch.length} requirements listed above
- "pass" = clearly met, "fail" = clearly NOT met, "partial" = partially met, "unclear" = cannot determine (confidence < 0.5)
- For measurements: estimate if possible, note confidence
- Be specific about WHERE in the plan you see evidence
- Hebrew terms: חדר מדרגות=stairwell, יציאת חירום=emergency exit, דלת אש=fire door, מתזים=sprinklers, גלאי עשן=smoke detector
- Return ONLY valid JSON`;

        try {
          const responseText = await this._callClaude([{
            role: 'user',
            content: [...batchImages, { type: 'text', text: prompt }]
          }], 4096);

          const parsed = this._parseJSON(responseText);
          const results = parsed?.results || (Array.isArray(parsed) ? parsed : []);

          if (Array.isArray(results) && results.length > 0) {
            console.log(`  ✅ Batch ${batchNum}: ${results.length} results`);
            return results;
          }
          console.log(`  ⚠️ Batch ${batchNum}: unexpected format, got ${typeof parsed}`);
          return [];
        } catch (err) {
          console.error(`  ❌ Batch ${batchNum} failed: ${err.message}`);
          // Return "unclear" for all items in this failed batch
          return batch.map(r => ({
            requirement_id: r.id,
            status: 'unclear',
            confidence: 0,
            finding_he: 'שגיאה בבדיקת AI',
            evidence: `API error: ${err.message}`,
            location_in_plan: '',
            recommendation_he: ''
          }));
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const results of batchResults) {
        allResults.push(...results);
      }

      // Small delay between concurrent groups to avoid rate limits
      if (batchIdx + CONCURRENT < batches.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log(`📊 Total results: ${allResults.length}/${planCheckable.length}`);

    // Apply results to requirements
    for (const result of allResults) {
      const reqId = result.requirement_id || result.id;
      const req = project.requirements.find(r => r.id === reqId);
      if (req) {
        req.ai_result = {
          status: result.status,
          confidence: result.confidence,
          finding_he: result.finding_he,
          evidence: result.evidence,
          location_in_plan: result.location_in_plan,
          measured_value: result.measured_value || null,
          recommendation_he: result.recommendation_he || null
        };
        // Set final_status from AI (human can override later)
        if (!req.human_result) {
          req.final_status = result.status;
        }
      }
    }

    // Count statuses
    const counts = { pass: 0, fail: 0, partial: 0, unclear: 0 };
    for (const r of allResults) {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
    console.log(`✅ Plan check complete: ${JSON.stringify(counts)}`);
    console.log(`   Checked: ${allResults.length}/${planCheckable.length} plan-checkable items`);

    this._persist(projectId);

    return {
      projectId,
      checkedCount: allResults.length,
      totalCheckable: planCheckable.length,
      counts,
      results: allResults,
      summary: this.getSummary(projectId)
    };
  }

  // ===== PHASE 3: CHECK UPLOADED DOCUMENT =====

  async checkDocument(projectId, requirementId, fileBuffer, filename) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    const req = project.requirements.find(r => r.id === requirementId);
    if (!req) throw new Error('Requirement not found');

    // Extract text from document
    let docText = '';
    const ext = path.extname(filename).toLowerCase();

    if (ext === '.pdf' && pdfParse) {
      const pdfData = await pdfParse(fileBuffer);
      docText = pdfData.text;
    } else {
      docText = fileBuffer.toString('utf8');
    }

    const reqDescription = JSON.stringify({
      id: req.id,
      title: req.title_he,
      description: req.description_he,
      required_document: req.required_document,
      approving_authority: req.approving_authority
    }, null, 2);

    const prompt = DOCUMENT_CHECK_PROMPT
      .replace('{REQUIREMENT}', reqDescription);

    // If it's a PDF, send as text; for images we could send as vision
    const responseText = await this._callClaude([{
      role: 'user',
      content: `${prompt}\n\n=== תוכן המסמך ===\n${docText.substring(0, 50000)}`
    }], 2000);

    const parsed = this._parseJSON(responseText);

    // Update requirement
    req.document = {
      uploaded: true,
      filename,
      uploadedAt: Date.now(),
      ai_verification: {
        status: parsed.status,
        confidence: parsed.confidence,
        finding_he: parsed.finding_he,
        details: parsed.details
      }
    };

    if (!req.human_result) {
      req.final_status = parsed.status;
    }

    this._persist(projectId);

    return {
      requirementId,
      verification: req.document.ai_verification,
      summary: this.getSummary(projectId)
    };
  }

  // ===== HUMAN VERIFICATION =====

  markAsVerified(projectId, requirementId, status, verifiedBy, notes) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    const req = project.requirements.find(r => r.id === requirementId);
    if (!req) throw new Error('Requirement not found');

    req.human_result = {
      status,
      verified_by: verifiedBy || '',
      verified_at: Date.now(),
      notes: notes || ''
    };

    // Human override always takes precedence
    req.final_status = status;

    this._persist(projectId);
    return { success: true };
  }

  // ===== CHECKLIST =====

  getChecklist(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    return {
      projectId,
      projectInfo: project.projectInfo,
      requirements: project.requirements,
      summary: this.getSummary(projectId)
    };
  }

  // ===== SUMMARY DASHBOARD =====

  getSummary(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return null;

    const reqs = project.requirements;
    const total = reqs.length;
    if (total === 0) return { total: 0 };

    let checked = 0, passed = 0, failed = 0, partial = 0, unclear = 0, pending = 0;

    const byMethod = {};
    const byCategory = {};

    for (const req of reqs) {
      const method = req.verification_method || 'unknown';
      const cat = req.category || 'כללי';

      if (!byMethod[method]) byMethod[method] = { total: 0, done: 0, passed: 0, failed: 0 };
      if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0, failed: 0 };

      byMethod[method].total++;
      byCategory[cat].total++;

      const status = req.final_status;
      if (status) {
        checked++;
        byMethod[method].done++;
        if (status === 'pass') { passed++; byMethod[method].passed++; byCategory[cat].passed++; }
        else if (status === 'fail') { failed++; byMethod[method].failed++; byCategory[cat].failed++; }
        else if (status === 'partial') { partial++; }
        else if (status === 'unclear') { unclear++; }
      } else {
        pending++;
      }
    }

    return {
      total,
      checked,
      pending,
      passed,
      failed,
      partial,
      unclear,
      by_method: byMethod,
      by_category: byCategory,
      compliance_score: checked > 0 ? Math.round((passed / checked) * 100) : 0,
      overall_score: total > 0 ? Math.round((passed / total) * 100) : 0
    };
  }
}

module.exports = ComplianceEngine;
