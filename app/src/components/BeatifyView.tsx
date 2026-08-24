// Beatify tab: a shelf of PROJECTS, and one of them open.
//
// A PROJECT IS A TEMPO AND THE MATERIAL BEATIFIED ONTO IT. It is started
// empty — "new project" asks for nothing but a name — and tracks are
// imported into it afterwards, each one proved in the import modal. The
// first import sets the project's BPM; every one after it is conformed to
// that BPM, which is what makes beats from two different records line up.
// The BPM box re-tempos the lot: seeds are re-rendered, clips are not
// touched, because a clip is a run of beats and a beat is a beat at any
// tempo.
//
// `beat_this` is optional (PyTorch): when it is missing the tab still
// works on the built-in DSP tracker and says so, with the install hint —
// the same contract as the YouTube provider without `yt-dlp`.

import { useCallback, useEffect, useState } from 'react';
import {
  MAX_PROJECT_BPM,
  MIN_PROJECT_BPM,
  type BeatifyClientApi,
  type BeatifyProject,
  type BeatifyProjectSummary,
  type BeatifySeed,
  type TrackerStatus,
} from '../beatify';
import type { BeatifyClipClientApi } from '../beatifyClip';
import type { LibraryClientApi, Track } from '../library';
import { BeatifyClipBuilder } from './BeatifyClipBuilder';
import { BeatifyModal } from './BeatifyModal';

const BUCKETS = 1400;

export interface BeatifyViewProps {
  client: BeatifyClientApi;
  library: LibraryClientApi;
  /** The clip builder's own commands (sources, assembly, saved clips). */
  clips: BeatifyClipClientApi;
}

/** What the modal is currently for: importing a track into a project, or
 *  re-beatifying a seed that is already in one (which keeps its id, and
 *  so keeps the clips that point at it). */
interface ModalFor {
  trackId: number;
  title: string;
  projectId: string;
  projectName: string;
  seedId: string;
}

