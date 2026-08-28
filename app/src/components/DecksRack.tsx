// The rack strip above the decks: the modules a deck can be routed
// through, drawn as a grid of small cards with their jacks on them.
//
// This is NOT a second patch graph. The modules are the patch's own
// modules and the cables are the patch's own wires — the same engine
// commands the Rack tab uses (`add_module`, `connect_wire`,
// `remove_module`), the same `Jack` component, the same `WireOverlay`
// reading `data-jack` sockets. What is different is only the LAYOUT: the
// Rack tab gives a module a draggable panel on an infinite canvas, and
// here it is a fixed cell in a grid over the decks, so the whole path
// from a deck's send to its return fits on one screen.
//
// The bank itself is deliberately absent from the grid: its jacks are
// drawn on the decks below, where the hand that patches them is.

import { LiveJack } from './Jack';
import type { NodeSnapshot } from '../engine';
import type { Manifest } from '../types';

export interface DecksRackProps {
  /** Rack modules to show — everything in the patch but the bank. */
  nodes: NodeSnapshot[];
  /** The module library, for the add control. */
  modules: Manifest[];
  onAdd(typeId: string): void;
  onRemove(instance: string): void;
  onJack(instance: string, jack: string, kind: 'input' | 'output'): void;
  isArmed(instance: string, jack: string, kind: 'input' | 'output'): boolean;
  isWired(instance: string, jack: string, kind: 'input' | 'output'): boolean;
}

export function DecksRack(props: DecksRackProps) {
  return (
    <section className="decks-rack" data-testid="decks-rack">
      <header className="decks-rack-head">
        <h2 className="decks-rack-title">Rack</h2>
        <span className="decks-rack-hint">
          click a jack, then its partner, to patch; a wired jack unpatches
        </span>
        <select
          className="decks-rack-add"
          data-testid="decks-rack-add"
          aria-label="Add a module to the rack"
          value=""
          onChange={(e) => {
            if (e.target.value) props.onAdd(e.target.value);
          }}
        >
          <option value="">add a module…</option>
          {props.modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </header>

      {props.nodes.length === 0 ? (
        <p className="decks-rack-empty" data-testid="decks-rack-empty">
          Nothing in the rack yet. Add a module, then wire a deck&apos;s audio out into it and its
          answer back into that deck&apos;s audio in.
        </p>
      ) : (
        <div className="decks-rack-grid" data-testid="decks-rack-grid">
          {props.nodes.map((node) => (
            <article
              className="decks-rack-module"
              key={node.instance_id}
              data-testid={`decks-rack-module-${node.instance_id}`}
            >
              <header className="decks-rack-module-head">
                <span className="decks-rack-module-name">
                  {node.display_name || node.instance_id}
                </span>
                <button
                  className="decks-rack-remove"
                  data-testid={`decks-rack-remove-${node.instance_id}`}
                  aria-label={`Remove ${node.display_name || node.instance_id} from the rack`}
                  onClick={() => props.onRemove(node.instance_id)}
                >
                  ✕
                </button>
              </header>
              <div className="decks-rack-jacks">
                <div className="decks-rack-ins">
                  {node.manifest.inputs.map((jack) => (
                    <LiveJack
                      key={jack.id}
                      instance={node.instance_id}
                      id={jack.id}
                      kind="input"
                      label={jack.name || jack.id}
                      display={jack.display}
                      knob={jack.knob}
                      wired={props.isWired(node.instance_id, jack.id, 'input')}
                      selected={props.isArmed(node.instance_id, jack.id, 'input')}
                      onClick={() => props.onJack(node.instance_id, jack.id, 'input')}
                    />
                  ))}
                </div>
                <div className="decks-rack-outs">
                  {node.manifest.outputs.map((jack) => (
                    <LiveJack
                      key={jack.id}
                      instance={node.instance_id}
                      id={jack.id}
                      kind="output"
                      label={jack.name || jack.id}
                      display={jack.display}
                      wired={props.isWired(node.instance_id, jack.id, 'output')}
                      selected={props.isArmed(node.instance_id, jack.id, 'output')}
                      onClick={() => props.onJack(node.instance_id, jack.id, 'output')}
                    />
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
