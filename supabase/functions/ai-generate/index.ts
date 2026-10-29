// ai-generate — structured AI drafting with Claude (server-side only).
//
// Tasks:
//   document_draft       full draft or one section of a controlled document
//   hazard_suggestions   hazards and controls for a risk assessment (no scores)
//   checklist_questions  questions for an inspection checklist
//   investigation_support questions to ask and possible factors (unverified)
//   report_summary       executive summary of report statistics
//
// Safety rules enforced here, not left to the model:
//   * the caller must be an admin, OHS manager or safety officer, the plan
//     must include AI, and the monthly allowance must not be used up
//     (ai_begin_job in the database)
//   * output must match a JSON schema (forced tool call); missing sections
//     are reported, never silently filled
//   * legal references are only marked verified if they match the verified
//     legal register; everything else is flagged "needs verification"
//   * risk scores are never requested from or accepted from the model
//   * only work context is sent: no names, ID numbers or medical details
//
// Secrets: ANTHROPIC_API_KEY (+ automatic SUPABASE_*). Deploy WITH JWT verification.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const API = Deno.env.get('ANTHROPIC_API_URL') ?? 'https://api.anthropic.com/v1/messages';
const KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Section schemas for controlled documents (mirrors app/js/views/documents.js)
const SOP: [string, string][] = [
  ['purpose', 'Purpose'], ['scope', 'Scope'], ['responsibilities', 'Responsible persons'],
  ['competencies', 'Required competencies and authorisations'], ['ppe', 'Required PPE'], ['equipment', 'Equipment and materials'],
  ['prerequisites', 'Prerequisites'], ['hazards', 'Identified hazards'], ['precautions', 'Safety precautions'],
  ['steps', 'Step-by-step work instructions'], ['critical_controls', 'Critical control measures'],
  ['emergency', 'Emergency response procedures'], ['records', 'Required records'],
];
const SCHEMAS: Record<string, [string, string][]> = {
  sop: SOP, safe_work_procedure: SOP,
  method_statement: [['scope', 'Scope of work'], ['sequence', 'Sequence of work'], ['resources', 'Resources, plant and equipment'],
    ['hazards', 'Hazards and controls'], ['responsibilities', 'Responsibilities'], ['competencies', 'Competencies required'], ['emergency', 'Emergency arrangements']],
  toolbox_talk: [['topic', 'Topic and purpose'], ['key_points', 'Key points'], ['discussion', 'Discussion questions'], ['actions', 'Actions agreed']],
  safety_alert: [['what_happened', 'What happened'], ['why_it_matters', 'Why it matters'], ['actions_required', 'Actions required'], ['contact', 'Who to contact']],
  emergency_plan: [['purpose', 'Purpose'], ['scope', 'Scope'], ['contacts', 'Emergency contacts'], ['roles', 'Roles and responsibilities'],
    ['alarm', 'Raising the alarm'], ['evacuation', 'Evacuation procedure'], ['assembly', 'Assembly points'], ['scenarios', 'Specific emergency scenarios'], ['drills', 'Drills and testing']],
  policy: [['purpose', 'Purpose'], ['scope', 'Scope'], ['statement', 'Policy statement'], ['responsibilities', 'Responsibilities'], ['review', 'Monitoring and review']],
};
const GENERIC: [string, string][] = [['purpose', 'Purpose'], ['scope', 'Scope'], ['content', 'Content']];
const LEVELS = ['elimination', 'substitution', 'engineering', 'administrative', 'ppe'];

const SYSTEM = `You help competent occupational health and safety (OHS) practitioners in South Africa draft safety documentation.
Rules you must follow:
- Write in South African English, plainly, for people doing the work.
- You produce a FIRST DRAFT for review and approval by a competent person. Never state or imply that the output is legally compliant.
- Do not invent legislation, regulation numbers, standards, section numbers or statutory deadlines. Put any legal reference you believe is relevant ONLY in the legal_references list, never in the body text, and give the reason. If unsure, leave it out.
- Never assign risk ratings, scores, likelihoods or severities. The organisation's own risk matrix does that.
- Follow the hierarchy of controls: elimination, substitution, engineering controls, administrative controls, PPE.
- Where information you need was not provided, do not guess specifics such as names, phone numbers, quantities or equipment models. Use a clear placeholder in square brackets, e.g. [Site emergency number], and list it under missing_information.
- List anything you are unsure about under uncertainties.
- Do not include personal information about individuals.`;

