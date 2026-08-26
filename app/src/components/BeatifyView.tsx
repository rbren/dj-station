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

export function BeatifyView({ client, library, clips }: BeatifyViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [projects, setProjects] = useState<BeatifyProjectSummary[]>([]);
  const [tracker, setTracker] = useState<TrackerStatus | null>(null);
  const [open, setOpen] = useState<BeatifyProject | null>(null);
  /** Is the import modal up? WHICH track it is for is the modal's own
   *  business now, so this is a yes or a no. */
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<BeatifyProjectSummary | null>(null);
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  /** The open project's name, while it is being typed. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [list, saved] = await Promise.all([library.tracks(), client.projects()]);
      if (list) setTracks(list);
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
      setNameDraft(null);
      const project = await client.openProject(projectId, BUCKETS);
      setBusy(false);
      // A failed command has already said so, in the banner and in the
      // console (`ipc.ts`): saying it again here is the same news twice.
      if (!project) return;
      setOpen(project);
      setImporting(false);
    },
    [client],
  );

  /** Start a project: a name and nothing else. Material comes later. */
  const newProject = useCallback(async () => {
    setBusy(true);
    const project = await client.newProject('');
    setBusy(false);
    if (!project) return;
    setOpen(project);
    setImporting(false);
    // A project is a place to work in, so it is named at birth rather
    // than inheriting whatever gets imported into it first: the name it
    // came with is already in the box, selected, waiting to be typed
    // over. Ignore it and the default stands.
    setNameDraft(project.name);
    void refreshShelf();
  }, [client, refreshShelf]);

  /** Put up the import modal. The track is chosen in there (MOD-A0). */
  const importSeed = useCallback(() => setImporting(true), []);

  // No "imported X" banner: the seed appears in the list with its beats
  // and its speed on it, which is the same news said by the thing itself.
  const committed = useCallback(
    (project: BeatifyProject) => {
      setOpen(project);
      setImporting(false);
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
      // Out of range is refused by the box itself: the draft is already
      // dropped, so it springs back to the tempo the project still has,
      // which is the answer. Its min/max say what the range is.
      if (bpm < MIN_PROJECT_BPM || bpm > MAX_PROJECT_BPM) return;
      if (open.bpm !== null && Math.abs(open.bpm - bpm) < 0.005) return;
      setBusy(true);
      const project = await client.setProjectBpm(open.id, bpm, BUCKETS);
      setBusy(false);
      if (!project) return;
      setOpen(project);
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

  /** Write a project's name down. One path for both boxes — the shelf's
   *  pencil and the open project's own header — because they are two
   *  views of the same label. */
  const renameTo = useCallback(
    async (projectId: string, asked: string) => {
      const name = asked.trim();
      // A nameless project cannot be told from its neighbour on the
      // shelf, so an emptied box is an abandoned edit, not a rename.
      if (!name) return;
      const saved = await client.renameProject(projectId, name);
      if (!saved) return;
      setProjects(saved);
      setOpen((cur) => (cur && cur.id === projectId ? { ...cur, name } : cur));
    },
    [client],
  );

  const rename = useCallback(async () => {
    if (!renaming) return;
    const { id, name } = renaming;
    setRenaming(null);
    await renameTo(id, name);
  }, [renaming, renameTo]);

  /** Commit what was typed into the open project's header. */
  const commitName = useCallback(async () => {
    const asked = nameDraft?.trim() ?? '';
    setNameDraft(null);
    if (!open || asked === open.name) return;
    await renameTo(open.id, asked);
  }, [nameDraft, open, renameTo]);

  const remove = useCallback(
    async (project: BeatifyProjectSummary) => {
      const saved = await client.deleteProject(project.id);
      if (!saved) return;
      setProjects(saved);
      setOpen((cur) => (cur && cur.id === project.id ? null : cur));
    },
    [client],
  );

  const bpmValue =
    bpmDraft ??
    (open?.bpm !== null && open?.bpm !== undefined ? String(Math.round(open.bpm * 100) / 100) : '');

  return (
    <section className="beatify-view" data-testid="beatify-view">
      {/* While the import modal is up it owns the page: the bar is
          unreachable (`inert`), the builder below is suspended, and the
          keyboard belongs to the modal alone. */}
      <div className="beatify-bar" inert={importing}>
        {open ? (
          <>
            {nameDraft === null ? (
              <button
                className="beatify-open-name"
                data-testid="beatify-open-project"
                title="Rename this project"
                onClick={() => setNameDraft(open.name)}
              >
                {open.name}
              </button>
            ) : (
              <input
                autoFocus
                className="beatify-open-name-input"
                data-testid="beatify-project-name-input"
                aria-label="Project name"
                value={nameDraft}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitName();
                  if (e.key === 'Escape') setNameDraft(null);
                }}
                onBlur={() => void commitName()}
              />
            )}
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
            <button data-testid="beatify-import-track" disabled={busy} onClick={importSeed}>
              + Import track
            </button>
            <button
              data-testid="beatify-close-project"
              onClick={() => {
                setNameDraft(null);
                setOpen(null);
              }}
            >
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
      {!open && (
        <div className="beatify-projects" data-testid="beatify-projects" inert={importing}>
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
                onClick={() => setDeleting(project)}
              >
                ×
              </button>
              {project.sourceMissing && (
                <span className="beatify-project-warn" data-testid="beatify-project-source-missing">
                  a source track is missing — stems need it back
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <BeatifyClipBuilder
          // Keyed by the PROJECT and nothing else. Everything else about
          // it — the tempo, a seed imported, a seed re-beatified — is a
          // change the builder takes as a prop and fetches around,
          // because a remount takes the half-built clip with it.
          key={open.id}
          project={open}
          clips={clips}
          onImport={importSeed}
          onRemoveSeed={(seedId) => void removeSeed(seedId)}
          // A modal owns the keyboard and the speakers while it is up.
          suspended={importing}
        />
      )}

      {deleting && (
        <div className="beatify-modal-backdrop" data-testid="beatify-delete-warning">
          <div className="beatify-warn">
            <p>
              Deleting “{deleting.name}” removes the project, its seeds, its renders and its clips.
              The library tracks it was built from stay put; everything else is gone for good.
            </p>
            <button data-testid="beatify-delete-cancel" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              data-testid="beatify-delete-confirm"
              onClick={() => {
                const project = deleting;
                setDeleting(null);
                void remove(project);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {importing && open && (
        <BeatifyModal
          client={client}
          tracks={tracks}
          projectId={open.id}
          projectName={open.name}
          // A project's tempo is the project's: an import is conformed to
          // it, and so is a re-beatify. The BPM box is the only thing that
          // changes it (§3.11), so re-rendering one seed can never move
          // the grid the others — and the clips — are sitting on.
          projectBpm={open?.bpm ?? null}
          onCommitted={committed}
          onCancel={() => setImporting(false)}
        />
      )}
    </section>
  );
}
