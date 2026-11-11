import { describe, expect, it } from 'vitest';
import type { AppNotice } from '../backend/types';
import { attachmentStatus, hasPendingAttachments, pastedImageName, type Attachment } from './attachments';
import { allCompletionItems, completionInsertText, completionQuery, filterCompletions } from './completion';
import { formatBytes, formatDeviceCode, formatDuration, parseDeviceCode } from './format';
import { DONE_MERGE_MS, focusJumpTarget, NoticeNotifier, type NotifyContext } from './notify';
import { TEMP_PASSWORD_CHARSET, validateFixedPassword } from './password';

describe('设备码格式', () => {
  it('3 位一组，忽略空格和非数字，不限定 9 位', () => {
    expect(formatDeviceCode('482913675')).toBe('482 913 675');
    expect(parseDeviceCode(' 482 913-675a')).toBe('482913675');
    expect(formatDeviceCode('4829136751')).toBe('482 913 675 1');
    expect(formatDeviceCode('48')).toBe('48');
  });
  it('时长与体积', () => {
    expect(formatDuration(45_000)).toBe('45 秒');
    expect(formatDuration(192_000)).toBe('3 分 12 秒');
    expect(formatDuration(3_900_000)).toBe('1 小时 5 分');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('密码规则', () => {
  it('临时密码字符集不含易混淆字符', () => {
    for (const c of '0O1lI') expect(TEMP_PASSWORD_CHARSET).not.toContain(c);
  });
  it('固定密码：至少 8 位，且不能是 8 位纯临时字符集', () => {
    expect(validateFixedPassword('short')).not.toBeNull();
    expect(validateFixedPassword('abcd2345')).not.toBeNull();
    expect(validateFixedPassword('abcd2345x')).toBeNull();
    expect(validateFixedPassword('abcd-234')).toBeNull();
    // 含易混淆字符的 8 位不属于临时密码字符集，可以用
    expect(validateFixedPassword('abcdl234')).toBeNull();
  });
});

describe('附件状态', () => {
  const att = (p: Partial<Attachment> = {}): Attachment => ({ localId: 'a', name: 'x.png', size: 1, kind: 'image', ...p });
  it('无 fileId = 上传中；有进度、完成、失败', () => {
    expect(attachmentStatus(att(), undefined)).toBe('uploading');
    expect(attachmentStatus(att({ fileId: '1' }), { sent: 1, total: 2, done: false })).toBe('uploading');
    expect(attachmentStatus(att({ fileId: '1' }), { sent: 2, total: 2, done: true })).toBe('ready');
    expect(attachmentStatus(att({ fileId: '1' }), { sent: 1, total: 2, done: false, failed: 'x' })).toBe('failed');
    expect(attachmentStatus(att({ error: '目录' }), undefined)).toBe('failed');
  });
  it('有未就绪附件时不能提交', () => {
    const uploads = { 's:1': { sent: 2, total: 2, done: true } };
    expect(hasPendingAttachments([att({ fileId: '1' })], uploads, 's')).toBe(false);
    expect(hasPendingAttachments([att({ fileId: '1' }), att({ localId: 'b' })], uploads, 's')).toBe(true);
    expect(hasPendingAttachments([], uploads, 's')).toBe(false);
  });
  it('粘贴图片命名', () => {
    expect(pastedImageName(new Date(2026, 10, 11, 9, 5, 3))).toBe('粘贴图片-20261111-090503.png');
  });
});

describe('通知策略', () => {
  const ctx = (p: Partial<NotifyContext> = {}): NotifyContext => ({
    windowFocused: false, isActiveTab: true, tabLabel: 'Claude Code', notifyOnDone: true, notifyOnPermission: true, ...p,
  });
  const notice = (p: Partial<AppNotice>): AppNotice => ({
    kind: 'done', title: '', text: '', noticeId: '', toolName: '', toolSummary: '', resolved: false, ...p,
  });

  it('窗口在前台且是当前标签：不通知', () => {
    const n = new NoticeNotifier();
    expect(n.decide('k', notice({}), ctx({ windowFocused: true }), 0)).toBeNull();
  });

  it('窗口在后台：任务完成发系统通知并加角标', () => {
    const d = new NoticeNotifier().decide('k', notice({}), ctx(), 0)!;
    expect(d).toMatchObject({ system: true, badge: true });
    expect(d.title).toContain('任务完成');
  });

  it('窗口在前台但不是当前标签：也通知', () => {
    expect(new NoticeNotifier().decide('k', notice({}), ctx({ windowFocused: true, isActiveTab: false }), 0)?.system).toBe(true);
  });

  it('任务完成 10 秒内合并，之后再发', () => {
    const n = new NoticeNotifier();
    expect(n.decide('k', notice({}), ctx(), 0)?.system).toBe(true);
    expect(n.decide('k', notice({}), ctx(), DONE_MERGE_MS - 1)?.system).toBe(false);
    expect(n.decide('k', notice({}), ctx(), DONE_MERGE_MS)?.system).toBe(true);
    // 不同终端互不影响
    expect(n.decide('k2', notice({}), ctx(), 1)?.system).toBe(true);
  });

  it('需要确认：带工具名与摘要；可单独关闭系统通知但仍有角标', () => {
    const p = notice({ kind: 'permission', toolName: 'Bash', toolSummary: 'npm run build' });
    const d = new NoticeNotifier().decide('k', p, ctx(), 0)!;
    expect(d.body).toBe('Bash：npm run build');
    const off = new NoticeNotifier().decide('k', p, ctx({ notifyOnPermission: false }), 0)!;
    expect(off).toMatchObject({ system: false, badge: true });
  });

  it('已失效的通知不提示', () => {
    expect(new NoticeNotifier().decide('k', notice({ kind: 'permission', resolved: true }), ctx(), 0)).toBeNull();
  });

  it('窗口重新获得焦点时跳转到最近通知的标签（60 秒内）', () => {
    expect(focusJumpTarget({ termKey: 'k', at: 0 }, 30_000)).toBe('k');
    expect(focusJumpTarget({ termKey: 'k', at: 0 }, 61_000)).toBeNull();
    expect(focusJumpTarget(null, 0)).toBeNull();
  });
});

describe('斜杠补全', () => {
  const custom = [{ name: 'deploy', description: '部署', argumentHint: '[环境]', source: 'project' }];
  const items = allCompletionItems(custom);

  it('只在以 / 开头且还没有空格时触发', () => {
    expect(completionQuery('/de')).toBe('de');
    expect(completionQuery('/')).toBe('');
    expect(completionQuery('/model opus')).toBeNull();
    expect(completionQuery('hello /de')).toBeNull();
  });

  it('前缀优先，包含其次，含自定义命令', () => {
    const r = filterCompletions(items, 'de');
    expect(r[0].name).toBe('deploy');
    expect(filterCompletions(items, 'xyz')).toEqual([]);
    expect(filterCompletions(items, 'mo').map((i) => i.name)).toContain('model');
  });

  it('自定义命令覆盖同名内置，选中后加空格', () => {
    const o = allCompletionItems([{ name: 'init', description: '自定义 init', argumentHint: '', source: 'user' }]);
    const init = o.find((i) => i.name === 'init')!;
    expect(init.source).toBe('user');
    expect(completionInsertText(init)).toBe('/init ');
  });
});
