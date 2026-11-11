import { useEffect, useRef, type ReactNode } from 'react';

type IconName = 'copy' | 'refresh' | 'gear' | 'key' | 'close' | 'plus' | 'stop' | 'search' | 'more' | 'attach' | 'terminal' | 'sparkle' | 'up' | 'down' | 'check' | 'pause' | 'play' | 'file' | 'lock';

const PATHS: Record<IconName, ReactNode> = {
  copy: <path d="M5 5V3.5A1.5 1.5 0 0 1 6.5 2h6A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H11M3.5 5h6A1.5 1.5 0 0 1 11 6.5v6A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-6A1.5 1.5 0 0 1 3.5 5Z" />,
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  gear: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="10.5" r="2.5" />
      <path d="m7.3 8.7 5.7-5.7M11 5l1.5 1.5" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  search: <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.5-1.5L14 14" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.4" />,
  attach: <path d="m13 7.5-5 5a3 3 0 0 1-4.2-4.2l5.3-5.3a2 2 0 0 1 2.8 2.8L6.7 11.2a1 1 0 0 1-1.4-1.4L10 5" />,
  terminal: <path d="m3 4.5 3.5 3.5L3 11.5M8 12h5" />,
  sparkle: <path d="M8 2v4M8 10v4M2 8h4M10 8h4M4 4l1.5 1.5M10.5 10.5 12 12M12 4l-1.5 1.5M5.5 10.5 4 12" />,
  up: <path d="m4 10 4-4 4 4" />,
  down: <path d="m4 6 4 4 4-4" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2" />,
  play: <path d="M5 3.5v9l7-4.5-7-4.5Z" />,
  lock: <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v6.5h-9V7Z" />,
  file: <path d="M4 2h5l3 3v9H4V2Zm5 0v3h3" />,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

export function IconButton({
  icon,
  title,
  onClick,
  active,
  disabled,
  danger,
}: {
  icon: IconName;
  title: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${active ? ' active' : ''}${danger ? ' danger' : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 420,
}: {
  title?: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width }} role="dialog" aria-label={title}>
        {title && <div className="modal-title">{title}</div>}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** 点击外部或按 Esc 关闭的浮层 */
export function Popover({ onClose, children, className = '' }: { onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // 延后一帧注册，避免打开它的那次点击立刻把它关掉
    const t = setTimeout(() => document.addEventListener('mousedown', down), 0);
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`popover ${className}`}>
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}
