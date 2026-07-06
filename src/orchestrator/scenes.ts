import type { StoryStore } from '../db/stores/storyStore.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { EventBus } from '../util/events.ts';
import type { Scene } from '../domain.ts';

export interface SceneDeps {
  stories: StoryStore;
  jobs: JobStore;
  events: EventBus;
}

/**
 * Close the current scene and open a new one. Enqueues a scribe_story 'digest'
 * job to fold the closing scene's summary into the story digest (async, off the
 * player path). Used by the manual "new scene" control (Layer 2) and by the
 * storyteller `scene_break` directive.
 */
export function breakScene(deps: SceneDeps, storyId: string, opts: { title?: string; carryNpcs?: string[] } = {}): Scene | undefined {
  const story = deps.stories.getStory(storyId);
  if (!story) return undefined;

  const closingSceneId = story.currentSceneId;
  if (closingSceneId) {
    deps.stories.closeScene(closingSceneId);
    deps.jobs.enqueue('scribe_story', { storyId, payload: { mode: 'digest', sceneId: closingSceneId } });
  }

  const scene = deps.stories.openScene(storyId, { title: opts.title, activeNpcIds: opts.carryNpcs ?? [] });
  deps.events.emit({ t: 'scene.changed', storyId, sceneId: scene.id });
  return scene;
}