const strList = { type: 'array', items: { type: 'string' } };
const refs = { type: 'array', items: { type: 'object', properties: { reference: { type: 'string' }, reason: { type: 'string' } }, required: ['reference', 'reason'] } };

function toolFor(task: string, docType: string, section?: string) {
  if (task === 'document_draft') {
    const schema = (SCHEMAS[docType] ?? GENERIC).filter(([k]) => !section || k === section);
    return { name: 'submit_draft', description: 'Return the drafted document sections.', input_schema: { type: 'object',
      properties: { sections: { type: 'object', properties: Object.fromEntries(schema.map(([k, l]) => [k, { type: 'string', description: l }])), required: schema.map(([k]) => k) },
        missing_information: strList, uncertainties: strList, legal_references: refs },
      required: ['sections', 'missing_information', 'uncertainties', 'legal_references'] } };
  }
  if (task === 'hazard_suggestions') return { name: 'submit_hazards', description: 'Return suggested hazards and controls (no ratings).', input_schema: { type: 'object',
    properties: { hazards: { type: 'array', items: { type: 'object', properties: {
      hazard_category: { type: 'string' }, hazard: { type: 'string' }, persons_exposed: { type: 'string' }, consequences: { type: 'string' },
      typical_existing_controls: { type: 'string' }, additional_controls: { type: 'string' }, control_levels: { type: 'array', items: { type: 'string', enum: LEVELS } } },
      required: ['hazard', 'consequences', 'additional_controls', 'control_levels'] } }, missing_information: strList, uncertainties: strList, legal_references: refs },
    required: ['hazards', 'missing_information', 'uncertainties', 'legal_references'] } };
  if (task === 'checklist_questions') return { name: 'submit_checklist', description: 'Return inspection checklist sections and questions.', input_schema: { type: 'object',
    properties: { sections: { type: 'array', items: { type: 'object', properties: { section: { type: 'string' }, questions: { type: 'array', items: { type: 'object',
      properties: { question: { type: 'string', description: 'Phrased so that "compliant" means safe' }, guidance: { type: 'string' } }, required: ['question'] } } }, required: ['section', 'questions'] } },
      missing_information: strList, uncertainties: strList, legal_references: refs }, required: ['sections', 'missing_information', 'uncertainties', 'legal_references'] } };
  if (task === 'investigation_support') return { name: 'submit_support', description: 'Return investigation questions and POSSIBLE factors to explore.', input_schema: { type: 'object',
    properties: { questions: strList, possible_factors: { type: 'array', items: { type: 'object', properties: { factor: { type: 'string' },
      type: { type: 'string', enum: ['immediate_cause', 'underlying_cause', 'contributing_factor'] } }, required: ['factor', 'type'] } },
      evidence_to_collect: strList, uncertainties: strList }, required: ['questions', 'possible_factors', 'evidence_to_collect', 'uncertainties'] } };
  if (task === 'report_summary') return { name: 'submit_summary', description: 'Return an executive summary of the statistics provided.', input_schema: { type: 'object',
    properties: { summary: { type: 'string', description: 'Three to five short paragraphs' }, notable_points: strList, caveats: strList },
    required: ['summary', 'notable_points', 'caveats'] } };
  return null;
}

const DOC_FOR_TASK: Record<string, string> = { hazard_suggestions: 'risk_assessment', checklist_questions: 'inspection_checklist',
  investigation_support: 'incident_report', report_summary: 'ohs_report' };

