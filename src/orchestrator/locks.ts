// Per-story mutex: one turn at a time per story; different stories run concurrently.
export class StoryLocks {
  private chains = new Map<string, Promise<unknown>>();

  withStory<T>(storyId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(storyId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of prior outcome
    // Keep the chain alive but swallow errors on the stored tail.
    this.chains.set(
      storyId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  isBusy(storyId: string): boolean {
    return this.chains.has(storyId);
  }
}
