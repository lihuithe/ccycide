import { useState } from 'react';
import type { ActionDef } from '../../backend/types';
import type { MenuGroup } from '../../lib/actions';
import { Icon, Popover } from '../common';

/** “更多”菜单：按分组列出 placement=menu 的动作 */
export function ActionMenu({ groups, onPick }: { groups: MenuGroup[]; onPick: (def: ActionDef) => void }) {
  const [open, setOpen] = useState(false);
  if (groups.length === 0) return null;
  return (
    <div className="menu-anchor">
      <button type="button" className={`icon-btn${open ? ' active' : ''}`} title="更多" aria-label="更多" onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="action-menu up">
          {groups.map((g) => (
            <div key={g.group} className="menu-group">
              <div className="menu-group-title">{g.group}</div>
              {g.items.map(({ def, enabled }) => (
                <button
                  key={def.id}
                  type="button"
                  className="menu-item"
                  disabled={!enabled}
                  title={def.note || undefined}
                  onClick={() => {
                    setOpen(false);
                    onPick(def);
                  }}
                >
                  <span>{def.title}</span>
                </button>
              ))}
            </div>
          ))}
        </Popover>
      )}
    </div>
  );
}
