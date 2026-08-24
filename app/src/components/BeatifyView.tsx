// Beatify tab: a shelf of PROJECTS, and one of them open.
//
// A project is one beatified take on one source track — its grid, its
// render, its clips — and a track can have as many as the user likes. So
// the tab's front door is the project list, not the library: "new
// project" picks a track and proves its grid in the import modal, and
// opening a project picks up where it was left.
//
// `beat_this` is optional (PyTorch): when it is missing the tab still
// works on the built-in DSP tracker and says so, with the install hint —
// the same contract as the YouTube provider without `yt-dlp`.

import { useCallback, useEffect, useState } from 'react';
import type { BeatifyClientApi, BeatifyProject, BeatifyTrack, TrackerStatus } from '../beatify';
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

/** What the modal is currently for: a brand-new project, or re-beatifying
 *  one that exists (which keeps its id, its name and its clips). */
interface ModalFor {
  trackId: number;
  title: string;
  projectId: string;
  projectName: string;
}

export function BeatifyView({ client, library, clips }: BeatifyViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [projects, setProjects] = useState<BeatifyProject[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [tracker, setTracker] = useState<TrackerStatus | null>(null);
  const [open, setOpen] = useState<BeatifyTrack | null>(null);
  const [modal, setModal] = useState<ModalFor | null>(null);
  const [warn, setWarn] = useState<ModalFor | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
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

  const openProject = useCallback(
    async (projectId: string) => {
      setBusy(true);
      setStatus(null);
      const project = await client.openProject(projectId, BUCKETS);
      setBusy(false);
      if (!project) {
        setStatus('That project could not be opened — its render may have been deleted');
        return;
      }
      setOpen(project);
      setModal(null);
    },
    [client],
  );

  /** Start a project: beatify the picked track into a new one. */
  const newProject = useCallback(() => {
    if (pick === null) return;
    const track = tracks.find((t) => t.id === pick);
    setStatus(null);
    setOpen(null);
    setModal({
      trackId: pick,
      title: track?.title ?? `track ${pick}`,
      projectId: '',
      projectName: track?.title ?? '',
    });
  }, [pick, tracks]);

  const committed = useCallback(
    async (track: BeatifyTrack) => {
      setOpen(track);
      setModal(null);
      setStatus(
        `Beatified "${track.projectName}" — ${track.record.grid.beats} beats at ${track.record.grid.bpm.toFixed(2)} BPM`,
      );
      const saved = await client.projects();
      if (saved) setProjects(saved);
    },
    [client],
  );

  const rename = useCallback(async () => {
    if (!renaming) return;
    const saved = await client.renameProject(renaming.id, renaming.name);
    setRenaming(null);
    if (!saved) return;
    setProjects(saved);
    setOpen((cur) =>
      cur && cur.projectId === renaming.id ? { ...cur, projectName: renaming.name } : cur,
    );
  }, [client, renaming]);

  const remove = useCallback(
    async (project: BeatifyProject) => {
      const saved = await client.deleteProject(project.id);
      if (!saved) return;
      setProjects(saved);
      setOpen((cur) => (cur && cur.projectId === project.id ? null : cur));
      setStatus(`Deleted "${project.name}"`);
    },
    [client],
  );

  return (
    <section className="beatify-view" data-testid="beatify-view">
      <div className="beatify-bar">
        <label>
          <span>Source</span>
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
          data-testid="beatify-new-project"
          disabled={pick === null || busy}
          onClick={newProject}
        >
          + New project
        </button>
        {open && (
          <>
            <span className="beatify-open-name" data-testid="beatify-open-project">
              {open.projectName}
            </span>
            <button data-testid="beatify-close-project" onClick={() => setOpen(null)}>
              Close
            </button>
          </>
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
              No projects yet. Pick a source track and start one: Beatify detects its beats, fits a
              grid and renders it at constant tempo — beats only: no bars, no meter, no time
              signature. The same track can carry as many projects as you like.
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
                    {project.title}
                    {project.artist && ` — ${project.artist}`} · {project.bpm.toFixed(2)} BPM ·{' '}
                    {project.beats} beats
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
                title="Delete this project, its clips and its render"
                onClick={() => void remove(project)}
              >
                ×
              </button>
              {project.sourceMissing && (
                <span className="beatify-project-warn" data-testid="beatify-project-source-missing">
                  source track missing — stems and re-beatify need it back
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <BeatifyClipBuilder
          key={`${open.projectId}:${open.record.warped}`}
          track={open}
          clips={clips}
          onRebeatify={() =>
            setWarn({
              trackId: open.trackId,
              title: open.title,
              projectId: open.projectId,
              projectName: open.projectName,
            })
          }
        />
      )}

      {warn && (
        <div className="beatify-modal-backdrop" data-testid="beatify-rebeatify-warning">
          <div className="beatify-warn">
            <p>
              Re-beatifying re-renders this project. Anything already cut from the old grid —
              including its boundaries — stops matching. To keep both, start a new project from the
              same track instead.
            </p>
            <button data-testid="beatify-rebeatify-cancel" onClick={() => setWarn(null)}>
              Cancel
            </button>
            <button
              data-testid="beatify-rebeatify-confirm"
              onClick={() => {
                setModal(warn);
                setOpen(null);
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
          projectName={modal.projectName}
          onCommitted={(track) => void committed(track)}
          onCancel={() => setModal(null)}
        />
      )}
    </section>
  );
}
