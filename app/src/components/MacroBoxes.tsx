// Macro bounding boxes: each expanded macro instance draws a labeled
// dashed box around its member panels (the modules stay ordinary panels —
// the box is the only "collapsed module" chrome left). The label drags the
// whole group rigidly (App.moveGroup) and right-clicks into the macro
// context menu (Break/Delete). The box itself is pointer-transparent so
// wiring and panel drags underneath are unaffected.

import { useCallback, useEffect, useRef } from 'react';
import type { MacroGroup } from '../engine';
import { boundingBox, defaultPosition, MACRO_LABEL_H, MACRO_PAD, moduleRect } from '../rackLayout';
import { useRackSelector } from '../rackStore';
import { snap } from './ModulePanel';

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
  // Latest props for the drag closures (the gesture must survive App
  // re-renders mid-drag without re-registering listeners).
  const propsRef = useRef({ zoom, onMoveGroup, onMoveEnd });
  useEffect(() => {
    propsRef.current = { zoom, onMoveGroup, onMoveEnd };
  });
  // The active gesture's teardown — one drag at a time; unmount cancels.
  const cancelDrag = useRef<null | (() => void)>(null);
  useEffect(() => () => cancelDrag.current?.(), []);

  // Per-gesture window listeners (registered on mousedown, removed on
  // mouseup): the closures live exactly as long as the gesture, so React
  // re-renders during the drag can never drop the mouseup and leave the
  // group glued to the pointer.
  const startDrag = useCallback(
    (e: React.MouseEvent, anchor: string, members: string[], orig: { x: number; y: number }) => {
      cancelDrag.current?.();
      const startX = e.clientX;
      const startY = e.clientY;
      const onMove = (ev: MouseEvent) => {
        const p = propsRef.current;
        p.onMoveGroup(
          anchor,
          snap(orig.x + (ev.clientX - startX) / p.zoom),
          snap(orig.y + (ev.clientY - startY) / p.zoom),
          members,
        );
      };
      const end = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', end);
        cancelDrag.current = null;
        propsRef.current.onMoveEnd?.();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', end);
      cancelDrag.current = end;
    },
    [],
  );

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
              left: box.x - MACRO_PAD,
              top: box.y - MACRO_PAD - MACRO_LABEL_H,
              width: box.w + MACRO_PAD * 2,
              height: box.h + MACRO_PAD * 2 + MACRO_LABEL_H,
            }}
          >
            <span
              className="macro-box-label"
              data-testid={`macro-box-label-${g.instance}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                // The label sits directly on the rack background — without
                // this the rack's own mousedown would also arm a marquee
                // sweep on top of the drag.
                e.stopPropagation();
                startDrag(e, members[0], members, posOf(members[0]));
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
