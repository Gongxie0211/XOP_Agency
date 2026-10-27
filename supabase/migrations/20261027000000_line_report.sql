-- 施工完了のLINE報告（試験運用版）
-- データはすべてサーバー側の処理（Edge Function: api）を通して読み書きする。
-- RLS を有効にしてポリシーを作らないので、ブラウザから直接は読めない。

create extension if not exists pgcrypto;

-- 代理店
create table agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- 使う人（代理店の施工責任者・手伝い、本部）
-- 本部が登録すると招待コードができ、本人が最初にLINEで開いたときにコードを入れるとLINEとひもづく。
create table members (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id),
  name text not null,
  role text not null check (role in ('agency', 'hq')),
  is_certified boolean not null default false,   -- 研修を受けた施工責任者
  line_user_id text unique,
  invite_code text unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (role = 'hq' or agency_id is not null)
);

-- 現場（試験中は本部が登録する）
-- お客様の名前・住所・電話は持たない。label は「○○マンション 共用廊下」のような呼び名だけ。
create sequence site_no_seq;
create table sites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('T-' || lpad(nextval('site_no_seq')::text, 4, '0')),
  label text not null,
  agency_id uuid not null references agencies(id),
  kind text not null check (kind in ('own', 'crux')),          -- own: 代理店の現場 / crux: クラックスの現場
  planned_date date,
  material text not null default 'tile_concrete' check (material in ('tile_concrete', 'other')),
  estimated_area numeric(8, 1),
  status text not null default 'planned'
    check (status in ('planned', 'reported', 'approved', 'certified')),
  created_by uuid references members(id),
  created_at timestamptz not null default now()
);

-- 完了報告（1現場に1件。差し戻し後の再送は同じ行を更新し、履歴は report_events に残す）
create table reports (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null unique references sites(id),
  submitted_by uuid not null references members(id),
  start_date date not null,
  end_date date not null,
  responsible_member_id uuid not null references members(id),
  material text not null check (material in ('tile_concrete', 'other')),
  area_m2 numeric(8, 1) not null check (area_m2 > 0),
  liters numeric(6, 1) not null check (liters > 0),
  cans text[] not null default '{}',
  customer_confirmed boolean,
  note text,
  status text not null default 'submitted' check (status in ('submitted', 'returned', 'approved')),
  hq_comment text,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references members(id),
  reviewed_at timestamptz,
  certificate_issued_at timestamptz,
  check (end_date >= start_date)
);

create table report_photos (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  kind text not null check (kind in ('before', 'after', 'boundary', 'can_label')),
  place_no int,
  place_label text,
  storage_path text not null,
  taken_at timestamptz,                -- 写真に残っていた撮影日時（読めなければ null）
  source text not null check (source in ('camera', 'library')),
  created_at timestamptz not null default now()
);
create index on report_photos (report_id);

-- 出面（クラックスの現場だけ）
create table attendance (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  person_name text not null,
  person_role text not null check (person_role in ('responsible', 'helper')),
  work_date date not null,
  days numeric(2, 1) not null check (days in (0.5, 1.0))
);
create index on attendance (report_id);

-- だれが・いつ・何をしたか
create table report_events (
  id bigint generated always as identity primary key,
  report_id uuid not null references reports(id) on delete cascade,
  action text not null check (action in ('submitted', 'resubmitted', 'approved', 'returned', 'certified')),
  actor uuid references members(id),
  comment text,
  created_at timestamptz not null default now()
);

alter table agencies enable row level security;
alter table members enable row level security;
alter table sites enable row level security;
alter table reports enable row level security;
alter table report_photos enable row level security;
alter table attendance enable row level security;
alter table report_events enable row level security;

-- 写真の保管場所（外からは見えない。表示は期限つきリンクで行う）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 5242880, array['image/jpeg']);
