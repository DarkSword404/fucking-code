export interface PresenceUser {
  userId: string;
  displayName: string;
  lastSeen: number;
}

interface Entry extends PresenceUser {
  connections: number;
}

const projects = new Map<string, Map<string, Entry>>();

function projectMap(projectId: string): Map<string, Entry> {
  let map = projects.get(projectId);
  if (!map) {
    map = new Map();
    projects.set(projectId, map);
  }
  return map;
}

export function joinPresence(
  projectId: string,
  user: { id: string; displayName: string },
): void {
  const map = projectMap(projectId);
  const existing = map.get(user.id);
  if (existing) {
    existing.connections += 1;
    existing.lastSeen = Date.now();
    existing.displayName = user.displayName;
  } else {
    map.set(user.id, {
      userId: user.id,
      displayName: user.displayName,
      connections: 1,
      lastSeen: Date.now(),
    });
  }
}

export function touchPresence(projectId: string, userId: string): void {
  const entry = projects.get(projectId)?.get(userId);
  if (entry) entry.lastSeen = Date.now();
}

export function leavePresence(projectId: string, userId: string): void {
  const map = projects.get(projectId);
  if (!map) return;
  const existing = map.get(userId);
  if (!existing) return;
  existing.connections -= 1;
  existing.lastSeen = Date.now();
  if (existing.connections <= 0) map.delete(userId);
  if (!map.size) projects.delete(projectId);
}

export function listPresence(projectId: string): PresenceUser[] {
  const map = projects.get(projectId);
  if (!map) return [];
  const cutoff = Date.now() - 60_000;
  return [...map.values()]
    .filter((entry) => entry.lastSeen >= cutoff)
    .map(({ userId, displayName, lastSeen }) => ({ userId, displayName, lastSeen }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
