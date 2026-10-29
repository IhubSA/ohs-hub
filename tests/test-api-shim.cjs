// Minimal PostgREST/Supabase-compatible layer over a real Postgres, used
// only for local end-to-end testing. Every request runs as the
// 'authenticated' role with the caller's user id, so RLS, triggers and
// RPCs behave as they do on Supabase.
const pg = require('pg');
const pool = new pg.Pool({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'ohs', max: 6 });
let FKS = null;
async function fks() {
  if (FKS) return FKS;
  const { rows } = await pool.query(`select c.conname name, t.relname tbl, a.attname col, ft.relname ftbl, fa.attname fcol
    from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    join pg_class ft on ft.oid=c.confrelid join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    join pg_attribute fa on fa.attrelid=c.confrelid and fa.attnum=c.confkey[1]
    where c.contype='f' and n.nspname='public' and array_length(c.conkey,1)=1`);
  FKS = rows; return rows;
}
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw Object.assign(new Error('bad identifier ' + s), { status: 400 }); return `"${s}"`; };

// ---- select parsing ----
function splitTop(s) { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
function parseSelect(s) {
  return splitTop(s || '*').map((tok) => {
    const m = tok.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s);
    if (m) return { embed: true, alias: m[1] || m[2], table: m[2], hint: m[3], sub: parseSelect(m[4]) };
    return { col: tok };
  });
}

// ---- filters ----
function buildWhere(params, start = 1) {
  const clauses = []; const vals = []; let n = start;
  const cond = (col, opv) => {
    let neg = false; if (opv.startsWith('not.')) { neg = true; opv = opv.slice(4); }
    const i = opv.indexOf('.'); const op = opv.slice(0, i); const v = opv.slice(i + 1); const c = ident(col);
    let sql;
    if (op === 'is') sql = `${c} is ${v === 'null' ? 'null' : v === 'true' ? 'true' : 'false'}`;
    else if (op === 'in') { vals.push(v.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))); sql = `${c}::text = any($${n++}::text[])`; }
    else if (['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(op)) { vals.push(v); sql = `${c} ${{ eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[op]} $${n++}`; }
    else if (op === 'ilike' || op === 'like') { vals.push(v.replace(/\*/g, '%')); sql = `${c}::text ${op} $${n++}`; }
    else throw Object.assign(new Error('unsupported op ' + op), { status: 400 });
    return neg ? `not (${sql})` : sql;
  };
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'or') {
      const parts = splitTop(v.replace(/^\(|\)$/g, '')).map((p) => { const i = p.indexOf('.'); return cond(p.slice(0, i), p.slice(i + 1)); });
      clauses.push(`(${parts.join(' or ')})`);
    } else clauses.push(cond(k, v));
  }
  return { where: clauses.length ? 'where ' + clauses.join(' and ') : '', vals, next: n };
}
function buildOrder(params) {
  const os = params.filter(([k]) => k === 'order').flatMap(([, v]) => v.split(','));
  if (!os.length) return '';
  return 'order by ' + os.map((o) => { const [c, dir, nulls] = o.split('.'); return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullslast' ? ' nulls last' : nulls === 'nullsfirst' ? ' nulls first' : ''}`; }).join(', ');
}

async function project(client, table, rows, sel) {
  const all = await fks();
  for (const item of sel.filter((x) => x.embed)) {
    let cand = all.filter((f) => (f.tbl === table && f.ftbl === item.table) || (f.tbl === item.table && f.ftbl === table));
    if (item.hint) cand = cand.filter((f) => f.name === item.hint);
    if (cand.length !== 1) throw Object.assign(new Error(`Could not embed ${item.table} in ${table}: ${cand.length} relationships`), { status: 300, code: 'PGRST201' });
    const f = cand[0];
    if (f.tbl === table) { // many-to-one
      const ids = [...new Set(rows.map((r) => r[f.col]).filter((x) => x != null))];
      const sub = ids.length ? (await client.query(`select to_jsonb(_t) j from public.${ident(item.table)} _t where ${ident(f.fcol)}::text = any($1::text[])`, [ids])).rows.map((r) => r.j) : [];
      const projected = await project(client, item.table, sub, item.sub);
      for (const r of rows) { const i = sub.findIndex((s) => String(s[f.fcol]) === String(r[f.col])); r[`__${item.alias}`] = i >= 0 ? projected[i] : null; }
    } else { // one-to-many
      const ids = rows.map((r) => r[f.fcol]);
      const sub = ids.length ? (await client.query(`select to_jsonb(_t) j from public.${ident(item.table)} _t where ${ident(f.col)}::text = any($1::text[])`, [ids.map(String)])).rows.map((r) => r.j) : [];
      const isCount = item.sub.length === 1 && item.sub[0].col === 'count';
      const projected = isCount ? sub : await project(client, item.table, sub, item.sub);
      for (const r of rows) {
        const mine = sub.map((s, i) => [s, projected[i]]).filter(([s]) => String(s[f.col]) === String(r[f.fcol])).map(([, p]) => p);
        r[`__${item.alias}`] = isCount ? [{ count: mine.length }] : mine;
      }
    }
  }
  const cols = sel.filter((x) => !x.embed).map((x) => x.col);
  return rows.map((r) => {
    const o = {};
    if (cols.includes('*')) for (const [k, v] of Object.entries(r)) { if (!k.startsWith('__')) o[k] = v; }
    for (const c of cols) if (c !== '*') o[c] = r[c];
    for (const item of sel.filter((x) => x.embed)) o[item.alias] = r[`__${item.alias}`];
    for (const k of Object.keys(o)) if (k.startsWith('__')) delete o[k];
    return o;
  });
}

const jsonify = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString() : x)));

