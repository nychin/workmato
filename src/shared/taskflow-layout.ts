import type { TaskCard, TaskEdge } from './taskflow';

export interface InsertedCardRoom {
  shift: number;
  movedCardIds: string[];
}

/** Keep the inserted card and the target branch at the canvas' standard horizontal spacing. */
export function makeRoomForInsertedCard(
  cards: TaskCard[],
  edges: TaskEdge[],
  insertedCard: TaskCard,
  replacedEdge: TaskEdge,
  horizontalStep = 360,
): InsertedCardRoom {
  const source = cards.find((card) => card.id === replacedEdge.sourceId);
  const target = cards.find((card) => card.id === replacedEdge.targetId);
  if (!source || !target || target.x < source.x) return { shift: 0, movedCardIds: [] };

  insertedCard.x = Math.max(insertedCard.x, source.x + horizontalStep);
  const shift = insertedCard.x + horizontalStep - target.x;
  if (shift <= 0) return { shift: 0, movedCardIds: [] };

  const downstreamIds = new Set<string>([target.id]);
  let added = true;
  while (added) {
    added = false;
    for (const edge of edges) {
      if (!downstreamIds.has(edge.sourceId) || downstreamIds.has(edge.targetId)) continue;
      downstreamIds.add(edge.targetId);
      added = true;
    }
  }

  const movedCardIds: string[] = [];
  for (const card of cards) {
    if (downstreamIds.has(card.id) || (card.parentId && downstreamIds.has(card.parentId))) {
      card.x += shift;
      movedCardIds.push(card.id);
    }
  }
  return { shift, movedCardIds };
}
