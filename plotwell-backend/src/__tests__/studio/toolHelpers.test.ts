import {
  createPendingToolApprovalStore,
  getEpisodeUpsertMode,
  requiresToolApproval,
  toApprovedToolSet,
} from '../../routes/studio/toolHelpers';

describe('studio tool approval helpers', () => {
  it('requires approval for destructive tools that are not approved', () => {
    const required = new Set(['delete_episode', 'delete_document']);
    const approved = toApprovedToolSet([]);

    expect(requiresToolApproval(required, 'delete_episode', approved)).toBe(true);
  });

  it('skips approval when the tool was approved for the session or always', () => {
    const required = new Set(['delete_episode', 'delete_document']);
    const approved = toApprovedToolSet(['delete_episode']);

    expect(requiresToolApproval(required, 'delete_episode', approved)).toBe(false);
  });

  it('does not require approval for tools outside the destructive set', () => {
    const required = new Set(['delete_episode']);
    const approved = toApprovedToolSet([]);

    expect(requiresToolApproval(required, 'create_episode', approved)).toBe(false);
  });

  it('stores, takes, and denies pending approvals by owner', () => {
    const store = createPendingToolApprovalStore();
    store.set('approval-1', {
      userId: 'user-1',
      projectId: 'project-1',
      toolName: 'delete_episode',
      args: { episode_id: 'episode-1' },
      createdAt: 1,
    });

    expect(store.get('approval-1')?.toolName).toBe('delete_episode');
    expect(store.deny('approval-1', 'other-user')).toBe(false);
    expect(store.take('approval-1')?.args).toEqual({ episode_id: 'episode-1' });
    expect(store.get('approval-1')).toBeUndefined();
  });
});

describe('series episode upsert helper', () => {
  it('creates when no episode exists at the requested season/episode number', () => {
    expect(getEpisodeUpsertMode(null)).toBe('create');
  });

  it('updates when an episode already exists at the requested season/episode number', () => {
    expect(getEpisodeUpsertMode({ id: 'episode-1' })).toBe('update');
  });
});
