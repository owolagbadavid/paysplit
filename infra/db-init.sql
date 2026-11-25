-- Schema and role that the local GoTrue (Supabase Auth) container runs its own migrations in.
create role supabase_auth_admin login password 'auth-local' noinherit createrole;
create schema auth authorization supabase_auth_admin;
grant create on database paysplit to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