async function handle({ method, path, search, headers, body, sub, role }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role === 'service_role' ? 'service_role' : sub ? 'authenticated' : 'anon'}`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub || '']);
    const params = [...new URLSearchParams(search).entries()];
    const accept = headers.accept || '';
    const single = accept.includes('vnd.pgrst.object');
    const prefer = headers.prefer || '';
    let out;
    if (path.startsWith('rpc/')) {
      const fn = path.slice(4); const args = body || {};
      const keys = Object.keys(args);
      const sql = `select public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) as r`;
      const { rows } = await client.query(sql, keys.map((k) => Array.isArray(args[k]) && args[k].some((x) => x && typeof x === 'object') ? JSON.stringify(args[k]) : args[k]));
      out = { status: 200, body: rows[0]?.r ?? null };
    } else {
      const table = path; const t = `public.${ident(table)}`;
      const sel = parseSelect(params.find(([k]) => k === 'select')?.[1]);
      const { where, vals, next } = buildWhere(params);
      if (method === 'GET' || method === 'HEAD') {
        const limit = params.find(([k]) => k === 'limit')?.[1];
        const rows = (await client.query(`select to_jsonb(_t) j from ${t} _t ${where} ${buildOrder(params)} ${limit ? 'limit ' + (+limit) : ''}`, vals)).rows.map((r) => r.j);
        let count = null;
        if (prefer.includes('count=exact')) count = (await client.query(`select count(*)::int n from ${t} ${where}`, vals)).rows[0].n;
        const data = method === 'HEAD' ? [] : await project(client, table, rows, sel);
        const hdr = { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${count ?? '*'}` };
        if (single) {
          if (rows.length !== 1) out = { status: 406, body: { code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' } };
          else out = { status: 200, body: data[0], headers: hdr };
        } else out = { status: 200, body: method === 'HEAD' ? null : data, headers: hdr };
      } else if (method === 'POST') {
        const arr = Array.isArray(body) ? body : [body];
        const cols = [...new Set(arr.flatMap((r) => Object.keys(r)))];
        const colSql = cols.map(ident).join(', ');
        let sql = `insert into ${t} as _t (${colSql}) select ${colSql} from json_populate_recordset(null::${t}, $1)`;
        if (prefer.includes('resolution=merge-duplicates')) {
          const oc = params.find(([k]) => k === 'on_conflict')?.[1];
          sql += ` on conflict (${oc.split(',').map(ident).join(', ')}) do update set ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`;
        }
        const rows = (await client.query(sql + ' returning to_jsonb(_t) j', [JSON.stringify(arr)])).rows.map((r) => r.j);
        const data = await project(client, table, rows, sel);
        out = { status: 201, body: prefer.includes('return=representation') ? (single ? data[0] : data) : null };
      } else if (method === 'PATCH') {
        const cols = Object.keys(body);
        const rows = (await client.query(`update ${t} as _t set (${cols.map(ident).join(', ')}) = (select ${cols.map(ident).join(', ')} from json_populate_record(null::${t}, $${next})) ${where} returning to_jsonb(_t) j`, [...vals, JSON.stringify(body)])).rows.map((r) => r.j);
        const data = await project(client, table, rows, sel);
        out = { status: 200, body: prefer.includes('return=representation') ? (single ? data[0] : data) : null };
      } else if (method === 'DELETE') {
        const rows = (await client.query(`delete from ${t} as _t ${where} returning to_jsonb(_t) j`, vals)).rows.map((r) => r.j);
        out = { status: 200, body: prefer.includes('return=representation') ? rows : null };
      }
    }
    await client.query('commit');
    return { ...out, body: out.body == null ? out.body : jsonify(out.body) };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    return { status: e.status || (e.code === '42501' ? 403 : 400), body: { code: e.code || 'PGRST000', message: e.message, details: e.detail || null, hint: e.hint || null } };
  } finally { client.release(); }
}

// Storage (org-files) with RLS on storage.objects
async function storage({ method, path, body, sub, contentType }) {
  const client = await pool.connect();
  try {
    await client.query('begin'); await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    let out;
    if (method === 'POST' && path.startsWith('object/sign/')) {
      const [, , bucket, ...rest] = path.split('/'); const name = decodeURIComponent(rest.join('/'));
      const { rows } = await client.query('select id from storage.objects where bucket_id=$1 and name=$2', [bucket, name]);
      out = rows.length ? { status: 200, body: { signedURL: `/object/sign/${bucket}/${name}?token=test` } } : { status: 400, body: { statusCode: '404', error: 'not_found', message: 'Object not found' } };
    } else if (method === 'POST' && path.startsWith('object/')) {
      const [, bucket, ...rest] = path.split('/'); const name = decodeURIComponent(rest.join('/'));
      await client.query('insert into storage.objects (bucket_id, name, owner, data, mimetype) values ($1,$2,$3,$4,$5)', [bucket, name, sub, body, contentType]);
      out = { status: 200, body: { Key: `${bucket}/${name}`, Id: name } };
    } else out = { status: 404, body: { message: 'not handled' } };
    await client.query('commit'); return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    return { status: 400, body: { statusCode: '403', error: 'Unauthorized', message: e.message } };
  } finally { client.release(); }
}

module.exports = { handle, storage, pool };
