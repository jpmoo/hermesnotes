import { api } from "../api.ts";

export interface ReviewLink {
  t: "block" | "collection";
  id: string;
}
export interface ReviewStepView {
  id: string;
  description: string;
  link: ReviewLink | null;
  /** Resolved title of the linked block/collection (null for an outside step). */
  label: string | null;
  /** True if this step is part of the recurring template (vs this-review-only). */
  template: boolean;
  done: boolean;
}
export interface ReviewConfigured {
  configured: true;
  dueWeekday: number;
  availableDaysPrior: number;
  /** The task type's status field key and the value that marks it complete —
   *  so the client doesn't hardcode "status"/"done" (custom task types differ). */
  statusKey: string;
  doneValue: string;
  task: { id: string; status: string; done: boolean; available: string | null; due: string | null } | null;
  /** Whether the review is open now (its available date has arrived). */
  open: boolean;
  steps: ReviewStepView[];
  allDone: boolean;
  reflectionBlockId: string | null;
  reflectionTitle: string;
}
export type ReviewState = { configured: false } | ReviewConfigured;

export interface NewStep {
  description: string;
  link: ReviewLink | null;
  scope: "template" | "cycle";
}

export const reviewApi = {
  get: () => api.get<ReviewState>("/review"),
  config: (dueWeekday: number | null, availableDaysPrior: number, project?: string[]) =>
    api.put<ReviewState>("/review/config", { dueWeekday, availableDaysPrior, project }),
  addStep: (step: NewStep) => api.post<ReviewState>("/review/steps", step),
  editStep: (
    id: string,
    patch: { description?: string; link?: ReviewLink | null; scope?: "template" | "cycle" },
  ) => api.patch<ReviewState>(`/review/steps/${id}`, patch),
  removeStep: (id: string) => api.del<ReviewState>(`/review/steps/${id}`),
  reorder: (ids: string[]) => api.put<ReviewState>("/review/steps/order", { ids }),
  setDone: (id: string, done: boolean) => api.post<ReviewState>(`/review/steps/${id}/done`, { done }),
};

/** Weekday labels for the config UI (0=Sun … 6=Sat). */
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