export function BeatifyView({ client, library, clips }: BeatifyViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [projects, setProjects] = useState<BeatifyProjectSummary[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [tracker, setTracker] = useState<TrackerStatus | null>(null);
  const [open, setOpen] = useState<BeatifyProject | null>(null);
  const [modal, setModal] = useState<ModalFor | null>(null);
  const [warn, setWarn] = useState<ModalFor | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [list, saved] = await Promise.all([library.tracks(), client.projects()]);
      if (list) {
        setTracks(list);
        setPick((cur) => cur ?? list[0]?.id ?? null);
      }
      if (saved) setProjects(saved);
      setTracker(await client.trackerStatus());
    })();
  }, [client, library]);

  const refreshShelf = useCallback(async () => {
    const saved = await client.projects();
    if (saved) setProjects(saved);
  }, [client]);

  const openProject = useCallback(
    async (projectId: string) => {
      setBusy(true);
      setStatus(null);
      const project = await client.openProject(projectId, BUCKETS);
      setBusy(false);
      if (!project) {
        setStatus('That project could not be opened — its renders may have been deleted');
        return;
      }
      setOpen(project);
      setModal(null);
    },
    [client],
  );

  /** Start a project: a name and nothing else. Material comes later. */
  const newProject = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    const project = await client.newProject('');
    setBusy(false);
    if (!project) {
      setStatus('That project could not be created');
      return;
    }
    setOpen(project);
    setModal(null);
    void refreshShelf();
  }, [client, refreshShelf]);

  /** Import the picked library track into the open project. */
  const importSeed = useCallback(() => {
    if (pick === null || !open) return;
    const track = tracks.find((t) => t.id === pick);
    setStatus(null);
    setModal({
      trackId: pick,
      title: track?.title ?? `track ${pick}`,
      projectId: open.id,
      projectName: open.name,
      seedId: '',
    });
  }, [open, pick, tracks]);

  const committed = useCallback(
    (project: BeatifyProject) => {
      setOpen(project);
      setModal(null);
      const seed = project.seeds[project.seeds.length - 1];
      setStatus(
        seed
          ? `Imported "${seed.title}" — ${seed.record.grid.beats} beats at ${project.bpm?.toFixed(2) ?? '—'} BPM`
          : null,
      );
      void refreshShelf();
    },
    [refreshShelf],
  );

  /** Re-tempo everything in the project (§3.11). */
  const setBpm = useCallback(
    async (value: string) => {
      setBpmDraft(null);
      const bpm = Number(value);
      if (!open || !Number.isFinite(bpm)) return;
      if (bpm < MIN_PROJECT_BPM || bpm > MAX_PROJECT_BPM) {
        setStatus(`A project's tempo has to be between ${MIN_PROJECT_BPM} and ${MAX_PROJECT_BPM}`);
        return;
      }
      if (open.bpm !== null && Math.abs(open.bpm - bpm) < 0.005) return;
      setBusy(true);
      setStatus(`Re-rendering ${open.seeds.length} seed${open.seeds.length === 1 ? '' : 's'}…`);
      const project = await client.setProjectBpm(open.id, bpm, BUCKETS);
      setBusy(false);
      if (!project) {
        setStatus('That tempo could not be applied');
        return;
      }
      setOpen(project);
      setStatus(`Everything now runs at ${bpm.toFixed(2)} BPM — clips are unchanged`);
      void refreshShelf();
    },
    [client, open, refreshShelf],
  );

  const removeSeed = useCallback(
    async (seedId: string) => {
      if (!open) return;
      setBusy(true);
      const project = await client.deleteSeed(open.id, seedId, BUCKETS);
      setBusy(false);
      if (!project) return;
      setOpen(project);
      void refreshShelf();
    },
    [client, open, refreshShelf],
  );

  const rename = useCallback(async () => {
    if (!renaming) return;
    const saved = await client.renameProject(renaming.id, renaming.name);
    setRenaming(null);
    if (!saved) return;
    setProjects(saved);
    setOpen((cur) => (cur && cur.id === renaming.id ? { ...cur, name: renaming.name } : cur));
  }, [client, renaming]);

  const remove = useCallback(
    async (project: BeatifyProjectSummary) => {
      const saved = await client.deleteProject(project.id);
      if (!saved) return;
      setProjects(saved);
      setOpen((cur) => (cur && cur.id === project.id ? null : cur));
      setStatus(`Deleted "${project.name}"`);
    },
    [client],
  );

  const bpmValue =
    bpmDraft ??
    (open?.bpm !== null && open?.bpm !== undefined ? String(Math.round(open.bpm * 100) / 100) : '');

  return (
    <section className="beatify-view" data-testid="beatify-view">
      <div className="beatify-bar">
        {open ? (
          <>
            <span className="beatify-open-name" data-testid="beatify-open-project">
              {open.name}
            </span>
            <label>
              <span>BPM</span>
              <input
                className="beatify-bpm"
                data-testid="beatify-project-bpm"
                type="number"
                step="0.01"
                min={MIN_PROJECT_BPM}
                max={MAX_PROJECT_BPM}
                disabled={busy || open.seeds.length === 0}
                title={
                  open.seeds.length === 0
                    ? 'The first track imported sets the tempo'
                    : 'Re-render every seed at this tempo. Clips are unaffected.'
                }
                placeholder="—"
                value={bpmValue}
                onChange={(e) => setBpmDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void setBpm((e.target as HTMLInputElement).value);
                  if (e.key === 'Escape') setBpmDraft(null);
                }}
                onBlur={(e) => void setBpm(e.target.value)}
              />
            </label>
            <label>
              <span>Import</span>
              <select
                data-testid="beatify-track-select"
                value={pick ?? ''}
                onChange={(e) => setPick(Number(e.target.value))}
              >
                {tracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} — {t.artist}
                  </option>
                ))}
              </select>
            </label>
            <button
              data-testid="beatify-import-track"
              disabled={pick === null || busy}
              onClick={importSeed}
            >
              + Import track
            </button>
            <button data-testid="beatify-close-project" onClick={() => setOpen(null)}>
              Close
            </button>
          </>
        ) : (
          <button
            data-testid="beatify-new-project"
            disabled={busy}
            onClick={() => void newProject()}
          >
            + New project
          </button>
        )}
        {tracker && (
          <span
            className={tracker.beatThis ? 'beatify-tracker' : 'beatify-tracker fallback'}
            data-testid="beatify-tracker-status"
            title={tracker.beatThis ? tracker.python : tracker.detail}
          >
            {tracker.beatThis
              ? `tracker ${tracker.tracker} · ${tracker.device}`
              : `beat_this not installed — using the built-in DSP tracker. ${tracker.installHint}`}
          </span>
        )}
      </div>
      {status && (
        <p className="beatify-status" data-testid="beatify-status">
          {status}
        </p>
      )}

      {!open && (
        <div className="beatify-projects" data-testid="beatify-projects">
          {projects.length === 0 && (
            <p className="beatify-empty">
              No projects yet. A project is a tempo and the tracks beatified onto it: start one,
              import a track to set its BPM, then import as many more as you like — they are
              conformed to that BPM, so beats from any of them line up. Beats only: no bars, no
              meter, no time signature.
            </p>
          )}
          {projects.map((project) => (
            <div
              className="beatify-project"
              key={project.id}
              data-testid={`beatify-project-${project.id}`}
            >
              {renaming?.id === project.id ? (
                <input
                  autoFocus
                  data-testid="beatify-project-rename-input"
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: project.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void rename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => void rename()}
                />
              ) : (
                <button
                  className="beatify-project-open"
                  data-testid={`beatify-project-open-${project.id}`}
                  disabled={busy}
                  onClick={() => void openProject(project.id)}
                >
                  <span className="beatify-project-name">{project.name}</span>
                  <span className="beatify-project-facts">
                    {project.bpm === null
                      ? 'empty — no tempo yet'
                      : `${project.bpm.toFixed(2)} BPM · ${project.seeds.length} seed${
                          project.seeds.length === 1 ? '' : 's'
                        }`}
                    {project.seeds.length > 0 && ` · ${project.seeds.join(', ')}`}
                  </span>
                </button>
              )}
              <button
                className="beatify-project-edit"
                data-testid={`beatify-project-rename-${project.id}`}
                title="Rename this project"
                onClick={() => setRenaming({ id: project.id, name: project.name })}
              >
                ✎
              </button>
              <button
                className="beatify-project-edit"
                data-testid={`beatify-project-delete-${project.id}`}
                title="Delete this project, its seeds, its renders and its clips"
                onClick={() => void remove(project)}
              >
                ×
              </button>
              {project.sourceMissing && (
                <span className="beatify-project-warn" data-testid="beatify-project-source-missing">
                  a source track is missing — stems and re-beatify need it back
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <BeatifyClipBuilder
          key={`${open.id}:${open.seeds.map((s) => `${s.id}@${s.record.grid.bpm}`).join(',')}`}
          project={open}
          clips={clips}
          onImport={importSeed}
          onRemoveSeed={(seedId) => void removeSeed(seedId)}
          onRebeatify={(seed: BeatifySeed) =>
            setWarn({
              trackId: seed.trackId,
              title: seed.title,
              projectId: open.id,
              projectName: open.name,
              seedId: seed.id,
            })
          }
        />
      )}

      {warn && (
        <div className="beatify-modal-backdrop" data-testid="beatify-rebeatify-warning">
          <div className="beatify-warn">
            <p>
              Re-beatifying re-renders this seed. Anything already cut from its old grid — including
              its boundaries — stops matching. To keep both, import the track again as a second seed
              instead.
            </p>
            <button data-testid="beatify-rebeatify-cancel" onClick={() => setWarn(null)}>
              Cancel
            </button>
            <button
              data-testid="beatify-rebeatify-confirm"
              onClick={() => {
                setModal(warn);
                setWarn(null);
              }}
            >
              Re-beatify
            </button>
          </div>
        </div>
      )}

      {modal && (
        <BeatifyModal
          client={client}
          trackId={modal.trackId}
          title={modal.title}
          projectId={modal.projectId}
          seedId={modal.seedId}
          projectName={modal.projectName}
          // A project's tempo is the project's: an import is conformed to
          // it, and so is a re-beatify. The BPM box is the only thing that
          // changes it (§3.11), so re-rendering one seed can never move
          // the grid the others — and the clips — are sitting on.
          projectBpm={open?.bpm ?? null}
          onCommitted={committed}
          onCancel={() => setModal(null)}
        />
      )}
    </section>
  );
}
