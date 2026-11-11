import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useController } from '../app/hooks';
import { Features, type CommandError, type CustomCommand, type FileId } from '../backend/types';
import {
  attachmentProgress,
  attachmentStatus,
  hasPendingAttachments,
  isImageName,
  pastedImageName,
  type Attachment,
  type UploadState,
} from '../lib/attachments';
import { ComposerMachine } from '../lib/composer';
import { allCompletionItems, completionInsertText, completionQuery, filterCompletions } from '../lib/completion';
import { formatBytes } from '../lib/format';
import { keyNameLabel } from '../lib/keys';
import type { TermTab } from '../state/store';
import { Icon, IconButton } from './common';

let localSeq = 1;

interface Props {
  tab: TermTab;
  sessionReady: boolean;
  features: readonly string[];
  maxFileSize?: number;
  uploads: Record<string, UploadState>;
  dragging: boolean;
  active: boolean;
}

/** 输入框：本地编辑，按键规则见 lib/composer.ts */
function ComposerImpl({ tab, sessionReady, features, maxFileSize, uploads, dragging, active }: Props) {
  const c = useController();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const machine = useRef(new ComposerMachine());
  const retryRef = useRef(new Map<string, () => void>());
  const [value, setValue] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [hint, setHint] = useState('');
  const [compIndex, setCompIndex] = useState(0);
  const [compDismissed, setCompDismissed] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((s: string) => {
    setHint(s);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(''), 2200);
  }, []);

  // 自动增高
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  // ———— 附件 ————

  const uploadEnabled = features.length === 0 || features.includes(Features.fileUpload);

  const patchAtt = useCallback((localId: string, patch: Partial<Attachment>) => {
    setAtts((list) => list.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));
  }, []);

  const startUpload = useCallback(
    (att: Attachment, run: () => Promise<{ fileId: FileId; name: string; size: number }>) => {
      const go = () => {
        patchAtt(att.localId, { error: undefined, fileId: undefined });
        run().then(
          (r) => patchAtt(att.localId, { fileId: r.fileId, size: r.size || att.size }),
          (e: CommandError) => {
            patchAtt(att.localId, { error: e.code === 'IS_DIRECTORY' ? '文件夹请先压缩' : e.message || '上传失败' });
            if (e.code === 'IS_DIRECTORY') c.toast('不能直接上传文件夹，请先压缩', 'error');
          },
        );
      };
      retryRef.current.set(att.localId, go);
      go();
    },
    [c, patchAtt],
  );

  const addPaths = useCallback(
    (paths: string[]) => {
      if (!uploadEnabled) return c.toast('对方不支持文件上传', 'error');
      if (!sessionReady) return c.toast('尚未连接，无法上传', 'error');
      for (const path of paths) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
        const att: Attachment = { localId: `a${localSeq++}`, name, size: 0, kind: isImageName(name) ? 'image' : 'file' };
        setAtts((l) => [...l, att]);
        startUpload(att, () => c.uploadPath(tab.sessionId, path));
      }
    },
    [c, sessionReady, startUpload, tab.sessionId, uploadEnabled],
  );

  const addImage = useCallback(
    async (file: File) => {
      if (!uploadEnabled) return c.toast('对方不支持文件上传', 'error');
      if (maxFileSize && file.size > maxFileSize) return c.toast('图片超过对方允许的大小', 'error');
      const data = new Uint8Array(await file.arrayBuffer());
      const name = file.name && file.name !== 'image.png' ? file.name : pastedImageName(new Date());
      const att: Attachment = { localId: `a${localSeq++}`, name, size: data.length, kind: 'image', previewUrl: URL.createObjectURL(file) };
      setAtts((l) => [...l, att]);
      startUpload(att, () => c.uploadBytes(tab.sessionId, name, file.type || 'image/png', data));
    },
    [c, maxFileSize, startUpload, tab.sessionId, uploadEnabled],
  );

  const removeAtt = (a: Attachment) => {
    const st = a.fileId ? uploads[`${tab.sessionId}:${a.fileId}`] : undefined;
    if (a.fileId && attachmentStatus(a, st) === 'uploading') void c.backend.cancelUpload(tab.sessionId, a.fileId).catch(() => {});
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    retryRef.current.delete(a.localId);
    setAtts((l) => l.filter((x) => x.localId !== a.localId));
  };

  const clearAll = () => {
    atts.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    retryRef.current.clear();
    setAtts([]);
    setValue('');
  };

  const pickFiles = async () => {
    try {
      const paths = await c.backend.pickFiles();
      if (paths.length) addPaths(paths);
    } catch (e) {
      c.toast(c.errorText(e), 'error');
    }
  };

  // ———— 对外句柄 ————

  const insertText = useCallback((text: string) => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    setValue(ta.value);
    machine.current.history.reset();
  }, []);

  const key = tab.key;
  useEffect(() => {
    c.registerComposer(key, {
      focus: (insert) => (insert ? insertText(insert) : taRef.current?.focus()),
      setText: (text) => {
        setValue(text);
        requestAnimationFrame(() => taRef.current?.focus());
      },
      addPaths,
    });
    return () => c.registerComposer(key, null);
  }, [c, key, addPaths, insertText]);

  // 切到本标签且非直通时，焦点给输入框
  useEffect(() => {
    if (active && tab.passthrough === 'off') taRef.current?.focus();
  }, [active, tab.passthrough]);

  // ———— 斜杠补全（v1.1）————

  const claudeTab = tab.profile === 'claude' || (tab.app?.app === 'claude' && tab.app.running);
  const compQuery = claudeTab && !compDismissed ? completionQuery(value) : null;
  const allItems = useMemo(
    () => allCompletionItems(features.includes(Features.appCommands) ? tab.commands : ([] as CustomCommand[])),
    [features, tab.commands],
  );
  const compItems = useMemo(() => (compQuery === null ? [] : filterCompletions(allItems, compQuery)), [allItems, compQuery]);
  const compOpen = compItems.length > 0;
  const compSel = Math.min(compIndex, Math.max(0, compItems.length - 1));

  const acceptCompletion = (i: number) => {
    const it = compItems[i];
    if (!it) return;
    setValue(completionInsertText(it));
    setCompIndex(0);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };

  // ———— 提交 ————

  const doSubmit = async () => {
    if (tab.status !== 'open') return showHint('终端尚未就绪');
    if (!value.trim() && atts.length === 0) return;
    if (hasPendingAttachments(atts, uploads, tab.sessionId)) {
      const failed = atts.some((a) => attachmentStatus(a, a.fileId ? uploads[`${tab.sessionId}:${a.fileId}`] : undefined) === 'failed');
      return showHint(failed ? '有附件上传失败，请重试或移除' : '附件还在上传');
    }
    const ids = atts.map((a) => a.fileId!).filter(Boolean);
    const ok = await c.submit(key, value, ids);
    if (!ok) return; // 未连接/重连中：保留输入内容，提示已由控制器给出
    machine.current.history.push(value);
    machine.current.resetEsc();
    atts.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    retryRef.current.clear();
    setAtts([]);
    setValue('');
  };

  // ———— 键盘 ————

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent;
    const ta = e.currentTarget;

    // 补全列表打开时，方向键/Tab/回车/Esc 先由列表处理
    if (compOpen && !ne.isComposing && ne.keyCode !== 229) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        return setCompIndex((compSel + 1) % compItems.length);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        return setCompIndex((compSel - 1 + compItems.length) % compItems.length);
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const it = compItems[compSel];
        // 没有参数的命令，已经完整输入时回车直接提交
        const exact = e.key === 'Enter' && it && value.trim() === `/${it.name}` && !it.argumentHint;
        if (!exact) {
          e.preventDefault();
          return acceptCompletion(compSel);
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return setCompDismissed(true);
      }
    }

    const d = machine.current.onKeyDown(
      ne,
      {
        empty: value.length === 0 && atts.length === 0,
        hasSelection: ta.selectionStart !== ta.selectionEnd || c.runtime(key).hasSelection(),
        appCursor: tab.modes.appCursor,
      },
      Date.now(),
    );
    switch (d.type) {
      case 'ime':
      case 'default':
        return;
      case 'swallow':
        return e.preventDefault();
      case 'send':
        e.preventDefault();
        return c.sendInput(key, d.bytes);
      case 'submit':
        e.preventDefault();
        return void doSubmit();
      case 'togglePassthrough':
        e.preventDefault();
        return c.togglePassthrough(key);
      case 'history': {
        e.preventDefault();
        const v = machine.current.history.browse(d.dir, value);
        if (v !== null) setValue(v);
        return;
      }
      case 'escHint':
        e.preventDefault();
        return showHint('再按一次 Esc 清空');
      case 'clear':
        e.preventDefault();
        setHint('');
        return clearAll();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    const images = [...cd.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (images.length > 0) {
      e.preventDefault();
      images.forEach((f) => f && void addImage(f));
      return;
    }
    if (cd.getData('text/plain')) return; // 纯文本：浏览器默认行为
    // 没有文本也没有图片：可能是在文件管理器里复制了文件，走原生接口读取
    e.preventDefault();
    c.backend.readClipboardFiles().then(
      (paths) => paths.length > 0 && addPaths(paths),
      (err: CommandError) =>
        c.toast(err.code === 'CLIPBOARD_UNAVAILABLE' ? '无法读取剪贴板里的文件，请拖入窗口或点击回形针选择' : err.message, 'error'),
    );
  };

  const placeholder = !sessionReady ? '未连接' : '输入消息';

  return (
    <div className={`composer${dragging && active ? ' drop' : ''}`}>
      {atts.length > 0 && (
        <div className="att-strip">
          {atts.map((a) => {
            const st = a.fileId ? uploads[`${tab.sessionId}:${a.fileId}`] : undefined;
            const status = attachmentStatus(a, st);
            const prog = attachmentProgress(a, st);
            return (
              <div key={a.localId} className={`att ${status}`} title={a.error || st?.failed || a.name}>
                {a.previewUrl ? <img src={a.previewUrl} alt="" /> : <span className="att-icon"><Icon name="file" /></span>}
                <div className="att-meta">
                  <span className="att-name">{a.name}</span>
                  <span className="att-sub">
                    {status === 'failed' ? (a.error || st?.failed || '失败') : a.size ? formatBytes(a.size) : status === 'uploading' ? '上传中' : ''}
                  </span>
                </div>
                {status === 'uploading' && <div className="att-bar"><i style={{ width: `${Math.round(prog * 100)}%` }} /></div>}
                {status === 'failed' && (
                  <button type="button" className="att-btn" title="重试" onClick={() => retryRef.current.get(a.localId)?.()}>
                    <Icon name="refresh" size={12} />
                  </button>
                )}
                <button type="button" className="att-btn" title="移除" onClick={() => removeAtt(a)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {compOpen && (
        <div className="completion" role="listbox">
          {compItems.map((it, i) => (
            <div key={it.name} className={`completion-item${i === compSel ? ' sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); acceptCompletion(i); }} onMouseMove={() => setCompIndex(i)}>
              <span className="mono">/{it.name}</span>
              {it.argumentHint && <span className="muted small mono">{it.argumentHint}</span>}
              <span className="completion-desc">{it.description}</span>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <IconButton icon="attach" title="添加附件" onClick={() => void pickFiles()} />
        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setCompDismissed(false);
            machine.current.history.reset();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => machine.current.ime.compositionStart()}
          onCompositionEnd={() => machine.current.ime.compositionEnd(Date.now())}
        />
        {hint && <span className="composer-hint">{hint}</span>}
        <button type="button" className="btn small" title="直通模式 (Ctrl+Shift+P)" onClick={() => c.togglePassthrough(key)}>
          直通
        </button>
      </div>
    </div>
  );
}

export const Composer = memo(ComposerImpl);

/** 直通模式下替代输入框的提示条 */
export function PassthroughBar({ tab, collapsed = false, onExit }: { tab: TermTab; collapsed?: boolean; onExit: () => void }) {
  const temp = tab.passthrough === 'temp';
  if (collapsed) {
    return (
      <div className="pass-bar collapsed">
        <span className="pass-dot" />
        <span>操作区已折叠，键盘直接输入终端</span>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={onExit} title="展开操作区">
          <Icon name="up" size={12} />
          展开
        </button>
      </div>
    );
  }
  return (
    <div className="pass-bar">
      <span className="pass-dot" />
      <span>
        {temp
          ? `正在终端里操作，按 ${tab.returnKeys.map(keyNameLabel).join(' 或 ') || 'Esc'} 结束`
          : tab.autoPassthrough
            ? '全屏程序运行中，已自动直通'
            : '直通模式'}
      </span>
      <span className="spacer" />
      <button type="button" className="btn small" onClick={onExit}>
        {temp ? '返回输入框' : '退出直通'}
      </button>
    </div>
  );
}
