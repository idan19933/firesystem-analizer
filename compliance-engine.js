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

const EXTRACTION_PROMPT = `You are an Israeli building permit compliance expert.

Read this regulatory document and extract EVERY requirement, condition, and rule mentioned.

For EACH requirement, you MUST classify its verification_method as one of:

1. "ai_plan_check" — Can be verified by looking at architectural drawings/plans.
   Examples: fire doors exist, staircase width, number of exits, sprinkler layout,
   setback distances, room dimensions, window placement, parking spaces shown.

2. "ai_document_check" — Can be verified by reading a specific uploaded document.
   Examples: structural engineer approval letter, fire authority sign-off,
   environmental impact report, insurance certificate.
   → Also specify "required_document" with the document name.

3. "human_verify" — Requires physical inspection, payment confirmation,
   or subjective judgment that can't be done from documents alone.
   Examples: fee payment, physical site inspection, neighbor consent obtained,
   construction quality check, actual measurements on site.

4. "measurement" — Requires specific numeric measurements from plans that
   AI can attempt but a human should verify.
   Examples: building height ≤ 9m, setback from road ≥ 5m,
   apartment area ≥ 80sqm, parking spot dimensions.

5. "external_approval" — Requires a signed approval from an external authority.
   Examples: כב"א approval, ועדה מקומית approval, IEC electrical approval,
   water authority approval, municipality engineer sign-off.
   → Also specify "approving_authority" with who needs to sign.

Return as JSON:
{
  "project_info": {
    "location": "...",
    "plot": "...",
    "plan_number": "...",
    "applicant": "..."
  },
  "requirements": [
    {
      "id": "REQ-001",
      "category": "קליטת בקשה | בקרת תכן | טופס 2 | טופס 4 | כב\\"א | תב\\"ע | כללי",
      "title_he": "Short title in Hebrew",
      "description_he": "Full requirement description in Hebrew",
      "verification_method": "ai_plan_check | ai_document_check | human_verify | measurement | external_approval",
      "required_document": "Document name if ai_document_check or external_approval",
      "approving_authority": "Authority name if external_approval",
      "plan_elements_to_check": ["list", "of", "things to look for in plans"],
      "numeric_threshold": { "metric": "...", "operator": ">=", "value": 5, "unit": "m" },
      "regulation_reference": "תקן 1220 / הנ\\"כ 536 / תב\\"ע 513 / etc.",
      "severity": "critical | major | minor",
      "stage": "pre_permit | design_review | form2 | form4 | ongoing"
    }
  ],
  "summary": {
    "total_requirements": 0,
    "by_verification_method": {
      "ai_plan_check": 0,
      "ai_document_check": 0,
      "human_verify": 0,
      "measurement": 0,
      "external_approval": 0
    }
  }
}

IMPORTANT RULES:
- Hebrew text must be in Hebrew, not transliterated
- Every requirement needs a clear, actionable description
- If a requirement has a numeric threshold, ALWAYS include it in numeric_threshold
- "ai_plan_check" should ONLY be used for things actually visible in architectural drawings
- When in doubt between "ai_plan_check" and "human_verify", choose "human_verify"
- Group related requirements under the same category
- Include the specific regulation/standard reference when mentioned in the document`;

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

  async _callClaude(messages, maxTokens = 8000) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        temperature: 0,
        messages
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Claude API error: ${resp.status} - ${err}`);
    }

    const data = await resp.json();
    return data.content[0].text;
  }

  _parseJSON(text) {
    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('No valid JSON found in response');
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

    // Send to Claude for extraction
    console.log('🤖 Extracting & categorizing requirements...');
    const responseText = await this._callClaude([{
      role: 'user',
      content: `${EXTRACTION_PROMPT}\n\n=== תוכן המסמכים ===\n${allText}`
    }]);

    const parsed = this._parseJSON(responseText);

    // Normalize requirement IDs (sort by category + regulation ref for determinism)
    const reqs = (parsed.requirements || []);
    reqs.sort((a, b) => {
      const catA = a.category || '';
      const catB = b.category || '';
      if (catA !== catB) return catA.localeCompare(catB, 'he');
      return (a.regulation_reference || '').localeCompare(b.regulation_reference || '', 'he');
    });

    // Re-assign sequential IDs
    reqs.forEach((req, i) => {
      req.id = `REQ-${String(i + 1).padStart(3, '0')}`;
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

  // ===== PHASE 2: CHECK PLANS (ai_plan_check + measurement items only) =====

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

    // Build requirements JSON for prompt
    const reqsForPrompt = planCheckable.map(r => ({
      id: r.id,
      title: r.title_he,
      description: r.description_he,
      verification_method: r.verification_method,
      plan_elements_to_check: r.plan_elements_to_check || [],
      numeric_threshold: r.numeric_threshold || null
    }));

    const prompt = PLAN_CHECK_PROMPT.replace('{REQUIREMENTS}', JSON.stringify(reqsForPrompt, null, 2));

    // Build image content for Claude
    const imageContents = [];
    for (const buf of planImageBuffers) {
      if (!buf || buf.length < 100) continue;
      const base64 = buf.toString('base64');
      const mediaType = 'image/png';
      imageContents.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 }
      });
    }

    if (imageContents.length === 0) {
      throw new Error('No valid plan images provided');
    }

    const responseText = await this._callClaude([{
      role: 'user',
      content: [...imageContents, { type: 'text', text: prompt }]
    }]);

    const parsed = this._parseJSON(responseText);
    const results = parsed.results || [];

    // Apply results to requirements
    for (const result of results) {
      const req = project.requirements.find(r => r.id === result.requirement_id);
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

    this._persist(projectId);

    return {
      projectId,
      checkedCount: results.length,
      results,
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
