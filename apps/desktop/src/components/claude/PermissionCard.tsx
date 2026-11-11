import type { ActionCatalog, ActionDef, AppNotice } from '../../backend/types';
import { NOTICE_ID_PARAM, SPECIAL_ACTION, findAction } from '../../lib/actions';

/** 权限卡片：显示工具名与参数摘要；目录里有 permission.allow/deny 时带按钮，否则只做提示 */
export function PermissionCard({
  notice,
  catalog,
  enabled,
  onRun,
}: {
  notice: AppNotice;
  catalog: ActionCatalog | undefined;
  enabled: boolean;
  onRun: (def: ActionDef, args: Record<string, string>) => void;
}) {
  const allow = findAction(catalog, SPECIAL_ACTION.permissionAllow);
  const deny = findAction(catalog, SPECIAL_ACTION.permissionDeny);
  const args = { [NOTICE_ID_PARAM]: notice.noticeId };
  return (
    <div className="perm-card" role="alert">
      <span className="perm-title">需要确认</span>
      <span className="perm-tool mono" title={notice.toolSummary}>
        {notice.toolName}
        {notice.toolSummary ? `: ${notice.toolSummary}` : ''}
        {!notice.toolName && notice.text}
      </span>
      {allow && deny && (
        <>
          <button type="button" className="btn small" disabled={!enabled} onClick={() => onRun(deny, args)}>
            拒绝
          </button>
          <button type="button" className="btn small primary" disabled={!enabled} onClick={() => onRun(allow, args)}>
            允许
          </button>
        </>
      )}
    </div>
  );
}
