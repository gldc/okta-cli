import type { components } from "./schema";

export type Schema<K extends keyof components["schemas"]> = components["schemas"][K];
