import type { Plan, Task } from "./types.js";
import { nanoid } from "nanoid";

export interface RoomTemplate {
  id: string;
  name: string;
  description: string;
  project: string;
  tasks: Array<Pick<Task, "title" | "description" | "depends_on" | "priority">>;
}

export const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "Empty plan — start from scratch.",
    project: "Untitled",
    tasks: [],
  },
  {
    id: "web-app",
    name: "Web app",
    description: "Scaffold for a small full-stack feature.",
    project: "Web app",
    tasks: [
      {
        title: "Define API contract",
        description: "Write the shared api_contract context entry.",
        depends_on: [],
        priority: 1,
      },
      {
        title: "Implement backend",
        description: "Ship the endpoints in the contract.",
        depends_on: [],
        priority: 2,
      },
      {
        title: "Wire frontend",
        description: "Call the API and handle errors.",
        depends_on: [],
        priority: 3,
      },
      {
        title: "Add tests",
        description: "Cover the happy path and auth failures.",
        depends_on: [],
        priority: 4,
      },
    ],
  },
  {
    id: "incident",
    name: "Incident response",
    description: "Coordinate a production incident.",
    project: "Incident",
    tasks: [
      {
        title: "Triage and severity",
        description: "Confirm blast radius and severity.",
        depends_on: [],
        priority: 1,
      },
      {
        title: "Mitigate",
        description: "Apply hotfix or rollback.",
        depends_on: [],
        priority: 2,
      },
      {
        title: "Write postmortem notes",
        description: "Capture timeline and follow-ups as context.",
        depends_on: [],
        priority: 3,
      },
    ],
  },
];

export function getTemplate(id: string): RoomTemplate | undefined {
  return ROOM_TEMPLATES.find((t) => t.id === id);
}

export function planFromTemplate(template: RoomTemplate, roomId: string): Plan {
  const now = new Date().toISOString();
  const idByIndex = template.tasks.map(() => nanoid());
  const tasks: Task[] = template.tasks.map((t, i) => ({
    id: idByIndex[i]!,
    title: t.title,
    description: t.description,
    status: "pending" as const,
    owner: null,
    created_at: now,
    updated_at: now,
    depends_on: t.depends_on.map((dep) => {
      // allow numeric index refs in templates as "0", "1"...
      const idx = Number(dep);
      if (Number.isInteger(idx) && idByIndex[idx]) return idByIndex[idx]!;
      return dep;
    }),
    priority: t.priority,
  }));

  // Wire sequential depends for web-app / incident when depends_on empty:
  // leave as declared; templates above leave empty for parallel start.

  return {
    project: template.project || roomId,
    created_at: now,
    updated_at: now,
    tasks,
  };
}
