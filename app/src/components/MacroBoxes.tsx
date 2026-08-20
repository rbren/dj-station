// Macro bounding boxes: each expanded macro instance draws a labeled
// dashed box around its member panels (the modules stay ordinary panels —
// the box is the only "collapsed module" chrome left). The label drags the
// whole group rigidly (App.moveGroup) and right-clicks into the macro
// context menu (Break/Delete). The box itself is pointer-transparent so
// wiring and panel drags underneath are unaffected.

import { useCallback, useEffect, useRef } from 'react';
import type { MacroGroup } from '../engine';
import { boundingBox, defaultPosition, moduleRect } from '../rackLayout';
import { useRackSelector } from '../rackStore';
import { snap } from './ModulePanel';

/** Breathing room between the members' bounding box and the border. */
const PAD = 10;
/** Space above the box for the name tab. */
const LABEL_H = 22;

export interface MacroBoxesProps {
  groups: MacroGroup[];
  /** Rack scale factor: label drags convert screen px to rack coords. */
  zoom?: number;
  /** Rigid group move — App.moveGroup semantics (anchor's new position). */
  onMoveGroup(anchor: string, x: number, y: number, members: string[]): void;
  onMoveEnd?(): void;
  onContextMenu(group: MacroGroup, e: React.MouseEvent): void;
}

export function MacroBoxes({
  groups,
  zoom = 1,
  onMoveGroup,
  onMoveEnd,
  onContextMenu,
}: MacroBoxesProps) {
  const positions = useRackSelector((s) => s.positions);
  const nodes = useRackSelector((s) => s.nodes);
  const drag = useRef<null | {
    anchor: string;
    members: string[];
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }>(null);

  const onDragMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      onMoveGroup(
        d.anchor,
        snap(d.origX + (e.clientX - d.startX) / zoom),
        snap(d.origY + (e.clientY - d.startY) / zoom),
        d.members,
      );
    },
    [onMoveGroup, zoom],
  );
  const onDragEnd = useCallback(() => {
    if (drag.current) {
      drag.current = null;
      onMoveEnd?.();
    }
  }, [onMoveEnd]);
  useEffect(() => {
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    return () => {
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
    };
  }, [onDragMove, onDragEnd]);

  const posOf = (id: string) => {
    if (positions[id]) return positions[id];
    const idx = nodes.findIndex((n) => n.instance_id === id);
    return defaultPosition(Math.max(idx, 0));
  };

  return (
    <>
      {groups.map((g) => {
        const members = g.members.filter((m) => nodes.some((n) => n.instance_id === m));
        if (members.length === 0) return null;
        const box = boundingBox(members.map((m) => moduleRect(m, posOf(m))));
        return (
          <div
            key={g.instance}
            className="macro-box"
            data-testid={`macro-box-${g.instance}`}
            style={{
              left: box.x - PAD,
              top: box.y - PAD - LABEL_H,
              width: box.w + PAD * 2,
              height: box.h + PAD * 2 + LABEL_H,
            }}
          >
            <span
              className="macro-box-label"
              data-testid={`macro-box-label-${g.instance}`}
              data-tip="Drag to move the macro; right-click to break or delete it"
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                const anchor = members[0];
                const p = posOf(anchor);
                drag.current = {
                  anchor,
                  members,
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: p.x,
                  origY: p.y,
                };
              }}
              onContextMenu={(e) => onContextMenu(g, e)}
            >
              {g.name}
              <span className="macro-box-instance">{g.instance}</span>
            </span>
          </div>
        );
      })}
    </>
  );
}
