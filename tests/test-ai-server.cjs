// HTTP front for the test API (used by the Deno edge function) + fake Anthropic API.
const http = require('http');
const fs = require('fs');
const { handle } = require('./test-api-shim.cjs');
const decode = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()); } catch { return {}; } };
const read = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const raw = await read(req);
  const claims = decode((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (url.pathname === '/auth/v1/user') {
    if (!claims.sub) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"invalid"}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: claims.sub, aud: 'authenticated', role: 'authenticated', email: 'x@example.co.za' }));
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const r = await handle({ method: req.method, path: url.pathname.replace('/rest/v1/', ''), search: url.search, headers: req.headers,
      body: raw ? JSON.parse(raw) : null, sub: claims.role === 'service_role' ? null : claims.sub, role: claims.role });
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) }); return res.end(r.body == null ? '' : JSON.stringify(r.body));
  }
  res.writeHead(404); res.end();
}).listen(8790);

// Fake Anthropic Messages API: deterministic structured output per tool.
http.createServer(async (req, res) => {
  let body; try { body = JSON.parse(await read(req)); } catch { res.writeHead(400); return res.end('{}'); }
  fs.appendFileSync(__dirname + '/anthropic-requests.jsonl', JSON.stringify(body) + '\n');
  if (req.headers['x-api-key'] !== 'test-key' || req.headers['anthropic-version'] !== '2023-06-01') { res.writeHead(401); return res.end('{"error":{"message":"bad key"}}'); }
  const tool = body.tools[0]; let input;
  const refs = [{ reference: 'Occupational Health and Safety Act 85 of 1993, Section 8', reason: 'General duties of employers' },
    { reference: 'Imaginary Ladder Regulation 99', reason: 'Example of an unverifiable reference' }];
  if (tool.name === 'submit_draft') {
    const keys = Object.keys(tool.input_schema.properties.sections.properties);
    const one = keys.length === 1;
    input = { sections: Object.fromEntries(keys.slice(0, one ? 1 : keys.length - 1).map((k) => [k, k === 'steps' ? (one ? 'REWRITTEN STEPS\n1. Isolate power.\n2. Inspect.' : '1. Inspect the ladder.\n2. Set up on firm ground.') : `AI text for ${k}.`])),
      missing_information: ['[Site emergency number]'], uncertainties: ['Ladder type not stated'], legal_references: refs };
  } else if (tool.name === 'submit_hazards') {
    input = { hazards: [{ hazard_category: 'Working at height', hazard: 'Fall from ladder', persons_exposed: 'Maintenance staff', consequences: 'Fractures',
      typical_existing_controls: 'Ladder inspections', additional_controls: 'Use mobile scaffold', control_levels: ['engineering', 'bogus'], initial_likelihood: 5 },
      { hazard_category: 'Electrical', hazard: 'Contact with live wiring', consequences: 'Electric shock', additional_controls: 'Isolate and lock out', control_levels: ['administrative'] }],
      missing_information: [], uncertainties: [], legal_references: [] };
  } else if (tool.name === 'submit_checklist') {
    input = { sections: [{ section: 'Access', questions: [{ question: 'Walkways are clear', guidance: 'Check aisles' }, { question: 'Stairs have handrails' }] },
      { section: 'Fire', questions: [{ question: 'Extinguishers are in place' }] }], missing_information: [], uncertainties: [], legal_references: [] };
  } else if (tool.name === 'submit_support') {
    input = { questions: ['How was the pallet loaded?', 'Were beam limits marked?'], possible_factors: [{ factor: 'Pallet overhang', type: 'immediate_cause' },
      { factor: 'No loading guidance', type: 'underlying_cause' }], evidence_to_collect: ['Photos of racking'], uncertainties: [] };
  } else if (tool.name === 'submit_summary') {
    input = { summary: 'AI SUMMARY: One near miss was reported this period.', notable_points: ['Inspection compliance was recorded'], caveats: ['Numbers are too small to show a trend'] };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'tool_use', id: 'tu_1', name: tool.name, input }], usage: { input_tokens: 500, output_tokens: 900 } }));
}).listen(8791);
console.log('servers ready');
