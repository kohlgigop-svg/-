-- =============================================================================
-- 补丁 3：新增管理员清理函数（处理孤儿数据）
-- -----------------------------------------------------------------------------
-- 为什么需要它：
--   记录归属由浏览器的匿名会话决定。如果成员清除了浏览器数据、换了设备、
--   或者离职，他提交的记录就变成「无主数据」——任何人都无法修订或删除，
--   连带整个项目也删不掉（因为项目下存在「他人」记录）。
--   本函数提供唯一的官方清理出口，需持有访问码才能执行。
--
-- 使用：
--   1. Supabase 控制台 → SQL Editor → New query → 粘贴本文件全文 → Run
--   2. 然后在同一个编辑器里执行下面任意一条（按需）：
--
--      -- 清理所有测试项目（名称以 __E2E 开头）
--      select public.qc_admin_cleanup('qc-eval-2026', 'CONFIRM_DELETE');
--
--      -- 清理指定项目（把 UUID 换成实际项目 id，可从 qc_fetch_all 结果里取）
--      select public.qc_admin_cleanup('qc-eval-2026', 'CONFIRM_DELETE',
--                                     '1164f919-88e2-4f1a-a07c-4801e99e5c16');
--
--   安全设计：必须同时给出正确访问码与确认串 'CONFIRM_DELETE'；
--             按项目清理时单次最多 200 条，避免误操作清空整个库。
-- =============================================================================

create or replace function public.qc_admin_cleanup(
  p_code       text,
  p_confirm    text,
  p_project_id uuid default null
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

  if p_project_id is null then
    select count(*) into v_records
      from qc_records r join qc_projects p on p.id = r.project_id
     where p.name like '\_\_E2E%' escape '\';
    delete from qc_projects where name like '\_\_E2E%' escape '\';
    get diagnostics v_projects = row_count;
  else
    select count(*) into v_records from qc_records where project_id = p_project_id;
    if v_records > 200 then
      raise exception 'TOO_MANY: 单次最多清理 200 条记录，当前 % 条', v_records;
    end if;
    delete from qc_records where project_id = p_project_id;
    delete from qc_projects where id = p_project_id;
    get diagnostics v_projects = row_count;
  end if;

  return jsonb_build_object('deletedRecords', v_records, 'deletedProjects', v_projects);
end;
$$;

grant execute on function public.qc_admin_cleanup(text, text, uuid) to anon, authenticated;

-- =============================================================================
-- 执行完上面的建函数语句后，接着执行这一条，把本次遗留的测试数据清掉：
-- =============================================================================
select public.qc_admin_cleanup('qc-eval-2026', 'CONFIRM_DELETE');
