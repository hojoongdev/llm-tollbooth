// Single-tenant until P6: everything reads the one "default" project.
export const PROJECT = process.env.PROJECT_ID || "default";
