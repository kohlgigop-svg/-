-- =============================================================================
-- 一键清理测试数据（可直接执行，无需额外步骤）
-- -----------------------------------------------------------------------------
-- 背景：历次测试在你的云端建了 3 个项目：
--   GUI-L3_step（1 条）、test1（3 条）、端到端测试项目（1 条）
-- 这些记录的归属是「当时那次测试的浏览器会话」，该会话已不存在，
-- 因此任何人都无法修订或删除它们——这正是「孤儿数据」场景。
-- 常规删除接口会以 PROJECT_HAS_OTHERS_RECORDS 拒绝，必须用管理员函数清理。
--
-- 使用：Supabase → SQL Editor → New query → 粘贴本文件全文 → Run
--       最后一条 select 会返回删除结果，形如 {"deletedRecords":5,"deletedProjects":3}
--
-- 说明：本文件只删除上面列出的 3 个测试项目，不会碰你真正在用的项目。
--       执行完可顺手执行文件末尾的注释语句确认剩余项目。
-- =============================================================================

create or replace function public.qc_admin_cleanup(
  p_code        text,
  p_confirm     text,
  p_project_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_records  integer := 0;
  v_projects integer := 0;
begin
  if not qc_access_ok(p_code) then
    raise exception 'ACCESS_DENIED: 访问码不正确' using errcode = '42501';
  end if;
  if p_confirm is distinct from 'CONFIRM_DELETE' then
    raise exception 'CONFIRM_REQUIRED: 需传入确认串 CONFIRM_DELETE';
  end if;

  if p_project_ids is null or array_length(p_project_ids, 1) is null then
    select count(*) into v_records
      from qc_records r join qc_projects p on p.id = r.project_id
     where p.name like '\_\_E2E%' escape '\';
    delete from qc_projects where name like '\_\_E2E%' escape '\';
    get diagnostics v_projects = row_count;
  else
    select count(*) into v_records from qc_records where project_id = any(p_project_ids);
    if v_records > 200 then
      raise exception 'TOO_MANY: 单次最多清理 200 条记录，当前 % 条', v_records;
    end if;
    delete from qc_records where project_id = any(p_project_ids);
    delete from qc_projects where id = any(p_project_ids);
    get diagnostics v_projects = row_count;
  end if;

  return jsonb_build_object('deletedRecords', v_records, 'deletedProjects', v_projects);
end;
$$;

grant execute on function public.qc_admin_cleanup(text, text, uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 执行清理：删除 3 个测试项目（不影响你的真实项目）
-- ---------------------------------------------------------------------------
select public.qc_admin_cleanup(
  'qc-eval-2026',
  'CONFIRM_DELETE',
  (select array_agg(id) from public.qc_projects
    where name in ('test1', '端到端测试项目', 'GUI-L3_step'))
);

-- ---------------------------------------------------------------------------
-- 复核：把下面这条取消注释单独执行，可查看当前还剩哪些项目
-- ---------------------------------------------------------------------------
-- select p.name as 项目名, count(r.id) as 记录数
--   from public.qc_projects p
--   left join public.qc_records r on r.project_id = p.id
--  group by p.name order by p.name;
