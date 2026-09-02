import type { TaskCard, TaskEdge, TaskFlowData, TaskProject } from '../../shared/taskflow';

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function createProject(title: string): TaskProject {
  const timestamp = now();
  return {
    id: createId('project'),
    title,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createCard(projectId: string, x: number, y: number, title = '新任务'): TaskCard {
  const timestamp = now();
  return {
    id: createId('card'),
    projectId,
    title,
    markdown: '- [ ] ',
    x,
    y,
    collapsed: false,
    completed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createEdge(projectId: string, sourceId: string, targetId: string): TaskEdge {
  return {
    id: createId('edge'),
    projectId,
    sourceId,
    targetId,
    createdAt: now(),
  };
}

export function getProjectCards(data: TaskFlowData, projectId: string): TaskCard[] {
  return data.cards.filter((card) => card.projectId === projectId);
}

export function getProjectEdges(data: TaskFlowData, projectId: string): TaskEdge[] {
  return data.edges.filter((edge) => edge.projectId === projectId);
}

/** 删除中间卡片时，将所有前置卡片与所有后续卡片直接重连。 */
export function removeCardsAndReconnect(data: TaskFlowData, cardIds: Set<string>): TaskFlowData {
  const edgesToRemove = data.edges.filter((edge) => cardIds.has(edge.sourceId) || cardIds.has(edge.targetId));
  const newEdges = [...data.edges.filter((edge) => !cardIds.has(edge.sourceId) && !cardIds.has(edge.targetId))];

  for (const removedId of cardIds) {
    const incoming = edgesToRemove.filter((edge) => edge.targetId === removedId && !cardIds.has(edge.sourceId));
    const outgoing = edgesToRemove.filter((edge) => edge.sourceId === removedId && !cardIds.has(edge.targetId));

    for (const before of incoming) {
      for (const after of outgoing) {
        if (before.sourceId === after.targetId) continue;
        const duplicate = newEdges.some((edge) => edge.sourceId === before.sourceId && edge.targetId === after.targetId);
        if (!duplicate) newEdges.push(createEdge(before.projectId, before.sourceId, after.targetId));
      }
    }
  }

  return {
    ...data,
    cards: data.cards.filter((card) => !cardIds.has(card.id)),
    edges: newEdges,
    pinnedCardId: data.pinnedCardId && cardIds.has(data.pinnedCardId) ? null : data.pinnedCardId,
  };
}
