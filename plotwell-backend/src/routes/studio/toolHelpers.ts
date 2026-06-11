export interface PendingToolApproval {
  userId: string;
  projectId: string;
  episodeId?: string | null;
  toolName: string;
  args: Record<string, any>;
  createdAt: number;
}

export function createToolApprovalId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function toApprovedToolSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0));
}

export function requiresToolApproval(
  approvalRequiredTools: Set<string>,
  toolName: string,
  approvedTools: Set<string>
): boolean {
  return approvalRequiredTools.has(toolName) && !approvedTools.has(toolName);
}

export function getEpisodeUpsertMode(existingEpisode?: { id?: string } | null): 'create' | 'update' {
  return existingEpisode?.id ? 'update' : 'create';
}

export function createPendingToolApprovalStore() {
  const approvals = new Map<string, PendingToolApproval>();

  return {
    set(id: string, approval: PendingToolApproval) {
      approvals.set(id, approval);
    },
    get(id: string): PendingToolApproval | undefined {
      return approvals.get(id);
    },
    take(id: string): PendingToolApproval | undefined {
      const approval = approvals.get(id);
      if (approval) approvals.delete(id);
      return approval;
    },
    deny(id: string, userId: string): boolean {
      const approval = approvals.get(id);
      if (!approval || approval.userId !== userId) return false;
      approvals.delete(id);
      return true;
    },
    clear() {
      approvals.clear();
    },
  };
}
