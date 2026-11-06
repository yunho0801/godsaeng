-- 갓생게임 저장소 테이블
-- Supabase 대시보드 > SQL Editor에 붙여 넣고 Run을 누르세요.
create table if not exists public.app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- 브라우저(anon 키)에서는 접근할 수 없게 막습니다.
-- 서버는 service_role 키를 쓰기 때문에 RLS의 영향을 받지 않습니다.
alter table public.app_state enable row level security;