function prompt(task: string, ctx: Record<string, unknown>, inputs: Record<string, unknown>, docType: string, section?: string) {
  const company = `Organisation context: industry ${ctx.industry ?? 'not stated'}; province ${ctx.province ?? 'not stated'}${ctx.site ? `; site "${ctx.site}"` : ''}.`;
  const given = Object.entries(inputs).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  if (task === 'document_draft') {
    const labels = SCHEMAS[docType] ?? GENERIC;
    const which = section ? `Rewrite ONLY the section "${labels.find(([k]) => k === section)?.[1]}". Keep it consistent with the other sections provided.` : 'Draft every section.';
    return `${company}\nDocument type: ${docType.replace(/_/g, ' ')}.\n${which}\nFor work instructions, put each step on its own numbered line.\nInformation provided by the user:\n${given || '- (none)'}`;
  }
  if (task === 'hazard_suggestions') return `${company}\nSuggest the significant hazards for this work, with persons exposed, credible consequences, typical existing controls to check for, and additional controls following the hierarchy of controls. Do not rate them.\nInformation provided:\n${given}`;
  if (task === 'checklist_questions') return `${company}\nCreate an inspection checklist grouped into sections. Each question must be phrased so that answering "compliant" means the condition is safe. Keep questions observable during a walk-through.\nInformation provided:\n${given}`;
  if (task === 'investigation_support') return `${company}\nAn incident is being investigated. Suggest questions the investigator should ask, evidence to collect, and POSSIBLE immediate causes, underlying causes and contributing factors to explore. These are prompts, not conclusions.\nIncident information:\n${given}`;
  return `${company}\nWrite an executive summary for a management OHS report from these figures only. Do not invent numbers, do not infer causes from correlations, and mention when numbers are too small to show a trend.\nFigures (JSON):\n${JSON.stringify(inputs.stats)}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const LEGAL_PATTERN = /\b(Act\s+\d+\s+of\s+\d{4}|Regulation\s+\d+|Section\s+\d+\(?\d*\)?|SANS\s*\d+|OHS Act|Mine Health and Safety Act|General Safety Regulations|Construction Regulations)\b/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json(401, { error: 'Sign in again to use AI drafting.' });

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json(400, { error: 'The request could not be read.' }); }
  const task = String(body.task ?? '');
  const orgId = String(body.org_id ?? '');
  const docType = task === 'document_draft' ? String(body.doc_type ?? '') : DOC_FOR_TASK[task];
  const section = body.section_key ? String(body.section_key) : undefined;
  const inputs: Record<string, unknown> = typeof body.inputs === 'object' && body.inputs ? body.inputs : {};
  const tool = docType ? toolFor(task, docType, section) : null;
  if (!tool) return json(400, { error: 'Unknown AI task.' });
  if (section && !(SCHEMAS[docType] ?? GENERIC).some(([k]) => k === section)) return json(400, { error: 'Unknown section.' });
  if (JSON.stringify(inputs).length > 20000) return json(413, { error: 'Too much text. Shorten the details and try again.' });
  if (!KEY) return json(503, { error: 'AI drafting is not configured yet. Ask your administrator to add the AI provider key.' });

  // Role, plan, monthly allowance and rate limit are checked in the database.
  const { data: jobId, error: beginErr } = await admin.rpc('ai_begin_job', { p_user: user.id, p_org: orgId, p_task: task,
    p_doc_type: docType, p_section: section ?? null, p_inputs: inputs });
  if (beginErr) return json(beginErr.code === '42501' ? 403 : 429, { error: beginErr.message });

  const [{ data: org }, { data: setting }] = await Promise.all([
    admin.from('organisations').select('industry, province').eq('id', orgId).single(),
    admin.from('platform_settings').select('value').eq('key', 'ai').maybeSingle(),
  ]);
  let site: string | null = null;
  if (inputs.site_id) {
    const { data: s } = await admin.from('sites').select('name, org_id').eq('id', String(inputs.site_id)).maybeSingle();
    if (s?.org_id === orgId) site = s.name;
    delete inputs.site_id;
  }
  const model = String(setting?.value?.model ?? 'claude-sonnet-5-5');
  const finish = (ok: boolean, out: unknown, validation: unknown, refsOut: unknown, inTok = 0, outTok = 0, err: string | null = null) =>
    admin.rpc('ai_finish_job', { p_job: jobId, p_ok: ok, p_output: out, p_validation: validation, p_refs: refsOut,
      p_provider: 'anthropic', p_model: model, p_in: inTok, p_out: outTok, p_error: err })
      .then(({ error }) => { if (error) console.error('ai_finish_job failed', error.message); });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110_000);
  let res: Response;
  try {
    res = await fetch(API, { method: 'POST', signal: ctrl.signal, headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: task === 'document_draft' && !section ? 6000 : 3000, system: SYSTEM,
        tools: [tool], tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: prompt(task, { industry: org?.industry, province: org?.province, site }, inputs, docType, section) }] }) });
  } catch (e) {
    clearTimeout(timer);
    await finish(false, null, null, null, 0, 0, String(e));
    return json(504, { error: 'The AI service took too long to respond. Try again.' });
  }
  clearTimeout(timer);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    await finish(false, null, null, null, 0, 0, `${res.status}: ${data?.error?.message ?? 'error'}`);
    return json(502, { error: 'The AI service could not complete the request. Try again shortly.' });
  }
  const out = (data.content ?? []).find((c: any) => c.type === 'tool_use')?.input;
  const usage = data.usage ?? {};
  if (!out) {
    await finish(false, null, null, null, usage.input_tokens, usage.output_tokens, 'No structured output');
    return json(502, { error: 'The AI response was incomplete. Try again.' });
  }

  // ---- validation ----
  const validation: Record<string, unknown> = { missing_information: out.missing_information ?? [], uncertainties: out.uncertainties ?? [] };
  if (task === 'document_draft') {
    const expected = (SCHEMAS[docType] ?? GENERIC).filter(([k]) => !section || k === section);
    const sections: Record<string, string> = {};
    for (const [k] of expected) if (typeof out.sections?.[k] === 'string') sections[k] = out.sections[k].trim();
    out.sections = sections;
    validation.missing_sections = expected.filter(([k]) => !sections[k]).map(([, l]) => l);
    validation.legal_mentions_in_text = expected.filter(([k]) => LEGAL_PATTERN.test(sections[k] ?? '')).map(([, l]) => l);
  }
  if (task === 'hazard_suggestions') {
    out.hazards = (out.hazards ?? []).slice(0, 25).map((h: any) => ({ ...h, control_levels: (h.control_levels ?? []).filter((l: string) => LEVELS.includes(l)),
      initial_likelihood: undefined, initial_severity: undefined }));
  }
  if (task === 'investigation_support') validation.note = 'Possible factors are prompts to explore, not established causes.';

  // Legal references: verified only if they match the verified legal register.
  let refsOut: any[] = [];
  if (Array.isArray(out.legal_references) && out.legal_references.length) {
    const { data: lib } = await admin.from('legal_requirements').select('id, reference, framework_id')
      .eq('verification_status', 'verified').or(`org_id.is.null,org_id.eq.${orgId}`);
    const { data: fw } = await admin.from('legal_frameworks').select('id, title, code');
    const titles = new Map((fw ?? []).map((f: any) => [f.id, norm(f.title ?? '')]));
    // Whole-word match: "Section 8" must not match "Section 80".
    const has = (hay: string, needle: string) => !!needle && ` ${hay} `.includes(` ${needle} `);
    refsOut = out.legal_references.slice(0, 20).map((r: any) => {
      const n = norm(String(r.reference ?? ''));
      const hit = (lib ?? []).find((l: any) => { const t = titles.get(l.framework_id) ?? ''; return !!n && !!t && has(n, t) && has(n, norm(l.reference)); });
      return { reference: String(r.reference ?? ''), reason: String(r.reason ?? ''), verified: !!hit, legal_requirement_id: hit?.id ?? null };
    });
  }
  out.legal_references = refsOut;
  await finish(true, out, validation, refsOut, usage.input_tokens, usage.output_tokens);
  return json(200, { job_id: jobId, output: out, validation, model });
});
