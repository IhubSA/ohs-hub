import pg from 'pg'; import fs from 'fs'; import path from 'path';
const admin = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'postgres' });
await admin.connect(); await admin.query('drop database if exists ohs'); await admin.query('create database ohs'); await admin.end();
const c = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'ohs' });
await c.connect();
await c.query(`
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role authenticator login password 'pw' noinherit; exception when duplicate_object then null; end $$;
grant anon, authenticated, service_role to authenticator;
create schema auth; create schema storage; create schema vault; create schema cron; create schema net;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}', email_confirmed_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, data bytea, mimetype text, created_at timestamptz default now());
alter table storage.objects enable row level security;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create function vault.create_secret(s text, n text, d text) returns uuid language sql as $$ insert into vault.secrets(name, secret, description) values (n, s, d) returning id $$;
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ select 1::bigint $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
`);
const dir = process.argv[2];
for (const f of fs.readdirSync(dir).sort()) {
  try { await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); console.log('applied', f); }
  catch (e) { console.log('ERROR', f, e.message); process.exit(1); }
}
await c.query(`grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
  grant select on public.subscription_plans to anon;
  grant select, insert, update, delete on storage.objects to authenticated;`);
await c.end(); console.log('DB READY');
