declare module "*.sqlite" {
  const db: import("bun:sqlite").Database;
  export default db;
}
